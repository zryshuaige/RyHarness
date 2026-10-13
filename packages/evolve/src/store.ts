/**
 * 进化存储层：playbook 条目、反思、反馈事件。
 * @module @ryagent/evolve/store
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { EntryStatus, PlaybookSection, ReflectionStatus } from './schema.ts'
import { migrateEvolve } from './schema.ts'

export interface PlaybookEntry {
  id: string
  agentId: string
  section: PlaybookSection
  content: string
  helpful: number
  harmful: number
  status: EntryStatus
  createdAt: number
  updatedAt: number
  source: 'curator' | 'reflection' | 'seed' | 'manual'
}

export interface ReflectionRow {
  id: string
  agentId: string
  lesson: string
  contextDigest: string
  sourceConversationId?: string
  hitCount: number
  status: ReflectionStatus
  createdAt: number
  updatedAt: number
}

function toEntry(row: Record<string, unknown>): PlaybookEntry {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    section: String(row.section) as PlaybookSection,
    content: String(row.content),
    helpful: Number(row.helpful),
    harmful: Number(row.harmful),
    status: String(row.status) as EntryStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    source: String(row.source) as PlaybookEntry['source'],
  }
}

function toReflection(row: Record<string, unknown>): ReflectionRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    lesson: String(row.lesson),
    contextDigest: String(row.context_digest),
    ...(row.source_conversation_id === null || row.source_conversation_id === undefined
      ? {}
      : { sourceConversationId: String(row.source_conversation_id) }),
    hitCount: Number(row.hit_count),
    status: String(row.status) as ReflectionStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 进化存储。 */
export class EvolveStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    migrateEvolve(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ---- playbook ----

  insertEntry(input: {
    agentId: string
    section: PlaybookSection
    content: string
    source?: PlaybookEntry['source']
  }): PlaybookEntry {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(`
      INSERT INTO playbook_entries (id, agent_id, section, content, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(id, input.agentId, input.section, input.content, input.source ?? 'curator', now, now)
    return this.getEntry(id)!
  }

  getEntry(id: string): PlaybookEntry | undefined {
    const row = this.db.prepare('SELECT * FROM playbook_entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : toEntry(row)
  }

  updateEntryContent(id: string, content: string): void {
    this.db.prepare('UPDATE playbook_entries SET content = ?, updated_at = ? WHERE id = ?').run(content, Date.now(), id)
  }

  setEntryStatus(id: string, status: EntryStatus): void {
    this.db.prepare('UPDATE playbook_entries SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
  }

  /** 同 section 下是否已有内容完全相同的 active 条目（去重）。 */
  hasDuplicate(agentId: string, section: PlaybookSection, content: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM playbook_entries WHERE agent_id = ? AND section = ? AND content = ? AND status = 'active'",
      )
      .get(agentId, section, content) as { count: number }
    return Number(row.count) > 0
  }

  addCounts(id: string, delta: { helpful?: number; harmful?: number }): void {
    this.db
      .prepare('UPDATE playbook_entries SET helpful = helpful + ?, harmful = harmful + ?, updated_at = ? WHERE id = ?')
      .run(delta.helpful ?? 0, delta.harmful ?? 0, Date.now(), id)
  }

  /** 某 agent 的全部条目（含 deprecated，UI 展示用）。 */
  listEntries(agentId: string, limit = 300): PlaybookEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM playbook_entries WHERE agent_id = ? ORDER BY section, helpful - harmful DESC LIMIT ?')
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(toEntry)
  }

  /** 编译注入用：active 条目，按 section 分组、组内 (helpful - harmful) 降序。 */
  listActiveForCompile(agentId: string): PlaybookEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM playbook_entries WHERE agent_id = ? AND status = 'active' ORDER BY section, (helpful - harmful) DESC, updated_at DESC",
      )
      .all(agentId) as Record<string, unknown>[]
    return rows.map(toEntry)
  }

  countActive(agentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM playbook_entries WHERE agent_id = ? AND status = 'active'")
      .get(agentId) as { count: number }
    return Number(row.count)
  }

  // ---- reflections ----

  insertReflection(input: {
    agentId: string
    lesson: string
    contextDigest?: string
    sourceConversationId?: string
  }): ReflectionRow {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(`
      INSERT INTO reflections (id, agent_id, lesson, context_digest, source_conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(id, input.agentId, input.lesson, input.contextDigest ?? '', input.sourceConversationId ?? null, now, now)
    return this.getReflection(id)!
  }

  getReflection(id: string): ReflectionRow | undefined {
    const row = this.db.prepare('SELECT * FROM reflections WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toReflection(row)
  }

  bumpReflectionHit(id: string): void {
    this.db.prepare('UPDATE reflections SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  setReflectionStatus(id: string, status: ReflectionStatus): void {
    this.db.prepare('UPDATE reflections SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
  }

  /** 待验证的最近教训（注入用）。 */
  listPendingReflections(agentId: string, limit = 3): ReflectionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reflections WHERE agent_id = ? AND status = 'pending' ORDER BY updated_at DESC LIMIT ?")
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(toReflection)
  }

  /** 到期清理：pending 且超过 maxAgeMs 未转正 → expired。返回处理条数。 */
  expireReflections(maxAgeMs: number, now = Date.now()): number {
    const result = this.db
      .prepare("UPDATE reflections SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?")
      .run(now, now - maxAgeMs)
    return Number(result.changes)
  }

  listReflections(agentId: string, limit = 50): ReflectionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM reflections WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(toReflection)
  }

  // ---- feedback ----

  recordFeedback(input: {
    agentId: string
    conversationId: string
    turnIndex: number
    signal: 'thumb_up' | 'thumb_down'
  }): void {
    this.db
      .prepare(
        'INSERT INTO feedback_events (id, agent_id, conversation_id, turn_index, signal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), input.agentId, input.conversationId, input.turnIndex, input.signal, Date.now())
  }

  countFeedback(agentId: string): { up: number; down: number } {
    const rows = this.db
      .prepare('SELECT signal, COUNT(*) AS count FROM feedback_events WHERE agent_id = ? GROUP BY signal')
      .all(agentId) as { signal: string; count: number }[]
    return {
      up: Number(
        rows.find((r) => {
          return r.signal === 'thumb_up'
        })?.count ?? 0,
      ),
      down: Number(
        rows.find((r) => {
          return r.signal === 'thumb_down'
        })?.count ?? 0,
      ),
    }
  }
}
