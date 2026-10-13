/**
 * 进化存储层：playbook 条目、反思、反馈事件。
 * @module @ryagent/evolve/store
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalizeText, textOverlap, textSimilarity } from './relevance.ts'
import type { EntryStatus, PlaybookSection, ReflectionStatus } from './schema.ts'
import { migrateEvolve } from './schema.ts'

/** 近似去重的相似度阈值（Jaccard）。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.8
/** 教训检索的最低相关度阈值。 */
export const REFLECTION_RELEVANCE_THRESHOLD = 0.15
/** 教训检索的候选扫描上限（pending 池很小，扫描全部即可）。 */
const PENDING_SCAN_LIMIT = 50

/** 教训与当前输入的相关度：正文与情境摘要取较大者。 */
export function reflectionRelevance(query: string, row: ReflectionRow): number {
  const lesson = textOverlap(query, row.lesson)
  const context = row.contextDigest.length === 0 ? 0 : textOverlap(query, row.contextDigest)
  return Math.max(lesson, context)
}

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

  /**
   * 近似去重：精确字符串匹配挡不住"同一件事换个说法"（Curator 每次改写措辞
   * 就会新增一条），手册很快自我复制膨胀。归一化 bigram Jaccard ≥
   * {@link NEAR_DUPLICATE_THRESHOLD} 视为同一条。
   */
  hasNearDuplicate(agentId: string, section: PlaybookSection, content: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
    return this.hasNearDuplicateExcept(agentId, section, content, undefined, threshold)
  }

  /** 同上，但可排除某条条目自身（update 场景：条目与自己的新内容必然近似）。 */
  hasNearDuplicateExcept(
    agentId: string,
    section: PlaybookSection,
    content: string,
    exceptId?: string,
    threshold = NEAR_DUPLICATE_THRESHOLD,
  ): boolean {
    const candidates = this.db
      .prepare(
        "SELECT id, content FROM playbook_entries WHERE agent_id = ? AND section = ? AND status = 'active'",
      )
      .all(agentId, section) as { id: string; content: string }[]
    return candidates.some((row) => {
      if (row.id === exceptId) return false
      return textSimilarity(row.content, content) >= threshold
    })
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
  listActiveForCompile(agentId: string, limit = 200): PlaybookEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM playbook_entries WHERE agent_id = ? AND status = 'active' ORDER BY section, (helpful - harmful) DESC, updated_at DESC LIMIT ?",
      )
      .all(agentId, limit) as Record<string, unknown>[]
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

  /**
   * 按当前输入检索待验证教训（注入用）：相关度降序，无相关项时不注入。
   *
   * 原实现无条件取最近 3 条，于是翻译任务也会被注入"文件操作教训"。
   * 查询为空/无有效字符时退回最近 N 条（保持"首次反思仍能被看到"）。
   */
  searchPendingReflections(agentId: string, query: string, limit = 3): ReflectionRow[] {
    const pending = this.listPendingReflections(agentId, PENDING_SCAN_LIMIT)
    if (pending.length === 0) return []
    if (normalizeText(query).length === 0) return pending.slice(0, limit)
    const ranked = pending
      .map((row) => {
        return { row, score: reflectionRelevance(query, row) }
      })
      .filter((hit) => {
        return hit.score >= REFLECTION_RELEVANCE_THRESHOLD
      })
      .sort((a, b) => {
        return b.score - a.score
      })
      .slice(0, limit)
      .map((hit) => {
        return hit.row
      })
    return ranked
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
