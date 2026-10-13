/**
 * 记忆存储层：CRUD、软删链、FTS5 BM25、内存余弦检索、访问计数。
 * 与 @ryagent/session 共用同一 SQLite 文件（WAL 下多连接安全）。
 * @module @ryagent/memory/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { MemoryKind, MemoryStatus } from './schema.ts'
import { migrateMemory, SHARED_SPACE } from './schema.ts'

export interface MemoryRow {
  id: string
  agentId: string
  kind: MemoryKind
  content: string
  embedding: Float32Array | null
  dim: number | null
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
  accessCount: number
  sourceConversationId?: string
  status: MemoryStatus
  supersedesId?: string
}

export interface InsertMemoryInput {
  agentId: string
  kind: MemoryKind
  content: string
  embedding?: Float32Array | null
  sourceConversationId?: string
  supersedesId?: string
}

function rowToMemory(row: Record<string, unknown>): MemoryRow {
  const embedding =
    row.embedding === null || row.embedding === undefined ? null : toFloat32(row.embedding as ArrayBuffer)
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    kind: String(row.kind) as MemoryKind,
    content: String(row.content),
    embedding,
    dim: row.dim === null || row.dim === undefined ? null : Number(row.dim),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: Number(row.last_accessed_at),
    accessCount: Number(row.access_count),
    ...(row.source_conversation_id === null || row.source_conversation_id === undefined
      ? {}
      : { sourceConversationId: String(row.source_conversation_id) }),
    status: String(row.status) as MemoryStatus,
    ...(row.supersedes_id === null || row.supersedes_id === undefined
      ? {}
      : { supersedesId: String(row.supersedes_id) }),
  }
}

export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** node:sqlite 把 BLOB 读成 Buffer：按底层 ArrayBuffer 视图重解释为 Float32。 */
function toFloat32(buffer: ArrayBuffer): Float32Array {
  const view = buffer as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
}

/**
 * 中文 bigram 分词：unicode61 不把 CJK 切段，整句是一个 token，前缀查询失效。
 * 索引用相邻两字一个 token（"用户养猫" → "用户 户养 养猫"），查询同样变换，
 * FTS5 默认 AND 语义 → 真实的中文 BM25。
 */
export function bigrams(text: string): string {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0) return ''
  if (compact.length === 1) return compact
  const parts: string[] = []
  for (let i = 0; i < compact.length - 1; i++) parts.push(compact.slice(i, i + 2))
  return parts.join(' ')
}

/** 记忆存储。 */
export class MemoryStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    migrateMemory(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ---- 写入 ----

  /** 新增一条记忆（FTS 同步建索引）。 */
  insert(input: InsertMemoryInput): MemoryRow {
    const now = Date.now()
    const id = randomUUID()
    const dim = input.embedding === undefined || input.embedding === null ? null : input.embedding.length
    this.db
      .prepare(`
      INSERT INTO memories (id, agent_id, kind, content, embedding, dim, created_at, updated_at,
                            source_conversation_id, status, supersedes_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `)
      .run(
        id,
        input.agentId,
        input.kind,
        input.content,
        input.embedding ?? null,
        dim,
        now,
        now,
        input.sourceConversationId ?? null,
        input.supersedesId ?? null,
      )
    this.db
      .prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)')
      .run(this.rowidOf(id), bigrams(input.content))
    const row = this.get(id)
    if (row === undefined) throw new Error('@ryagent/memory: insert did not persist')
    return row
  }

  /** 软删：status → superseded（被取代，保历史）或 deleted。 */
  supersede(id: string, status: 'superseded' | 'deleted' = 'superseded'): void {
    this.db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(this.rowidOf(id))
  }

  /** 读取一条（任意状态）。 */
  get(id: string): MemoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : rowToMemory(row)
  }

  private rowidOf(id: string): number {
    const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }
    return Number(row.rowid)
  }

  // ---- 检索 ----

  /** FTS5 BM25 top-N（active 记忆，限定空间：agent 私有 + 共享）。 */
  searchFts(agentId: string, query: string, limit = 10): MemoryRow[] {
    // OR 语义：候选事实常比记忆长，全 AND 会零命中；BM25 按命中比例排序。
    const matchQuery = bigrams(query).split(' ').join(' OR ')
    if (matchQuery.length === 0) return []
    const rowids = this.db
      .prepare(
        'SELECT rowid, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT ?',
      )
      .all(matchQuery, limit * 3) as { rowid: number }[]
    const out: MemoryRow[] = []
    for (const hit of rowids) {
      const row = this.db.prepare('SELECT * FROM memories WHERE rowid = ?').get(Number(hit.rowid)) as
        | Record<string, unknown>
        | undefined
      if (row === undefined) continue
      const memory = rowToMemory(row)
      if (memory.status === 'active' && (memory.agentId === agentId || memory.agentId === SHARED_SPACE)) {
        out.push(memory)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /** 拉取某空间全部 active 记忆（用于内存余弦；单用户规模 <10k，暴力即可）。 */
  listActiveEmbeddings(agentId: string): MemoryRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND (agent_id = ? OR agent_id = ?)",
      )
      .all(agentId, SHARED_SPACE) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /** 共享画像：profile 类全量（量小，Core 式注入）。 */
  listSharedProfile(): MemoryRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE status = 'active' AND agent_id = ? AND kind = 'profile' ORDER BY updated_at DESC",
      )
      .all(SHARED_SPACE) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /** 访问计数 + 时间更新（召回命中后调用）。 */
  touchAccess(ids: readonly string[]): void {
    const now = Date.now()
    const stmt = this.db.prepare(
      'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
    )
    for (const id of ids) stmt.run(now, id)
  }

  /** 回写 updatedAt（巩固/衰减任务与测试用）。 */
  backdate(id: string, timestamp: number): void {
    this.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(timestamp, id)
  }

  /** 某 agent 的 active 记忆列表。 */
  listActiveForAgent(agentId: string, limit = 200): MemoryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND agent_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  // ---- embedding 缓存 ----

  cachedEmbedding(text: string): Float32Array | null {
    const row = this.db.prepare('SELECT vector FROM embedding_cache WHERE hash = ?').get(textHash(text)) as
      | { vector: ArrayBuffer }
      | undefined
    return row === undefined ? null : toFloat32(row.vector)
  }

  cacheEmbedding(text: string, vector: Float32Array): void {
    this.db
      .prepare('INSERT OR IGNORE INTO embedding_cache (hash, vector, dim, created_at) VALUES (?, ?, ?, ?)')
      .run(textHash(text), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), vector.length, Date.now())
  }

  // ---- 统计 ----

  stats(): {
    total: number
    bySpace: Record<string, number>
    byKind: Record<string, number>
    byStatus: Record<string, number>
  } {
    const count = (sql: string, ...args: (string | number)[]) => {
      return Number((this.db.prepare(sql).get(...args) as { count: number }).count)
    }
    const bySpace: Record<string, number> = {}
    for (const row of this.db.prepare('SELECT agent_id, COUNT(*) AS count FROM memories GROUP BY agent_id').all() as {
      agent_id: string
      count: number
    }[]) {
      bySpace[row.agent_id] = Number(row.count)
    }
    const byKind: Record<string, number> = {}
    for (const row of this.db.prepare('SELECT kind, COUNT(*) AS count FROM memories GROUP BY kind').all() as {
      kind: string
      count: number
    }[]) {
      byKind[row.kind] = Number(row.count)
    }
    const byStatus: Record<string, number> = {}
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS count FROM memories GROUP BY status').all() as {
      status: string
      count: number
    }[]) {
      byStatus[row.status] = Number(row.count)
    }
    return { total: count('SELECT COUNT(*) AS count FROM memories'), bySpace, byKind, byStatus }
  }
}
