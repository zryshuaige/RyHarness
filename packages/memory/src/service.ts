/**
 * MemoryService：检索管线（recall）+ 异步抽取管线（enqueueExtraction）。
 *
 * 检索配方（调研 §3.4）：输入 → embedding 余弦 top-10 + FTS5 BM25 top-10 →
 * RRF(k=60) 融合 → 时间衰减 score *= exp(-Δdays/30) → top-5 注入；
 * 共享画像（'*shared*' 的 profile 类）全量注入。
 *
 * 抽取管线（调研 §1.2 mem0 式）：本轮 user+assistant 消息 → LLM 抽候选事实
 * （scope 路由：用户事实 → *shared*；互动经验 → agent 空间）→ 每条候选查
 * top-10 相似 → LLM 四操作 → UPDATE/DELETE 走 superseded 软删链。
 * 单 writer 异步队列，失败重试一次后记日志不炸主流程。
 * @module @ryagent/memory/service
 */

import type { EmbeddingProvider } from './embeddings.ts'
import { cosine, embeddingModelOf, NullEmbeddings, textNearDuplicate, textSimilarity } from './embeddings.ts'
import type { CandidateFact, MemoryLlm, MemoryOperation } from './llm.ts'
import type { MemoryKind } from './schema.ts'
import { SHARED_SPACE } from './schema.ts'
import type { MemoryRow } from './store.ts'
import { MemoryStore } from './store.ts'

/** RRF 常数（调研 §3.4）。 */
const RRF_K = 60
/** 语义与 BM25 各取的条数。 */
const RECALL_PER_CHANNEL = 10
/** 注入条数。 */
const RECALL_TOP_N = 5
/** 衰减时间常数（天）。 */
const DECAY_DAYS = 30
/** 默认 embedding 请求超时（毫秒）。 */
const DEFAULT_EMBED_TIMEOUT_MS = 800
/** 默认 recall 整体预算（毫秒）——保障首 token 延迟。 */
const DEFAULT_RECALL_BUDGET_MS = 1_200
/** 重建向量是后台批量任务，预算与首 token 路径无关（沿用 800ms 必然写 0 条）。 */
const DEFAULT_REEMBED_TIMEOUT_MS = 30_000
/** 重建分片：单次请求条数，多数 embedding 端点有上限，整批塞进去容易被拒。 */
const REEMBED_BATCH = 64
/** 无 embedding 时文本判重扫描的窗口（每空间最近这么多条 active 记忆）。 */
const TEXT_DEDUPE_WINDOW = 200
/**
 * DECIDE 相似度兜底阈值：
 * - 候选与最相似旧记忆 < ADD_FORCE：判定为"没有真重复"，强制 ADD（不让 NOOP
 *   成为零成本默认，这是"用户说喜欢川菜被判 NOOP"的直接修复）；
 * - > NOOP_ALLOW：判定为重复，允许 NOOP 覆盖 ADD。
 * 中间区间保留模型判断。
 */
const ADD_FORCE_THRESHOLD = 0.7
const NOOP_ALLOW_THRESHOLD = 0.85

/** 供 AgentLoop 接入的薄接口（recall 同步组装前、enqueue 异步收尾）。 */
export interface AgentMemory {
  recall(agentId: string, inputText: string): Promise<string | undefined>
  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void
}

/**
 * 扇出召回的可选扩展面（由 {@link MemoryService} 实现）。
 *
 * 群聊一次 @ 多个成员时，各成员拿到的是**同一段输入**，对同一空间的召回结果
 * 本来就相同。调度器（@ryagent/group）检测到这个方法就用它，把 N 次
 * recall 收敛成一次；没有实现时逐成员 recall 也照旧工作（只是重复请求）。
 */
export interface MemoryRecallMany {
  recallMany(agentIds: readonly string[], inputText: string): Promise<Map<string, string | undefined>>
}

export interface MemoryServiceOptions {
  dbPath: string
  embeddings?: EmbeddingProvider
  llm?: MemoryLlm
  /** 注入行数上限（默认 5）。 */
  recallTopN?: number
  logger?: (message: string) => void
  /** 单次 embedding 网络请求超时（默认 800ms），超时降级纯 FTS5。 */
  embedTimeoutMs?: number
  /** recall 整体预算（默认 1200ms）：超预算则跳过本轮记忆注入，不阻塞首 token。 */
  recallBudgetMs?: number
  /** 向量重建单批超时（默认 30s）；与 recall 的 800ms 预算是两回事。 */
  reembedTimeoutMs?: number
  /** 向量重建分片大小（默认 64）。 */
  reembedBatchSize?: number
}

export class MemoryService implements AgentMemory, MemoryRecallMany {
  readonly store: MemoryStore
  private readonly embeddings: EmbeddingProvider
  private readonly llm: MemoryLlm | undefined
  private readonly topN: number
  private readonly log: (message: string) => void
  private readonly embedTimeoutMs: number
  private readonly recallBudgetMs: number
  private readonly reembedTimeoutMs: number
  private readonly reembedBatchSize: number
  /** 单 writer 队列。 */
  private queue: Promise<void> = Promise.resolve()
  /**
   * 在途 embedding 请求（键 = 模型 + 文本）：同一段输入的并发召回共享一次
   * 网络往返。
   *
   * 群聊扇出会同时问 N 个成员"这段输入是什么意思"，它们的查询串完全相同。
   * 落库缓存（embedding_cache）救不了并发——N 个请求在任何一个写回之前就都
   * 读到了未命中，于是同一段文本在一轮里被打成 N 次 embedding 请求。
   */
  private readonly inflightEmbeddings = new Map<string, Promise<Float32Array | null>>()

  constructor(options: MemoryServiceOptions) {
    this.store = new MemoryStore(options.dbPath)
    this.embeddings = options.embeddings ?? new NullEmbeddings()
    this.llm = options.llm
    this.topN = options.recallTopN ?? RECALL_TOP_N
    this.embedTimeoutMs = options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
    this.recallBudgetMs = options.recallBudgetMs ?? DEFAULT_RECALL_BUDGET_MS
    this.reembedTimeoutMs = options.reembedTimeoutMs ?? DEFAULT_REEMBED_TIMEOUT_MS
    this.reembedBatchSize = options.reembedBatchSize ?? REEMBED_BATCH
    this.log =
      options.logger ??
      ((message) => {
        console.log(message)
      })
  }

  get embeddingsAvailable(): boolean {
    return this.embeddings.available
  }

  /** 当前 embedding 模型标识（向量身份；检索时按它过滤，避免跨模型混库）。 */
  get embeddingModel(): string {
    return embeddingModelOf(this.embeddings)
  }

  close(): void {
    this.store.close()
  }

  // ---- 检索 ----

  /**
   * 召回并格式化注入块：共享画像全量 + 相关记忆 top-N。
   * @returns 注入文本；无记忆时返回 undefined（不注入空块）。
   */
  async recall(agentId: string, inputText: string): Promise<string | undefined> {
    const context = await this.recallContext(inputText, true)
    return this.formatRecall(context, agentId)
  }

  /**
   * 一次扇出里的多成员召回（群聊 @ 多成员）：同一段输入的查询向量、共享画像与
   * BM25 候选窗口只取一次，各成员只补自己的私有空间。
   *
   * 命中的记忆与逐成员 {@link recall} 是同一批（同一段输入、同一个查询向量、
   * 同一份 BM25 窗口、同样的融合与衰减配方），省下的是 N-1 次重复检索与 N-1 次
   * embedding 网络往返。两处可观察的差别：共享画像的访问计数按「一次输入」记 1
   * 而不是「每个成员各记 1」；行序可能因两套数据的时间戳差几毫秒而在同分行间
   * 互换（衰减项所致，与召回集合无关）。
   */
  async recallMany(agentIds: readonly string[], inputText: string): Promise<Map<string, string | undefined>> {
    const context = await this.recallContext(inputText, true)
    const out = new Map<string, string | undefined>()
    for (const agentId of new Set(agentIds)) {
      out.set(agentId, this.formatRecall(context, agentId))
    }
    return out
  }

  /** 混合检索：embedding + BM25 → RRF(k=60) → 访问基准衰减 → top-N。 */
  async hybridRecall(agentId: string, input: string, limit = this.topN): Promise<MemoryRow[]> {
    return this.rankRecall(await this.recallContext(input, false), agentId, limit)
  }

  /**
   * 一段输入的召回上下文：与空间无关的那部分（向量、共享画像、共享空间的
   * 语义打分、BM25 候选窗口）在这里一次算完，供本空间的通道复用。
   *
   * `withProfile` 只给注入路径开：抽取管线里的相似查询不算「注入即访问」，
   * 否则每次抽取都把共享画像的 access_count 顶上去，归档判定就失真了。
   */
  private async recallContext(input: string, withProfile: boolean): Promise<RecallContext> {
    const budgetStart = Date.now()
    const text = input.trim()
    let profile: MemoryRow[] = []
    let budgetExceeded = false
    if (withProfile) {
      profile = this.store.listSharedProfile()
      if (profile.length > 0) {
        // 注入即访问：画像每轮都被读进 prompt，却从不计入访问统计，access_count
        // 恒为 0，巩固任务会把整批画像判成"长期零访问"直接归档——用户画像因此
        // 悄无声息地整体消失。
        this.store.touchAccess(
          profile.map((m) => {
            return m.id
          }),
        )
      }
      // 预算守卫：画像已超预算时直接注入画像就收尾（profile 量小，正常不会发生）。
      budgetExceeded = Date.now() - budgetStart > this.recallBudgetMs
    }

    let vector: Float32Array | null = null
    let sharedSemantic: ScoredMemory[] = []
    let ftsHits: { memory: MemoryRow; score: number }[] = []
    if (!budgetExceeded) {
      vector = await this.embedCached(text)
      if (vector !== null) {
        sharedSemantic = this.scoreSemantic(SHARED_SPACE, vector)
      }
      ftsHits = this.searchFtsChannel(text)
    }
    return { vector, profile, budgetExceeded, sharedSemantic, ftsHits }
  }

  /** 组装注入块并记账访问（共享画像已在上下文里记过一次）。 */
  private formatRecall(context: RecallContext, agentId: string): string | undefined {
    const sections: string[] = []
    if (context.profile.length > 0) {
      sections.push(
        `用户画像：\n${context.profile
          .map((m) => {
            return `- ${m.content}`
          })
          .join('\n')}`,
      )
    }
    if (!context.budgetExceeded) {
      const recalled = this.rankRecall(context, agentId)
      if (recalled.length > 0) {
        sections.push(
          `相关记忆：\n${recalled
            .map((m) => {
              return `- ${m.content}`
            })
            .join('\n')}`,
        )
        this.store.touchAccess(
          recalled.map((m) => {
            return m.id
          }),
        )
      }
    }
    if (sections.length === 0) return undefined
    return `[记忆] ${sections.join('\n')}`
  }

  /** 两通道融合 + 衰减 + top-N（RRF(k=60) 与访问基准衰减，配方见调研 §3.4）。 */
  private rankRecall(context: RecallContext, agentId: string, limit = this.topN): MemoryRow[] {
    const candidates = new Map<string, { memory: MemoryRow; rrf: number }>()
    const addRanked = (ranked: readonly MemoryRow[]): void => {
      ranked.forEach((memory, index) => {
        const entry = candidates.get(memory.id) ?? { memory, rrf: 0 }
        entry.rrf += 1 / (RRF_K + index + 1)
        candidates.set(memory.id, entry)
      })
    }

    if (context.vector !== null) {
      // 语义通道 = 私有空间 + 共享空间（共享部分在上下文里已算好，扇出内只算一次）。
      addRanked(
        [...this.scoreSemantic(agentId, context.vector), ...context.sharedSemantic]
          .sort((a, b) => {
            return b.score - a.score
          })
          .slice(0, RECALL_PER_CHANNEL)
          .map((hit) => {
            return hit.memory
          }),
      )
    }

    addRanked(
      context.ftsHits
        .filter((hit) => {
          return hit.memory.agentId === agentId || hit.memory.agentId === SHARED_SPACE
        })
        .slice(0, RECALL_PER_CHANNEL)
        .map((hit) => {
          return hit.memory
        }),
    )

    const now = Date.now()
    return [...candidates.values()]
      .map((entry) => {
        // 衰减基准是"最后一次被召回"而不是"最后一次写入"：两个月前写下但每周
        // 都被命中的稳定偏好不该被压到 e⁻²。命中即强化：accessCount 走对数
        // 增益，避免高频条目碾压其他维度。
        const lastSeen = entry.memory.lastAccessedAt > 0 ? entry.memory.lastAccessedAt : entry.memory.updatedAt
        const ageDays = Math.max(0, now - lastSeen) / 86_400_000
        const reinforced = 1 + Math.log1p(entry.memory.accessCount)
        return { memory: entry.memory, score: entry.rrf * Math.exp(-ageDays / DECAY_DAYS) * reinforced }
      })
      .sort((a, b) => {
        return b.score - a.score
      })
      .slice(0, limit)
      .map((hit) => {
        return hit.memory
      })
  }

  /**
   * 某空间的语义通道打分（余弦降序）。
   *
   * 只在同一向量空间内比较：模型不同或维度不符的向量一律排除，绝不让 cosine
   * 静默返回 -1 把检索质量拖垮（曾导致"换 embedding 模型即塌陷"）。
   */
  private scoreSemantic(spaceId: string, vector: Float32Array): ScoredMemory[] {
    const dimMismatch = new Set<string>()
    const scored = this.store
      .listSpaceEmbeddings(spaceId, this.embeddingModel)
      .filter((memory) => {
        if (memory.embedding === null) return false
        if (memory.embedding.length === vector.length) return true
        dimMismatch.add(memory.id)
        return false
      })
      .map((memory) => {
        return { memory, score: cosine(vector, memory.embedding as Float32Array) }
      })
      .sort((a, b) => {
        return b.score - a.score
      })
    if (dimMismatch.size > 0) {
      this.log(
        `@ryagent/memory: skipped ${dimMismatch.size} memories in "${spaceId}" whose embedding dim ` +
          `differs from model "${this.embeddingModel}"`,
      )
    }
    return scored
  }

  /**
   * BM25 通道单独兜住异常：词法通道坏了只丢它自己（降级纯语义或纯画像），
   * 绝不把 recall 整条抛出——共享画像每轮都在注入路径上，一起丢就是静默失忆。
   *
   * 候选窗口取自全库（空间过滤在调用侧），所以扇出里多个成员共用这一份。
   */
  private searchFtsChannel(input: string): { memory: MemoryRow; score: number }[] {
    try {
      return this.store.searchFtsHits(input, RECALL_PER_CHANNEL * 3)
    } catch (error) {
      this.log(
        `@ryagent/memory: FTS channel degraded to ${this.embeddings.available ? 'semantic-only' : 'no-results'}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  }

  /**
   * embedding + 按模型分桶的文本缓存 + 在途请求合并：相同文本不重复请求。
   *
   * 三层缺一不可：落库缓存挡住跨轮重复，在途合并挡住**同轮内**的并发重复
   * （扇出时 N 个成员同时问同一段输入，落库缓存那时谁都还没写回），超时降级
   * 纯 FTS5。
   */
  private async embedCached(text: string): Promise<Float32Array | null> {
    if (!this.embeddings.available) return null
    const model = this.embeddingModel
    const cached = this.store.cachedEmbedding(text, model)
    if (cached !== null) return cached
    const key = `${model}\u0000${text}`
    const inFlight = this.inflightEmbeddings.get(key)
    if (inFlight !== undefined) return inFlight
    const request = this.requestEmbedding(text, model)
    this.inflightEmbeddings.set(key, request)
    try {
      return await request
    } finally {
      this.inflightEmbeddings.delete(key)
    }
  }

  /** 单次 embedding 网络请求：超时返回 null（降级纯 FTS5），不回灌给调用方。 */
  private async requestEmbedding(text: string, model: string): Promise<Float32Array | null> {
    const vectors = await withTimeout(this.embeddings.embed([text]), this.embedTimeoutMs)
    const vector = vectors === null ? null : (vectors[0] ?? null)
    if (vector === null) {
      this.log(`@ryagent/memory: embedding timed out after ${this.embedTimeoutMs}ms, falling back to FTS-only`)
      return null
    }
    this.store.cacheEmbedding(text, vector, model)
    return vector
  }

  // ---- 向量索引重建 ----

  /**
   * 为存量记忆回填向量（换了 embedding 模型，或历史数据当初没配上向量）。
   *
   * 分片推进：每片重建完就已匹配不到"缺向量"的过滤条件，下一片自然取到下一批，
   * 数据量再大也不受单次请求条数限制。预算是后台预算（默认 30s），不能沿用
   * recall 的 800ms——真装下那条 800ms 必然超时，于是每片都写 0 条还"成功"返回。
   *
   * 返回值只数真正写进库的条数：端点不可用/超时导致整片没写成时如实停在已写条数
   * 并记日志，绝不用"处理过的条数"冒充"重建好的条数"。
   * @returns 实际写入向量的条数。
   */
  async reembedAll(limit = 500): Promise<number> {
    if (!this.embeddings.available) return 0
    const batchSize = Math.max(1, this.reembedBatchSize)
    let budget = Math.max(0, limit)
    let written = 0
    while (budget > 0) {
      const pending = this.store.listMissingEmbeddings(this.embeddingModel, Math.min(batchSize, budget))
      if (pending.length === 0) break
      const vectors = await this.embedBatch(
        pending.map((memory) => {
          return memory.content
        }),
        this.reembedTimeoutMs,
      )
      let wrote = 0
      for (const [index, memory] of pending.entries()) {
        const vector = vectors[index]
        if (vector === undefined || vector === null) continue
        this.store.setEmbedding(memory.id, vector, this.embeddingModel)
        wrote += 1
      }
      written += wrote
      budget -= pending.length
      if (wrote === 0) {
        this.log(
          `@ryagent/memory: reembed stalled at ${written} rows; embedding endpoint returned nothing ` +
            `(timeout or error), this batch and the rest are skipped`,
        )
        break
      }
    }
    return written
  }

  /**
   * 批量嵌入：逐条查（hash, model）缓存，未命中的合并成一次请求。
   * 重建动辄几百条，逐条发请求既慢又容易撞上单次超时。
   */
  private async embedBatch(
    texts: readonly string[],
    timeoutMs = this.embedTimeoutMs,
  ): Promise<Array<Float32Array | null>> {
    const model = this.embeddingModel
    const out: Array<Float32Array | null> = texts.map((text) => {
      return this.store.cachedEmbedding(text, model)
    })
    const misses = texts.filter((_text, index) => {
      return out[index] === null
    })
    if (misses.length === 0) return out
    const fetched = await withTimeout(this.embeddings.embed(misses), timeoutMs)
    if (fetched === null) {
      this.log(`@ryagent/memory: embedding batch timed out after ${timeoutMs}ms`)
      return out
    }
    const byText = new Map<string, Float32Array | null>(
      misses.map((text, index) => {
        return [text, fetched[index] ?? null]
      }),
    )
    return texts.map((text, index) => {
      if (out[index] !== null) return out[index] as Float32Array
      const vector = byText.get(text) ?? null
      if (vector !== null) this.store.cacheEmbedding(text, vector, model)
      return vector
    })
  }

  // ---- 抽取管线（异步） ----

  /**
   * 每轮对话结束后入队（绝不阻塞回复）。单 writer，失败重试一次后记日志。
   */
  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void {
    if (this.llm === undefined) return
    const text = turnText.trim()
    if (text.length === 0) return
    this.queue = this.queue.then(async () => {
      await this.runExtractionWithRetry(agentId, agentName, conversationId, text)
    })
  }

  /** 测试用：等队列排空。 */
  async flush(): Promise<void> {
    await this.queue
  }

  private async runExtractionWithRetry(
    agentId: string,
    agentName: string,
    conversationId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.runExtraction(agentId, agentName, conversationId, text)
    } catch (error) {
      this.log(
        `@ryagent/memory: extraction failed, retrying once: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        await this.runExtraction(agentId, agentName, conversationId, text)
      } catch (retryError) {
        this.log(
          `@ryagent/memory: extraction gave up: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        )
      }
    }
  }

  private async runExtraction(
    agentId: string,
    agentName: string,
    conversationId: string,
    turnText: string,
  ): Promise<void> {
    if (this.llm === undefined) return
    const candidates = await this.llm.extractFacts({ agentName, conversationText: turnText })
    for (const candidate of candidates) {
      const spaceId = candidate.scope === 'shared' ? SHARED_SPACE : agentId
      const similarRows = await this.hybridRecall(spaceId, candidate.text, RECALL_PER_CHANNEL)
      const similar = similarRows.map((memory) => {
        return { id: memory.id, content: memory.content }
      })
      const decided = await this.llm.decideOperations({ candidate, similar })
      const operations = await this.applySimilarityGuard(candidate, similarRows, decided)
      await this.applyOperations(spaceId, candidate, operations, conversationId)
    }
  }

  /**
   * NOOP 兜底：抽取器对"用户说喜欢川菜"这类闲聊偏好常年判 NOOP，而 NOOP 在
   * prompt 里是零成本默认选项。这里用相似度把决策拉回来——
   * 明显不像旧记忆 → 强制 ADD；几乎重复 → 才允许 NOOP。
   */
  private async applySimilarityGuard(
    candidate: CandidateFact,
    similar: readonly MemoryRow[],
    operations: readonly MemoryOperation[],
  ): Promise<readonly MemoryOperation[]> {
    if (similar.length === 0) {
      return operations.some((op) => {
        return op.action === 'NOOP'
      })
        ? [{ action: 'ADD', text: candidate.text }]
        : operations
    }
    const top = await this.topSimilarity(candidate.text, similar)
    const hasWrite = operations.some((op) => {
      return op.action !== 'NOOP'
    })
    if (top < ADD_FORCE_THRESHOLD) {
      // 没有真重复，但模型没写任何写操作 → 补一个 ADD（不改写模型已给的判断）。
      return hasWrite ? operations : [{ action: 'ADD', text: candidate.text }]
    }
    if (top > NOOP_ALLOW_THRESHOLD) {
      // 与旧记忆几乎重复：抹掉写入意图（UPDATE/DELETE 会无谓地改写旧记忆）。
      return [{ action: 'NOOP' }]
    }
    return operations
  }

  /** 候选与最相似旧记忆的相似度：同维向量走余弦，否则退化为 bigram Jaccard。 */
  private async topSimilarity(candidateText: string, similar: readonly MemoryRow[]): Promise<number> {
    const queryVector = await this.embedCached(candidateText)
    let best = 0
    for (const memory of similar) {
      const useVector =
        queryVector !== null && memory.embedding !== null && memory.embedding.length === queryVector.length
      const score = useVector
        ? cosine(queryVector, memory.embedding as Float32Array)
        : textSimilarity(candidateText, memory.content)
      if (score > best) best = score
    }
    return best
  }

  /**
   * 无 embedding 时的文本判重（写路径最后一道）。
   *
   * 纯 FTS5 安装里语义通道不存在，判重只剩 BM25 与 LLM 判定两道：换个说法
   * 的同一事实召回不到就直接 ADD，记忆库于是永久积累近重复。这里在写入前扫
   * 一遍本空间最近的 active 记忆，命中近重复就丢弃（有 embedding 时不做——
   * 余弦 + 相似度守卫已经在做同一件事）。
   */
  private isTextNearDuplicate(spaceId: string, text: string): boolean {
    if (this.embeddings.available) return false
    for (const memory of this.store.listActiveForAgent(spaceId, TEXT_DEDUPE_WINDOW)) {
      if (!textNearDuplicate(text, memory.content)) continue
      this.log(`@ryagent/memory: dropped near-duplicate memory in "${spaceId}": ${text}`)
      return true
    }
    return false
  }

  /** 应用四操作；UPDATE/DELETE 用 superseded 软删保历史（Zep 思路）。 */
  private async applyOperations(
    spaceId: string,
    candidate: CandidateFact,
    operations: readonly MemoryOperation[],
    conversationId: string,
  ): Promise<void> {
    const write = async (kind: MemoryKind, content: string, supersedesId?: string): Promise<void> => {
      const trimmed = content.trim()
      const embedding = await this.embedCached(trimmed)
      this.store.insert({
        agentId: spaceId,
        kind,
        content: trimmed,
        embedding,
        ...(embedding === null ? {} : { embeddingModel: this.embeddingModel }),
        sourceConversationId: conversationId,
        ...(supersedesId === undefined ? {} : { supersedesId }),
      })
    }

    let addConsumed = false
    for (const op of operations) {
      switch (op.action) {
        case 'ADD': {
          if (addConsumed) break
          addConsumed = true
          const text = (op.text ?? candidate.text).trim()
          if (this.isTextNearDuplicate(spaceId, text)) break
          await write(candidate.kind as MemoryKind, text)
          break
        }
        case 'UPDATE': {
          const existing = this.store.get(op.memoryId)
          if (existing === undefined || existing.status !== 'active' || existing.agentId !== spaceId) break
          this.store.supersede(op.memoryId, 'superseded')
          await write(existing.kind, op.newText, op.memoryId)
          break
        }
        case 'DELETE': {
          // 同 UPDATE：不得跨空间软删别的 agent（或共享画像）的记忆。
          const target = this.store.get(op.memoryId)
          if (target === undefined || target.status !== 'active' || target.agentId !== spaceId) break
          this.store.supersede(op.memoryId, 'superseded')
          break
        }
        case 'NOOP':
          break
      }
    }
  }
}

/** 语义通道的一行（记忆 + 与查询向量的余弦）。 */
interface ScoredMemory {
  memory: MemoryRow
  score: number
}

/**
 * 一段输入的召回上下文：与空间无关的那部分。
 *
 * 同一段输入被多个成员同时召回时（群聊扇出），向量、共享画像、共享空间的语义
 * 通道与 BM25 候选窗口都只算一次；各成员只补自己的私有空间。
 */
interface RecallContext {
  /** 查询向量（无 embedding 凭据或超时时为 null → 纯 BM25）。 */
  vector: Float32Array | null
  /** 共享画像（注入路径才有；抽取管线不读也不记访问）。 */
  profile: MemoryRow[]
  /** 已超 recall 预算：只注入画像，跳过两个检索通道。 */
  budgetExceeded: boolean
  /** 共享空间的语义通道（余弦降序）。 */
  sharedSemantic: ScoredMemory[]
  /** 全库 BM25 候选窗口（bm25 升序；空间过滤在调用侧）。 */
  ftsHits: { memory: MemoryRow; score: number }[]
}

/** Promise 超时包装：超时返回 null（embedding 降级纯 FTS5 路径用）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise.then((value) => {
      return value as T | null
    }),
    new Promise<null>((resolve) => {
      return setTimeout(() => {
        return resolve(null)
      }, timeoutMs)
    }),
  ])
}
