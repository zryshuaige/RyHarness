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
import { cosine, NullEmbeddings } from './embeddings.ts'
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

  /** 混合检索：embedding + BM25 → RRF(k=60) → 衰减 → top-N。 */
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
      const semantic = this.store
        .listActiveEmbeddings(agentId)
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
      addRanked(semantic)
    }

    addRanked(this.store.searchFts(agentId, input, RECALL_PER_CHANNEL))

    const now = Date.now()
    return [...candidates.values()]
      .map((entry) => {
        const ageDays = (now - entry.memory.updatedAt) / 86_400_000
        const decayed = entry.rrf * Math.exp(-ageDays / DECAY_DAYS)
        return { memory: entry.memory, score: decayed }
      })
      .sort((a, b) => {
        return b.score - a.score
      })
      .slice(0, limit)
      .map((hit) => {
        return hit.memory
      })
  }

  /** embedding + 文本缓存：相同文本不重复请求；网络请求带超时，超时降级纯 FTS5。 */
  private async embedCached(text: string): Promise<Float32Array | null> {
    if (!this.embeddings.available) return null
    const cached = this.store.cachedEmbedding(text)
    if (cached !== null) return cached
    const vectors = await withTimeout(this.embeddings.embed([text]), this.embedTimeoutMs)
    const vector = vectors === null ? null : (vectors[0] ?? null)
    if (vector !== null) this.store.cacheEmbedding(text, vector)
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
      const similar = (await this.hybridRecall(spaceId, candidate.text, RECALL_PER_CHANNEL)).map((memory) => {
        return { id: memory.id, content: memory.content }
      })
      const operations = await this.llm.decideOperations({ candidate, similar })
      await this.applyOperations(spaceId, candidate, operations, conversationId)
    }
  }

  /** 应用四操作；UPDATE/DELETE 用 superseded 软删保历史（Zep 思路）。 */
  private async applyOperations(
    spaceId: string,
    candidate: CandidateFact,
    operations: readonly MemoryOperation[],
    conversationId: string,
  ): Promise<void> {
    let addConsumed = false
    for (const op of operations) {
      switch (op.action) {
        case 'ADD': {
          if (addConsumed) break
          addConsumed = true
          this.store.insert({
            agentId: spaceId,
            kind: candidate.kind as MemoryKind,
            content: (op.text ?? candidate.text).trim(),
            embedding: await this.embedCached(candidate.text),
            sourceConversationId: conversationId,
          })
          break
        }
        case 'UPDATE': {
          const existing = this.store.get(op.memoryId)
          if (existing === undefined || existing.status !== 'active' || existing.agentId !== spaceId) break
          this.store.supersede(op.memoryId, 'superseded')
          this.store.insert({
            agentId: spaceId,
            kind: existing.kind,
            content: op.newText.trim(),
            embedding: await this.embedCached(op.newText),
            sourceConversationId: conversationId,
            supersedesId: op.memoryId,
          })
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
