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
import { cosine, embeddingModelOf, NullEmbeddings, textSimilarity } from './embeddings.ts'
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
}

export class MemoryService implements AgentMemory {
  readonly store: MemoryStore
  private readonly embeddings: EmbeddingProvider
  private readonly llm: MemoryLlm | undefined
  private readonly topN: number
  private readonly log: (message: string) => void
  private readonly embedTimeoutMs: number
  private readonly recallBudgetMs: number
  /** 单 writer 队列。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: MemoryServiceOptions) {
    this.store = new MemoryStore(options.dbPath)
    this.embeddings = options.embeddings ?? new NullEmbeddings()
    this.llm = options.llm
    this.topN = options.recallTopN ?? RECALL_TOP_N
    this.embedTimeoutMs = options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
    this.recallBudgetMs = options.recallBudgetMs ?? DEFAULT_RECALL_BUDGET_MS
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
    const budgetStart = Date.now()
    const text = inputText.trim()
    const sections: string[] = []

    const profile = this.store.listSharedProfile()
    if (profile.length > 0) {
      sections.push(
        `用户画像：\n${profile
          .map((m) => {
            return `- ${m.content}`
          })
          .join('\n')}`,
      )
    }

    // 预算守卫：画像已超预算时直接返回（profile 量小，正常不会发生）。
    if (Date.now() - budgetStart > this.recallBudgetMs) {
      return sections.length > 0 ? `[记忆] ${sections.join('\n')}` : undefined
    }

    const recalled = await this.hybridRecall(agentId, text)
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

    if (sections.length === 0) return undefined
    return `[记忆] ${sections.join('\n')}`
  }

  /** 混合检索：embedding + BM25 → RRF(k=60) → 访问基准衰减 → top-N。 */
  async hybridRecall(agentId: string, input: string, limit = this.topN): Promise<MemoryRow[]> {
    const queryVector = await this.embedCached(input)
    const candidates = new Map<string, { memory: MemoryRow; rrf: number }>()

    const addRanked = (ranked: MemoryRow[]): void => {
      ranked.forEach((memory, index) => {
        const entry = candidates.get(memory.id) ?? { memory, rrf: 0 }
        entry.rrf += 1 / (RRF_K + index + 1)
        candidates.set(memory.id, entry)
      })
    }

    if (queryVector !== null) {
      // 只在同一向量空间内比较：模型不同或维度不符的向量一律排除，绝不让
      // cosine 静默返回 -1 把检索质量拖垮（曾导致"换 embedding 模型即塌陷"）。
      const dimMismatch = new Set<string>()
      const semantic = this.store
        .listActiveEmbeddings(agentId, this.embeddingModel)
        .filter((memory) => {
          if (memory.embedding === null) return false
          if (memory.embedding.length === queryVector.length) return true
          dimMismatch.add(memory.id)
          return false
        })
        .map((memory) => {
          return { memory, score: cosine(queryVector, memory.embedding as Float32Array) }
        })
        .sort((a, b) => {
          return b.score - a.score
        })
        .slice(0, RECALL_PER_CHANNEL)
        .map((hit) => {
          return hit.memory
        })
      if (dimMismatch.size > 0) {
        this.log(
          `@ryagent/memory: skipped ${dimMismatch.size} memories whose embedding dim differs from model "${this.embeddingModel}"`,
        )
      }
      addRanked(semantic)
    }

    addRanked(this.store.searchFts(agentId, input, RECALL_PER_CHANNEL))

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

  /** embedding + 按模型分桶的文本缓存：相同文本不重复请求；网络请求带超时，超时降级纯 FTS5。 */
  private async embedCached(text: string): Promise<Float32Array | null> {
    if (!this.embeddings.available) return null
    const model = this.embeddingModel
    const cached = this.store.cachedEmbedding(text, model)
    if (cached !== null) return cached
    const vectors = await withTimeout(this.embeddings.embed([text]), this.embedTimeoutMs)
    const vector = vectors === null ? null : (vectors[0] ?? null)
    if (vector !== null) this.store.cacheEmbedding(text, vector, model)
    else this.log(`@ryagent/memory: embedding timed out after ${this.embedTimeoutMs}ms, falling back to FTS-only`)
    return vector
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
          await write(candidate.kind as MemoryKind, op.text ?? candidate.text)
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
