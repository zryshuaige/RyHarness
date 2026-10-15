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

/** 按 rowid 批量改写时的参数上限分片（SQLite 绑定变量有上限）。 */
const ROWID_CHUNK = 500

/**
 * FTS5 MATCH 查询串：bigram token 逐个加引号，token 内的 `"` 双写。
 *
 * 不转义时 bigram 会把原文标点带进查询语法，整条词法通道直接抛错：
 * `e:` 被当成列过滤器（no such column: e）、`a"b` 的引号当成字符串定界
 * （unterminated string）、`PORT` 的 `OR` 段成了布尔关键字。用户发一条带
 * `- . / @ # : "` 的输入，长期记忆检索就整条静默失效。
 */
export function ftsMatchQuery(text: string): string {
  return bigrams(text)
    .split(' ')
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ')
}

/** 记忆存储。 */
export class MemoryStore {
  private readonly db: DatabaseSync
  /**
   * active 向量常驻缓存（键 = 空间 + 向量模型）。
   *
   * recall 在首 token 路径上：每轮都从表里读全部 active 记忆的 BLOB 再算余弦，
   * 延迟随库规模线性增长（1000 条 × 1024 维 ≈ 4MB/轮的读 + 反序列化）。
   * 失效条件 = 本连接写代数变化，或其他连接提交过（agent 删除等跨连接写入走
   * PRAGMA data_version）。访问计数就地改缓存行，不因此整体失效。
   */
  private readonly embeddingIndex = new Map<string, { stamp: string; rows: MemoryRow[] }>()
  private embeddingEpoch = 0

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
    this.invalidateEmbeddingIndex()
    const row = this.get(id)
    if (row === undefined) throw new Error('@ryagent/memory: insert did not persist')
    return row
  }

  /** 软删：status → superseded（被取代，保历史）或 deleted。 */
  supersede(id: string, status: 'superseded' | 'deleted' = 'superseded'): void {
    this.db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(this.rowidOf(id))
    this.invalidateEmbeddingIndex()
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

  /**
   * FTS5 BM25 候选窗口（全库，按 bm25 升序）。
   *
   * 窗口是**全局**的：空间归属的过滤放在调用侧（{@link searchFts}），因此同一次
   * 扇出里多个成员可以共用这一份命中表，不必每个成员各发一次 MATCH。
   */
  searchFtsHits(query: string, window = 30): { memory: MemoryRow; score: number }[] {
    // OR 语义：候选事实常比记忆长，全 AND 会零命中；BM25 按命中比例排序。
    const matchQuery = ftsMatchQuery(query)
    if (matchQuery.length === 0) return []
    const rowids = this.db
      .prepare(
        'SELECT rowid, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score LIMIT ?',
      )
      .all(matchQuery, window) as { rowid: number; score: number }[]
    const out: { memory: MemoryRow; score: number }[] = []
    for (const hit of rowids) {
      const row = this.db.prepare('SELECT * FROM memories WHERE rowid = ?').get(Number(hit.rowid)) as
        | Record<string, unknown>
        | undefined
      if (row === undefined) continue
      const memory = rowToMemory(row)
      if (memory.status !== 'active') continue
      out.push({ memory, score: Number(hit.score) })
    }
    return out
  }

  /** FTS5 BM25 top-N（active 记忆，限定空间：agent 私有 + 共享）。 */
  searchFts(agentId: string, query: string, limit = 10): MemoryRow[] {
    const out: MemoryRow[] = []
    for (const hit of this.searchFtsHits(query, limit * 3)) {
      if (hit.memory.agentId !== agentId && hit.memory.agentId !== SHARED_SPACE) continue
      out.push(hit.memory)
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * 某空间的 active 向量（agent 私有空间或共享画像各自一桶）。
   *
   * 共享画像单独成桶是给扇出用的：N 个成员召回同一段输入时，共享向量只解码
   * 一次，而不是每个成员各解一份（1000 条 × 1024 维的库，一次就是几 MB 的
   * 反序列化）。返回的是缓存内的行，调用方按只读用。
   */
  listSpaceEmbeddings(spaceId: string, embeddingModel?: string): MemoryRow[] {
    const key = `${spaceId}|${embeddingModel ?? ''}`
    const stamp = this.embeddingStamp()
    const cached = this.embeddingIndex.get(key)
    if (cached !== undefined && cached.stamp === stamp) return cached.rows
    const rows = (
      embeddingModel === undefined
        ? this.db
            .prepare("SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND agent_id = ?")
            .all(spaceId)
        : this.db
            .prepare(
              "SELECT * FROM memories WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ? AND agent_id = ?",
            )
            .all(embeddingModel, spaceId)
    ) as Record<string, unknown>[]
    const out = rows.map(rowToMemory)
    this.embeddingIndex.set(key, { stamp, rows: out })
    return out
  }

  /**
   * 拉取某空间的全部 active 向量（私有 + 共享；用于内存余弦，单用户规模 <10k，
   * 暴力即可）。两个空间桶拼成新数组：调用方按只读用，但别指望两次调用拿到
   * 同一个数组实例。
   */
  listActiveEmbeddings(agentId: string, embeddingModel?: string): MemoryRow[] {
    const shared = this.listSpaceEmbeddings(SHARED_SPACE, embeddingModel)
    if (agentId === SHARED_SPACE) return shared
    return [...this.listSpaceEmbeddings(agentId, embeddingModel), ...shared]
  }

  /**
   * 缓存有效期：本连接写代数 + PRAGMA data_version。
   * data_version 只在**其他连接**提交时变化（agent 删除等跨连接写入），
   * 本连接的写由 embeddingEpoch 负责，两边都变了才算失效。
   */
  private embeddingStamp(): string {
    const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number }
    return `${this.embeddingEpoch}:${Number(row.data_version)}`
  }

  private invalidateEmbeddingIndex(): void {
    this.embeddingEpoch += 1
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
    // 常驻缓存里是同一批对象，就地改：每轮召回都会 touchAccess，
    // 若因此整体失效，缓存就等于没加（下一轮照样全表读）。
    const touched = new Set(ids)
    for (const entry of this.embeddingIndex.values()) {
      for (const row of entry.rows) {
        if (!touched.has(row.id)) continue
        row.accessCount += 1
        row.lastAccessedAt = now
      }
    }
  }

  /** 回写 updatedAt（巩固/衰减任务与测试用）。 */
  backdate(id: string, timestamp: number): void {
    this.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(timestamp, id)
    this.invalidateEmbeddingIndex()
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
    this.invalidateEmbeddingIndex()
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
    this.invalidateEmbeddingIndex()
  }

  /** FTS 索引行数（观测用：归档/软删同步清理后应随之下降）。 */
  ftsIndexSize(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM memories_fts').get() as { count: number }).count)
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
   *
   * 归档同步清出 FTS 索引：只改 status 的话索引里全是死行，BM25 候选窗口被
   * 吃光，召回质量随时间单调退化（行数据保留，restore 时重建索引行）。
   *
   * `limit` 缺省是一次归档完（调用方要的是"这批到底归档了多少"）；给出时只归档
   * 至多 limit 行（`ORDER BY rowid` 推进，下一片自然取到下一批）——巩固任务在
   * 服务进程的事件循环里跑，整段 UPDATE 会把主循环冻住（实测 1.8s），切片
   * 后每片之间能正常让出事件循环。
   * @returns 本次（分片时为该片）归档条数。
   */
  archiveDormant(dormantAfterMs: number, now = Date.now(), limit?: number): number {
    const predicate = `status = 'active'
         AND agent_id != ?
         AND access_count = 0
         AND COALESCE(NULLIF(last_accessed_at, 0), updated_at) < ?`
    const args = [SHARED_SPACE, now - dormantAfterMs]
    if (limit !== undefined) return this.archiveBatch(predicate, args, now, limit)
    const stale = this.staleRowids(predicate, args)
    const result = this.db
      .prepare(`UPDATE memories SET status = 'inactive', updated_at = ? WHERE ${predicate}`)
      .run(now, ...args)
    this.dropFtsRows(stale)
    this.invalidateEmbeddingIndex()
    return Number(result.changes)
  }

  /**
   * 归档陈旧软删链：superseded 且已超过保留期的历史版本 → inactive。
   * 当前 active 记忆的直接前身保留（软删链末端的可追溯性），更早的中间版本
   * 归档；行本身不删，`supersedes_id` 指针仍可追溯。FTS 索引同步清理（同 archiveDormant）。
   *
   * `limit` 的分片语义同 {@link archiveDormant}。归档本身不改变"谁被判定为陈旧"
   * （条件只看 status/时间与软删链指针），因此切片不会漏行也不会重行。
   * @returns 本次（分片时为该片）归档条数。
   */
  archiveColdSuperseded(maxAgeMs: number, now = Date.now(), limit?: number): number {
    const predicate = `status = 'superseded'
         AND updated_at < ?
         AND id NOT IN (
           SELECT y.supersedes_id FROM memories y
           WHERE y.supersedes_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM memories z WHERE z.supersedes_id = y.id)
         )`
    const args = [now - maxAgeMs]
    if (limit !== undefined) return this.archiveBatch(predicate, args, now, limit)
    const stale = this.staleRowids(predicate, args)
    const result = this.db
      .prepare(`UPDATE memories SET status = 'inactive', updated_at = ? WHERE ${predicate}`)
      .run(now, ...args)
    this.dropFtsRows(stale)
    this.invalidateEmbeddingIndex()
    return Number(result.changes)
  }

  /** 命中归档条件的 rowid（按 rowid 推进，切片可重复调用）。 */
  private staleRowids(predicate: string, args: readonly (string | number)[]): number[] {
    const rows = this.db.prepare(`SELECT rowid FROM memories WHERE ${predicate} ORDER BY rowid`).all(...args) as {
      rowid: number
    }[]
    return rows.map((row) => {
      return Number(row.rowid)
    })
  }

  /**
   * 分片归档：只动本片至多 `limit` 行（UPDATE ... WHERE rowid IN），
   * FTS 行同片清出。返回本片归档条数——调用方按「返回数 < limit」判断扫完。
   */
  private archiveBatch(predicate: string, args: readonly (string | number)[], now: number, limit: number): number {
    if (limit <= 0) return 0
    const rows = this.db
      .prepare(`SELECT rowid FROM memories WHERE ${predicate} ORDER BY rowid LIMIT ?`)
      .all(...args, Math.min(limit, ROWID_CHUNK)) as { rowid: number }[]
    const rowids = rows.map((row) => {
      return Number(row.rowid)
    })
    if (rowids.length === 0) return 0
    const placeholders = rowids
      .map(() => {
        return '?'
      })
      .join(',')
    const result = this.db
      .prepare(`UPDATE memories SET status = 'inactive', updated_at = ? WHERE rowid IN (${placeholders})`)
      .run(now, ...rowids)
    this.dropFtsRows(rowids)
    this.invalidateEmbeddingIndex()
    return Number(result.changes)
  }

  /** 批量删 FTS 索引行（分片，避免 IN 参数超上限）。 */
  private dropFtsRows(rowids: readonly number[]): void {
    for (let start = 0; start < rowids.length; start += ROWID_CHUNK) {
      const chunk = rowids.slice(start, start + ROWID_CHUNK)
      this.db
        .prepare(
          `DELETE FROM memories_fts WHERE rowid IN (${chunk
            .map(() => {
              return '?'
            })
            .join(',')})`,
        )
        .run(...chunk)
    }
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
