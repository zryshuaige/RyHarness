/**
 * 记忆存储层：CRUD、软删链、FTS5 BM25、内存余弦检索、访问计数。
 * 与 @ryharness/session 共用同一 SQLite 文件（WAL 下多连接安全）。
 * @module @ryharness/memory/store
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
  /** 用户 👍 次数（反向信号，与 access_count 同为召回增益的一部分）。 */
  helpfulCount: number
  /** 用户 👎 次数（反向信号；排序时从增益里扣，见 service 的 recallGain）。 */
  harmfulCount: number
  /**
   * 重要性档位（1=一般 / 2=重要 / 3=关键）。3 档的记忆不参与自动归档：
   * 「女儿叫小雨」式的低频关键事实不该因为 90 天没被恰好召回就失忆。
   */
  importance: number
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
  /** 重要性档位（缺省 1；关键事实由抽取管线判 3）。 */
  importance?: number
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
    helpfulCount: Number(row.helpful_count ?? 0),
    harmfulCount: Number(row.harmful_count ?? 0),
    importance: Number(row.importance ?? 1),
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

/** 一个空间桶的堆叠向量：行 i 的向量 = data[offsets[i] .. offsets[i]+dims[i])。 */
export interface StackedEmbeddings {
  /** 全部行向量连续堆叠的字节（一次分配，打分循环顺序读）。 */
  data: Float32Array
  /** 每行向量在 data 里的起点。 */
  offsets: Uint32Array
  /** 每行向量维度（与查询维度不符的行由调用侧剔除并记账）。 */
  dims: Uint32Array
}

/** 常驻空间桶：行 + id 索引 + 惰性堆叠的向量矩阵（stamp 变即整体重建）。 */
interface SpaceBucket {
  stamp: string
  rows: MemoryRow[]
  byId: Map<string, MemoryRow>
  /**
   * 首次打分时惰性堆叠。只存向量字节：touchAccess/applyFeedback 就地改的是
   * 行对象上的计数，不碰矩阵——矩阵不需要因访问记账而重堆。
   */
  matrix?: StackedEmbeddings
}

/** 把一桶行向量堆进一个连续 Float32Array（行序与 rows 一致）。 */
function stackEmbeddings(rows: readonly MemoryRow[]): StackedEmbeddings {
  const offsets = new Uint32Array(rows.length)
  const dims = new Uint32Array(rows.length)
  let total = 0
  for (let index = 0; index < rows.length; index++) {
    const embedding = rows[index].embedding
    offsets[index] = total
    dims[index] = embedding === null ? 0 : embedding.length
    total += dims[index]
  }
  const data = new Float32Array(total)
  for (let index = 0; index < rows.length; index++) {
    const embedding = rows[index].embedding
    if (embedding !== null) data.set(embedding, offsets[index])
  }
  return { data, offsets, dims }
}

/** 按 rowid 批量改写时的参数上限分片（SQLite 绑定变量有上限）。 */
const ROWID_CHUNK = 500

/**
 * FTS5 MATCH 查询串的 OR 臂上限（去重后）。
 *
 * OR 查询在 FTS5 里按「臂数 × 词项文档频率」付费且无内生上界：实测 2000 条
 * 记忆的库上，1000 字输入（≈999 个 bigram）的 MATCH 要 6.4 秒、3000 字 59 秒，
 * 全部同步跑在事件循环上。上限只约束**超长输入**——正常聊天的去重 bigram
 * 远低于此，查询串一个字符都不变。
 */
export const MAX_FTS_QUERY_TERMS = 32

/** 去重后的 bigram 词项（保持首现顺序）。重复段（「哈哈哈哈」）不重复计费。 */
function uniqueBigrams(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of bigrams(text).split(' ')) {
    if (token.length === 0 || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** 词项逐个加引号（token 内的 `"` 双写）后 OR 连接。 */
function quoteTerms(tokens: readonly string[]): string {
  return tokens
    .map((token) => {
      return `"${token.replace(/"/g, '""')}"`
    })
    .join(' OR ')
}

/**
 * FTS5 MATCH 查询串：bigram token 逐个加引号，token 内的 `"` 双写。
 *
 * 不转义时 bigram 会把原文标点带进查询语法，整条词法通道直接抛错：
 * `e:` 被当成列过滤器（no such column: e）、`a"b` 的引号当成字符串定界
 * （unterminated string）、`PORT` 的 `OR` 段成了布尔关键字。用户发一条带
 * `- . / @ # : "` 的输入，长期记忆检索就整条静默失效。
 *
 * 超过 {@link MAX_FTS_QUERY_TERMS} 的长输入在纯函数里退化为头部截断；
 * 存储层 {@link MemoryStore.searchFtsHits} 会先用词表挑区分度高的词项再
 * 走到这里（见 buildMatchQuery）。
 */
export function ftsMatchQuery(text: string): string {
  const tokens = uniqueBigrams(text)
  return quoteTerms(tokens.length <= MAX_FTS_QUERY_TERMS ? tokens : tokens.slice(0, MAX_FTS_QUERY_TERMS))
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
   *
   * 桶内另存一份 id → 行 的索引：{@link touchAccess} 每轮都要修补缓存里的
   * 计数，全量扫描是 O(全库)——1000 条记忆的库里每轮召回白扫一遍，与 SSE
   * 推流同线程。
   *
   * 桶内还惰性挂一份堆叠向量矩阵（{@link spaceEmbeddingMatrix}）：打分循环
   * 在连续字节上单趟跑，替代逐行 cosine 的每行函数调用与属性访问；它与桶
   * 同生命周期，任何失效路径（写入/跨连接提交）整体重建，无需单独记账。
   */
  private readonly embeddingIndex = new Map<string, SpaceBucket>()
  private embeddingEpoch = 0

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    // 独立 server 与桌面版双进程共用同一数据目录时，WAL 写锁互撞默认立刻抛
    // SQLITE_BUSY（busy_timeout=0）。5 秒退避让另一进程的写事务先走完——
    // 启动即炸的硬错指向不明，这行 PRAGMA 是那道便宜的保险。
    this.db.exec('PRAGMA busy_timeout = 5000')
    migrateMemory(this.db)
  }

  close(): void {
    this.db.close()
  }

  // ---- 写入 ----

  /**
   * 新增一条记忆（FTS 同步建索引）。
   *
   * 两条写（记忆行 / FTS 索引行）此前各自隐式事务：中途失败会留下**有行无索引**的
   * 记忆——它从此对 BM25 词法通道永久不可见，且没有任何"重建 FTS"的任务能救它。
   * 会话侧早就把"多语句写必须同事务"当成硬要求（见 @ryharness/session 的
   * `appendMessage`），同一个 SQLite 文件上的记忆侧不能是另一套标准。
   */
  insert(input: InsertMemoryInput): MemoryRow {
    const now = Date.now()
    const id = randomUUID()
    const dim = input.embedding === undefined || input.embedding === null ? null : input.embedding.length
    // BEGIN IMMEDIATE 在写入前就拿写锁，单写者模型下不引入额外争用
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(`
        INSERT INTO memories (id, agent_id, kind, content, embedding, dim, embedding_model, created_at,
                              updated_at, source_conversation_id, status, supersedes_id, importance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
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
          input.importance ?? 1,
        )
      this.db
        .prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)')
        .run(this.rowidOf(id), bigrams(input.content))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.invalidateEmbeddingIndex()
    const row = this.get(id)
    if (row === undefined) throw new Error('@ryharness/memory: insert did not persist')
    return row
  }

  /**
   * 软删：status → superseded（被取代，保历史）或 deleted。
   *
   * 状态写与索引删必须同事务：只改了状态没删索引，那条记忆还占着 BM25 的候选
   * 窗口，召回质量会随时间单调退化。
   */
  supersede(id: string, status: 'superseded' | 'deleted' = 'superseded'): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(this.rowidOf(id))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
   * FTS5 BM25 候选窗口（按 bm25 升序，只含 active 记忆）。
   *
   * 窗口是**全局**的：空间归属的过滤放在调用侧（{@link searchFts}），因此同一次
   * 扇出里多个成员可以共用这一份命中表，不必每个成员各发一次 MATCH。
   *
   * 一条 JOIN 把 MATCH 与取行合在一起：原先每个命中再 `SELECT * ... WHERE
   * rowid = ?`，窗口 30 就是每轮 31 次查询——而这段跑在 Node 单线程上，与 SSE
   * 推流同一条线程。status 过滤也下推到 SQL，LIMIT 取到的就是前 window 条
   * **active** 行（原先软删行会占位、白白吃掉窗口）。
   */
  searchFtsHits(query: string, window = 30): { memory: MemoryRow; score: number }[] {
    // OR 语义：候选事实常比记忆长，全 AND 会零命中；BM25 按命中比例排序。
    const matchQuery = this.buildMatchQuery(query)
    if (matchQuery.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT memories.*, bm25(memories_fts) AS bm25_score
           FROM memories_fts JOIN memories ON memories.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND memories.status = 'active'
          ORDER BY bm25_score
          LIMIT ?`,
      )
      .all(matchQuery, window) as Record<string, unknown>[]
    return rows.map((row) => {
      return { memory: rowToMemory(row), score: Number(row.bm25_score) }
    })
  }

  /**
   * 带 OR 臂上限的 MATCH 查询串构造。
   *
   * 词项不超过 {@link MAX_FTS_QUERY_TERMS} 时零额外开销（不碰词表）。超限的
   * 长输入先查 fts5vocab 拿每个 bigram 的文档频率，只保留**库里真实存在
   * （df≥1）**的词项、按 df 升序取最稀有的一批：高频词项在 BM25 里本就不
   * 提供区分度，却贡献了 OR 查询的大部分成本；库里不存在的词项一个都命中
   * 不了，选它们等于白付查询费。词表缺失或查询失败退化为头部截断——上界
   * 仍然成立，只是命中质量回退，绝不会把整条通道抛出去。
   */
  private buildMatchQuery(query: string): string {
    const tokens = uniqueBigrams(query)
    if (tokens.length <= MAX_FTS_QUERY_TERMS) return quoteTerms(tokens)
    try {
      const df = this.termDocFreqs(tokens)
      const present = tokens
        .filter((token) => {
          return df.get(token) !== undefined
        })
        .sort((a, b) => {
          return (df.get(a) ?? 0) - (df.get(b) ?? 0)
        })
        .slice(0, MAX_FTS_QUERY_TERMS)
      // 词表里一个词项都对应不上：任何子集都是零命中，头部截断保持查询形状稳定。
      if (present.length > 0) return quoteTerms(present)
    } catch {
      // 词表查询本身失败（极端：手工删过虚拟表）——头部截断兜底。
    }
    return quoteTerms(tokens.slice(0, MAX_FTS_QUERY_TERMS))
  }

  /** 一批 bigram 的文档频率（fts5vocab 按绑定参数精确查找；分片防 IN 超上限）。 */
  private termDocFreqs(tokens: readonly string[]): Map<string, number> {
    const out = new Map<string, number>()
    for (let start = 0; start < tokens.length; start += ROWID_CHUNK) {
      const chunk = tokens.slice(start, start + ROWID_CHUNK)
      const placeholders = chunk
        .map(() => {
          return '?'
        })
        .join(',')
      const rows = this.db
        .prepare(`SELECT term, doc FROM memories_fts_vocab WHERE term IN (${placeholders})`)
        .all(...chunk) as { term: string; doc: number }[]
      for (const row of rows) out.set(row.term, Number(row.doc))
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
    return this.spaceBucket(spaceId, embeddingModel, this.embeddingStamp()).rows
  }

  /**
   * 某空间桶 + 堆叠向量矩阵（打分单趟遍历的底座，行序与 rows 一致）。
   *
   * 逐行 cosine 时每行都要一次函数调用与一跳属性访问（recall 跑在首 token
   * 路径上，与 SSE 推流共享事件循环）；矩阵把向量字节连续排布后，热循环只剩
   * 局部变量上的乘加。矩阵挂在桶对象上、与桶同生命周期：stamp 变（本连接写
   * 或跨连接提交）→ 桶整体重建 → 矩阵随之重堆，setEmbedding/supersede 等
   * 已有的失效路径天然覆盖它。
   *
   * `stamp` 可由调用方给出：同一条同步调用链里已经读过写代就透传进来，
   * 不为桶校验多付一次 PRAGMA。
   */
  spaceEmbeddingMatrix(
    spaceId: string,
    embeddingModel?: string,
    stamp = this.embeddingStamp(),
  ): { rows: MemoryRow[] } & StackedEmbeddings {
    const bucket = this.spaceBucket(spaceId, embeddingModel, stamp)
    const existing = bucket.matrix
    if (existing !== undefined) return { rows: bucket.rows, ...existing }
    const matrix = stackEmbeddings(bucket.rows)
    bucket.matrix = matrix
    return { rows: bucket.rows, ...matrix }
  }

  /** 取（或按当前 stamp 重建）空间桶。 */
  private spaceBucket(spaceId: string, embeddingModel: string | undefined, stamp: string): SpaceBucket {
    const key = `${spaceId}|${embeddingModel ?? ''}`
    const cached = this.embeddingIndex.get(key)
    if (cached !== undefined && cached.stamp === stamp) return cached
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
    const bucket: SpaceBucket = {
      stamp,
      rows: out,
      byId: new Map(
        out.map((row) => {
          return [row.id, row]
        }),
      ),
    }
    this.embeddingIndex.set(key, bucket)
    return bucket
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
   *
   * 公开给 service 做短窗缓存的键：同一段输入的扇出召回按「写代没变」判定
   * 已算好的共享空间打分仍然有效，不为复用多读一次数据。
   */
  embeddingStamp(): string {
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

  /**
   * 访问计数 + 时间更新（召回命中后调用）。
   *
   * 合成一条 `WHERE id IN (...)`：逐 id UPDATE 各带一次隐式事务，命中 5 条就是
   * 5 次提交。缓存修补走桶内的 id 索引，只碰命中的行——全量扫描是 O(全库)。
   */
  touchAccess(ids: readonly string[]): void {
    if (ids.length === 0) return
    const now = Date.now()
    for (let start = 0; start < ids.length; start += ROWID_CHUNK) {
      const chunk = ids.slice(start, start + ROWID_CHUNK)
      this.db
        .prepare(
          `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?
            WHERE id IN (${chunk
              .map(() => {
                return '?'
              })
              .join(',')})`,
        )
        .run(now, ...chunk)
    }
    // 常驻缓存里是同一批对象，就地改：每轮召回都会 touchAccess，
    // 若因此整体失效，缓存就等于没加（下一轮照样全表读）。
    for (const entry of this.embeddingIndex.values()) {
      for (const id of ids) {
        const row = entry.byId.get(id)
        if (row === undefined) continue
        row.accessCount += 1
        row.lastAccessedAt = now
      }
    }
  }

  /**
   * 用户反馈回灌：👍 记 helpful +1，👎 记 harmful +1（两个计数彼此独立，与
   * EvolveStore.addCounts 同一套语义——手册里也是分列累加、排序时取净值）。
   *
   * 与 {@link touchAccess} 一样分片 + 合成一条 UPDATE，并且同样要就地修补常驻向量
   * 缓存——被反馈的记忆大概率马上要参与下一轮排序，而排序读的是缓存里的行对象，
   * 不修补的话这一轮反馈要到缓存整体失效之后才生效，用户会看到「点了没反应」。
   *
   * 只累加，不做软删：用户说的是「这条没用」，不是「这条是错的、删掉」。降权由
   * 排序层的增益下界承担（见 service 的 recallGain），记忆本体与历史都留着。
   * @returns 实际更新到的行数。
   */
  applyFeedback(ids: readonly string[], signal: 'thumb_up' | 'thumb_down'): number {
    if (ids.length === 0) return 0
    const column = signal === 'thumb_up' ? 'helpful_count' : 'harmful_count'
    let changed = 0
    for (let start = 0; start < ids.length; start += ROWID_CHUNK) {
      const chunk = ids.slice(start, start + ROWID_CHUNK)
      const placeholders = chunk
        .map(() => {
          return '?'
        })
        .join(',')
      const result = this.db
        .prepare(`UPDATE memories SET ${column} = ${column} + 1 WHERE id IN (${placeholders})`)
        .run(...chunk)
      changed += Number(result.changes)
    }
    for (const entry of this.embeddingIndex.values()) {
      for (const id of ids) {
        const row = entry.byId.get(id)
        if (row === undefined) continue
        if (signal === 'thumb_up') row.helpfulCount += 1
        else row.harmfulCount += 1
      }
    }
    return changed
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
    // 三条写（状态 / 删旧索引 / 建新索引）同事务：中途失败会留下"已恢复但仍搜不到"
    // 或"索引里躺着一条已归档的行"的半条记忆。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(Date.now(), id)
      const rowid = this.rowidOf(id)
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
      this.db.prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(rowid, bigrams(row.content))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.invalidateEmbeddingIndex()
    return true
  }

  /**
   * 就地编辑一条 active 记忆的 content（FTS 索引行同步换内容）。
   *
   * 只允许 active 行：归档/软删行是历史（恢复入口在 restore，复活语义在软删链），
   * 编辑它们等于绕过这两套状态机改写历史。
   *
   * FTS 行与 {@link restore} 同款先删后插：FTS5 的 rowid 唯一，旧内容行还在时
   * 直接插入会撞唯一约束；而只改 memories 表不改索引的话，这条记忆对 BM25
   * 通道永远展示旧内容——用户改对了、检索还在学错的。
   *
   * 向量刻意不在存储层动：旧 embedding 对应旧内容，属"语义过期"，由调用方
   * （service.updateMemory）按新内容重算，存储层不知道 embedding 模型身份。
   * @returns 更新后的行；不存在或非 active 返回 undefined。
   */
  updateContent(id: string, content: string): MemoryRow | undefined {
    const row = this.db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as { status: string } | undefined
    if (row === undefined || row.status !== 'active') return undefined
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(content, Date.now(), id)
      const rowid = this.rowidOf(id)
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rowid)
      this.db.prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(rowid, bigrams(content))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.invalidateEmbeddingIndex()
    return this.get(id)
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
    // importance≥3（关键事实）与被 👍 过的记忆不参与休眠归档：前者是抽取时
    // 判定的「丢了会伤害关系」的事实，后者是用户显式表达过有用的行——两者
    // 都不能用「90 天没被恰好召回」这种访问彩票来裁决生死。
    const predicate = `status = 'active'
         AND agent_id != ?
         AND access_count = 0
         AND importance < 3
         AND helpful_count = 0
         AND COALESCE(NULLIF(last_accessed_at, 0), updated_at) < ?`
    const args = [SHARED_SPACE, now - dormantAfterMs]
    if (limit !== undefined) return this.archiveBatch(predicate, args, now, limit)
    const stale = this.staleRowids(predicate, args)
    // 状态改与索引清必须同事务：只改 status 的话索引里全是死行，BM25 候选窗口
    // 被吃光，召回质量随时间单调退化。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db
        .prepare(`UPDATE memories SET status = 'inactive', updated_at = ? WHERE ${predicate}`)
        .run(now, ...args)
      this.dropFtsRows(stale)
      this.db.exec('COMMIT')
      this.invalidateEmbeddingIndex()
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
    // 同 archiveDormant：状态改与索引清同事务，否则索引里会躺着已归档的死行。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db
        .prepare(`UPDATE memories SET status = 'inactive', updated_at = ? WHERE ${predicate}`)
        .run(now, ...args)
      this.dropFtsRows(stale)
      this.db.exec('COMMIT')
      this.invalidateEmbeddingIndex()
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
