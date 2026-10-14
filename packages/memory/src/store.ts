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
  /** 向量来源模型（无向量或旧数据为空）。换模型后据此过滤，不混库。 */
  embeddingModel?: string
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
  /** 与 embedding 一起写入的模型标识（向量身份的一部分）。 */
  embeddingModel?: string
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
    ...(row.embedding_model === null || row.embedding_model === undefined
      ? {}
      : { embeddingModel: String(row.embedding_model) }),
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
      INSERT INTO memories (id, agent_id, kind, content, embedding, dim, embedding_model, created_at,
                            updated_at, source_conversation_id, status, supersedes_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `)
      .run(
        id,
        input.agentId,
        input.kind,
        input.content,
        input.embedding ?? null,
        dim,
        input.embeddingModel ?? null,
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

  /** 拉取某空间全部 active 向量（用于内存余弦；单用户规模 <10k，暴力即可）。 */
  listActiveEmbeddings(agentId: string, embeddingModel?: string): MemoryRow[] {
    const rows = (
      embeddingModel === undefined
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND (agent_id = ? OR agent_id = ?)",
            )
            .all(agentId, SHARED_SPACE)
        : this.db
            .prepare(
              "SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ? AND (agent_id = ? OR agent_id = ?)",
            )
            .all(embeddingModel, agentId, SHARED_SPACE)
    ) as Record<string, unknown>[]
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

  /**
   * 已归档的记忆（status='inactive'），按归档时间倒序。
   * 归档本身不物理删除行，所以这里能把它们原样还给 UI 展示并允许恢复。
   */
  listArchived(limit = 200): MemoryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE status = 'inactive' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /**
   * 恢复一条归档记忆：status → active，并把内容放回 FTS 索引。
   *
   * FTS 行先删后插：归档前的行可能还在索引里（巩固只改 status），而 FTS5 的
   * rowid 唯一，重复插入会直接报错。
   * @returns 是否恢复成功（不存在或本来就不是归档状态返回 false）。
   */
  restore(id: string): boolean {
    const row = this.db.prepare('SELECT content, status FROM memories WHERE id = ?').get(id) as
      | { content: string; status: string }
      | undefined
    if (row === undefined || row.status !== 'inactive') return false
    this.db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id)
    const rowid = this.rowidOf(id)
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
    this.db.prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(rowid, bigrams(row.content))
    return true
  }

  /**
   * 需要重建向量的记忆：还没有向量，或向量的来源模型不是当前模型。
   *
   * 归档（inactive）也算：用户随时能把它恢复，恢复后应当立刻可被语义检索。
   * 软删链（superseded/deleted）不重建——它们不参与检索，重建纯属浪费额度。
   */
  listMissingEmbeddings(embeddingModel: string, limit = 500): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE status IN ('active', 'inactive')
            AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(embeddingModel, limit) as Record<string, unknown>[]
    return rows.map(rowToMemory)
  }

  /** 回填向量：写 embedding + 维度 + 来源模型（向量身份的一部分）。 */
  setEmbedding(id: string, embedding: Float32Array, embeddingModel: string): void {
    this.db
      .prepare('UPDATE memories SET embedding = ?, dim = ?, embedding_model = ? WHERE id = ?')
      .run(
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        embedding.length,
        embeddingModel,
        id,
      )
  }

  // ---- embedding 缓存（按模型分桶，换模型不混库）----

  cachedEmbedding(text: string, embeddingModel: string): Float32Array | null {
    const row = this.db
      .prepare('SELECT vector FROM embedding_cache WHERE hash = ? AND model = ?')
      .get(textHash(text), embeddingModel) as { vector: ArrayBuffer } | undefined
    return row === undefined ? null : toFloat32(row.vector)
  }

  cacheEmbedding(text: string, vector: Float32Array, embeddingModel: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO embedding_cache (hash, model, vector, dim, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        textHash(text),
        embeddingModel,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        vector.length,
        Date.now(),
      )
  }

  /** 各模型桶的缓存条数（换模型观测用）。 */
  embeddingCacheStats(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const row of this.db
      .prepare(
        "SELECT COALESCE(NULLIF(model, ''), '(legacy)') AS model, COUNT(*) AS count FROM embedding_cache GROUP BY model",
      )
      .all() as { model: string; count: number }[]) {
      out[row.model] = Number(row.count)
    }
    return out
  }

  /**
   * active 向量按来源模型分桶：检索按当前模型过滤，被排除的旧模型向量在这里
   * 可见（换 embedding 模型后应重算，不静默混库）。
   */
  embeddingModelStats(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const row of this.db
      .prepare(
        "SELECT COALESCE(NULLIF(embedding_model, ''), '(legacy)') AS model, COUNT(*) AS count FROM memories WHERE embedding IS NOT NULL GROUP BY model",
      )
      .all() as { model: string; count: number }[]) {
      out[row.model] = Number(row.count)
    }
    return out
  }

  // ---- 巩固归档（保守：不物理删除，只移出检索面）----

  /**
   * 归档长期零访问的 active 记忆 → status='inactive'。
   * 判定基准用 last_accessed_at（没被召回过的记忆回落到 updated_at），命中即
   * 续命，因此"稳定但被反复召回"的偏好不会被归档。
   *
   * 共享画像（SHARED_SPACE）排除在外：它记录的是用户是谁，一旦归档就没有任何
   * 恢复入口（界面上看不到 inactive 行），等于静默抹掉用户画像。
   * @returns 归档条数。
   */
  archiveDormant(dormantAfterMs: number, now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE memories SET status = 'inactive', updated_at = ?
       WHERE status = 'active'
         AND agent_id != ?
         AND access_count = 0
         AND COALESCE(NULLIF(last_accessed_at, 0), updated_at) < ?`,
      )
      .run(now, SHARED_SPACE, now - dormantAfterMs)
    return Number(result.changes)
  }

  /**
   * 归档陈旧软删链：superseded 且已超过保留期的历史版本 → inactive。
   * 当前 active 记忆的直接前身保留（软删链末端的可追溯性），更早的中间版本
   * 归档；行本身不删，`supersedes_id` 指针仍可追溯。
   * @returns 归档条数。
   */
  archiveColdSuperseded(maxAgeMs: number, now = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE memories SET status = 'inactive', updated_at = ?
       WHERE status = 'superseded'
         AND updated_at < ?
         AND id NOT IN (
           SELECT y.supersedes_id FROM memories y
           WHERE y.supersedes_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM memories z WHERE z.supersedes_id = y.id)
         )`,
      )
      .run(now, now - maxAgeMs)
    return Number(result.changes)
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
