/**
 * MemoryService：检索管线（recall）+ 异步抽取管线（enqueueExtraction）。
 *
 * 首 token 路径：注入块分两段拿——{@link MemoryService.recallSync} 同步组装
 * （落库向量缓存 + FTS5，全程不 await），{@link MemoryService.recallRefine} 在
 * 开流之后把本轮 embedding 落进缓存，**并把这一轮真算出来的语义命中留在手上**，
 * 下一轮的同步召回把它当第三条通道并进 RRF。
 *
 * 为什么不能只落缓存：embedding_cache 的键是查询文本的 sha256，而真人对话里
 * 同一句输入不会原样出现第二次——只落缓存的语义通道，在线上等于不存在（只有
 * 用户复述同一句话时才命中），换模型/换 embedding 后的语义召回能力一并消失。
 * 回灌让语义通道的召回结果一定进过某一次注入块，只是晚一轮。
 *
 * 记忆按设计只是增强：词法通道全本地，语义通道是一次网络往返，两者的召回质量
 * 差距远小于一次网络往返在首 token 上留下的痕迹。await 路径
 * （{@link MemoryService.recall}）保留给抽取管线与不带同步入口的调用方，它的
 * deadline 是真的（recallBudgetMs 覆盖 embedding 等待，而不只是画像查询）。
 *
 * 检索配方（调研 §3.4）：输入 → embedding 余弦 top-10 + FTS5 BM25 top-10 →
 * RRF(k=60) 融合 → 时间衰减 exp(-Δdays/30)（下限 DECAY_FLOOR，见 rankRecall）
 * → top-5 注入；共享画像（'*shared*' 的 profile 类）全量注入。
 *
 * 抽取管线（调研 §1.2 mem0 式）：本轮 user+assistant 消息 → LLM 抽候选事实
 * （scope 路由：用户事实 → *shared*；互动经验 → agent 空间；每条带重要性
 * 档位，关键档不参与休眠归档）→ 每条候选按**纯相似度**查 top-10（不混衰减
 * 与增益，见 {@link MemoryService.similarForDecide}）→ LLM 四操作 →
 * UPDATE/DELETE 走 superseded 软删链。
 * 单 writer 异步队列，失败重试一次后记日志不炸主流程。
 * @module @ryharness/memory/service
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
/**
 * 回灌给下一轮的语义命中条数。
 *
 * 比语义通道本身的 top-10 保守：这些行是**上一句**输入算出来的，与本轮问题的
 * 相关性天然低一档，宁可少注入也别让过期相关性挤掉本轮该召回的记忆。
 */
const CARRIED_SEMANTIC_TOP_N = 3
/**
 * 回灌缓存的条目上限（按 agent 空间计）。
 *
 * 只是防长驻进程（桌面端常年不退出）里堆积快照：每条至多 3 行 MemoryRow，
 * 触顶时按插入顺序淘汰最旧的。
 */
const CARRIED_SEMANTIC_SPACES = 64
/**
 * 同步召回共享打分短窗缓存的条目上限（按输入文本计）。
 *
 * 一次群聊扇出只占一条（同一段输入），上限只防长驻进程里换着文本追问时
 * 无界堆积：条目随写代失效重算，触顶按插入序淘汰最旧的。
 */
const SYNC_SHARED_SPACES = 16
/** 衰减时间常数（天）。 */
const DECAY_DAYS = 30
/**
 * 衰减下限。无下限时早期关键事实的排序分随 e^(-Δdays/30) 趋零（100 天 ≈
 * 0.036），任何新近噪音都能压过它——而 RRF 的通道名次之间本就只差百分之
 * 十几。取 0.15（≈54 天后持平）：老记忆从此靠通道名次与召回增益竞争，而不是
 * 被时间清零。关键事实另有 importance≥3 的归档豁免（见 store 的 archiveDormant）。
 */
const DECAY_FLOOR = 0.15
/** 默认 embedding 请求超时（毫秒）。 */
const DEFAULT_EMBED_TIMEOUT_MS = 800
/** 默认 recall 整体预算（毫秒）——保障首 token 延迟。 */
const DEFAULT_RECALL_BUDGET_MS = 1_200
/**
 * 首 token 路径上 embedding 的 deadline（毫秒）。
 *
 * 记忆按设计只是增强：语义通道是一次网络往返，词法通道是本地 FTS5，两条通道
 * 的召回质量差距远小于一次 800ms 的首 token 延迟。这里给 150ms 是折中——比
 * 「本地命中缓存就 0ms、否则 150ms」的两段式更简单，比默认的 800ms 少得多。
 */
const DEFAULT_FIRST_TOKEN_DEADLINE_MS = 150
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

/**
 * 用户反馈在召回增益里的权重（与访问增益同量级）。
 *
 * 取 2：一次 👎 约等于三次「被检索到」。两者不是一回事——命中是检索的副产物（记忆
 * 与提问本来就相关），而 👎 是用户对着**这一轮的输出**下的判断，后者信息量更大。
 * 取 1 时它只值 0.69（不到一次命中），一条已被反复召回的错误记忆扣掉一次仍然保留
 * 四分之三的强化增益，等于没有刹车。
 *
 * 又不取更大：权重再高就成了单点否决——一次误伤（用户其实是在骂模型答得不好，不是
 * 说记忆错了）会让那条记忆再也召不回来，而用户并没有要求删掉它。
 */
const FEEDBACK_GAIN_WEIGHT = 2

/**
 * 召回增益：命中即强化，👎 即扣回。
 *
 * 这是「单向棘轮」唯一的刹车。此前只有 `1 + log1p(accessCount)` 一个单调不减的因子，
 * 于是任何错误记忆一旦被注入过就只会越来越稳——用户点了 👎 也听不见，每一轮召回
 * 反过来又给它加一次分。两项都取对数：反馈的边际价值随之递减，三次 👎 与三十次
 * 👎 的差别不该和一次与十次一样大。
 *
 * 下界取 0 而不是负数：增益为负会让排序被反向扭曲（RRF 分恒正），而「这条记忆
 * 退出竞争」正是用户点 👎 时想要的结果——它没被软删，只是排不进去了，随时能被 👍 拉回来。
 * @param counts - 记忆的三个计数；取形状而非整行，方便测试与 future 复用。
 * @returns 乘在 RRF 与衰减项上的增益系数，恒 ≥ 0。
 */
export function recallGain(counts: { accessCount: number; helpfulCount: number; harmfulCount: number }): number {
  const gain =
    1 +
    Math.log1p(counts.accessCount) +
    FEEDBACK_GAIN_WEIGHT * (Math.log1p(counts.helpfulCount) - Math.log1p(counts.harmfulCount))
  return gain > 0 ? gain : 0
}

/** 记忆 id 集合：按 agent 空间记住「上一轮注入了什么」，容量触顶按插入序淘汰。 */
type InjectionMap = Map<string, string[]>

/** 注入归因的条目上限（每个 agent 空间一条，触顶淘汰最久没刷新者）。 */
const INJECTION_SPACES = 64

/** 供 AgentLoop 接入的薄接口（recall 同步组装前、enqueue 异步收尾）。 */
export interface AgentMemory {
  recall(agentId: string, inputText: string): Promise<string | undefined>
  /**
   * 首 token 路径上的同步召回（AgentLoop 专用）：落库向量缓存 + FTS5，全程
   * 不 await。返回 undefined 表示没有可注入的记忆。
   */
  recallSync(agentId: string, inputText: string): string | undefined
  /**
   * 首 token 之后的补正：等本轮输入的向量落地，据此算出语义命中并留给**下一轮**
   * 的 {@link MemoryService.recallSync} 注入（见类注释：只落缓存的语义通道在线
   * 上等于不存在）。
   *
   * 刻意不组装注入块、也不记访问——两者都是同步召回已经做过的事，在这里再做
   * 一次只会让共享画像的访问计数凭空翻倍。
   * @returns 是否真的补到了向量（false = 超时或不可用，下一轮仍是纯 FTS5）。
   */
  recallRefine(agentId: string, inputText: string, deadlineMs?: number): Promise<boolean>
  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void
}

/**
 * 扇出召回的可选扩展面（由 {@link MemoryService} 实现）。
 *
 * 群聊一次 @ 多个成员时，各成员拿到的是**同一段输入**，对同一空间的召回结果
 * 本来就相同。调度器（@ryharness/group）检测到这个方法就用它，把 N 次
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
  /**
   * 首 token 路径上 embedding 的 deadline（默认 150ms）。超过就走纯 FTS5，
   * 在途请求继续跑并把向量写回缓存，下一轮的 {@link MemoryService.recallSync}
   * 直接命中语义通道。
   */
  firstTokenDeadlineMs?: number
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
  private readonly firstTokenDeadlineMs: number
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
  /**
   * 上一轮 {@link MemoryService.recallRefine} 算出的语义命中（键 = agent 空间）。
   *
   * 同步召回按输入文本取用一次即清空：语义结果必须在下一轮真的进注入块，否则
   * 首 token 路径上的语义通道等于没有。取用时按 id 回库复核 status——补正与
   * 下一次召回之间记忆可能被软删，注入一条已 superseded 的行比不注入更糟。
   */
  private readonly carriedSemantic = new Map<string, ScoredMemory[]>()
  /**
   * 同步召回的共享空间打分短窗缓存（键 = 输入文本）。
   *
   * 群聊扇出里 N 个成员各调一次 {@link MemoryService.recallSync}，而它们拿到
   * 的是**同一段输入**：同一个查询向量、同一份共享空间数据，打分结果必然
   * 相同——共享空间的矩阵扫描一轮只该做一次。条目按「文本 + 写代」判定
   * 复用：写代一变（抽取落库、编辑、跨连接提交）立即重算，复用窗口与数据
   * 一致性不冲突。各成员的**私有空间**不进这里，仍各扫各的。
   */
  private readonly syncSharedScored = new Map<string, { stamp: string; scored: ScoredMemory[] }>()
  /**
   * 每个 agent 空间「最近一次注入的记忆 id」。
   *
   * 用户点 👎 时要回答的问题是「刚才那一轮我看到了什么」，而召回钩子的契约只有
   * (agentId, inputText)，拿不到会话 id——所以归因只能按 agent 空间近似，与
   * EvolveService 的归因集合是同一类近似（它至少还带 conversationId）。
   * 空间内连续多轮对话共用一条记录：第 N 轮注入的集合覆盖第 N-1 轮，符合「用户是在
   * 对最近一条回复投票」的直觉。
   */
  private readonly lastInjected: InjectionMap = new Map()

  constructor(options: MemoryServiceOptions) {
    this.store = new MemoryStore(options.dbPath)
    this.embeddings = options.embeddings ?? new NullEmbeddings()
    this.llm = options.llm
    this.topN = options.recallTopN ?? RECALL_TOP_N
    this.embedTimeoutMs = options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
    this.recallBudgetMs = options.recallBudgetMs ?? DEFAULT_RECALL_BUDGET_MS
    this.reembedTimeoutMs = options.reembedTimeoutMs ?? DEFAULT_REEMBED_TIMEOUT_MS
    this.reembedBatchSize = options.reembedBatchSize ?? REEMBED_BATCH
    this.firstTokenDeadlineMs = options.firstTokenDeadlineMs ?? DEFAULT_FIRST_TOKEN_DEADLINE_MS
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
    const context = await this.recallContext(inputText, true, this.recallBudgetMs)
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
    const context = await this.recallContext(inputText, true, this.recallBudgetMs)
    const out = new Map<string, string | undefined>()
    for (const agentId of new Set(agentIds)) {
      out.set(agentId, this.formatRecall(context, agentId))
    }
    return out
  }

  /**
   * 首 token 路径上的**同步**召回：落库向量缓存 + FTS5 + 上一轮回灌的语义命中，
   * 全程不 await。
   *
   * 三条通道都只用本地读：当前查询的向量走 `embedding_cache`（上一轮补正已经
   * 把结果写在这里，仅当用户原样复述同一句输入才会命中），词法走 FTS5，语义走
   * 上一轮 {@link MemoryService.recallRefine} 回灌的命中。任何异常都静默降级成
   * 「无注入」——记忆是增强，它没有资格让一次对话变慢或失败。
   * @returns 注入文本；无可注入记忆时返回 undefined。
   */
  recallSync(agentId: string, inputText: string): string | undefined {
    try {
      const text = inputText.trim()
      const vector = this.embeddings.available ? this.store.cachedEmbedding(text, this.embeddingModel) : null
      const profile = this.store.listSharedProfile()
      return this.formatRecall(
        {
          vector,
          profile,
          budgetExceeded: false,
          sharedSemantic: this.sharedSemanticSync(text, vector),
          ftsHits: this.searchFtsChannel(text),
          carried: this.takeCarriedSemantic(agentId),
          pendingTouch: profile.map((m) => {
            return m.id
          }),
        },
        agentId,
      )
    } catch (error) {
      this.log(
        `@ryharness/memory: sync recall degraded to no-injection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return undefined
    }
  }

  /**
   * 共享空间的同步打分（带短窗缓存）：同一段输入在写代未变时直接复用上一份。
   *
   * stamp 顺手透传给 scoreSemantic——同一同步链上桶校验与缓存键共用一次
   * PRAGMA 读取，扇出的 N 个成员没有谁为共享打分多付 SQL。
   */
  private sharedSemanticSync(text: string, vector: Float32Array | null): ScoredMemory[] {
    if (vector === null) return []
    const stamp = this.store.embeddingStamp()
    const cached = this.syncSharedScored.get(text)
    if (cached !== undefined && cached.stamp === stamp) return cached.scored
    const scored = this.scoreSemantic(SHARED_SPACE, vector, stamp)
    // 先删后插：同一段输入连续召回靠它刷新插入序，淘汰的仍是"最久没召回"。
    this.syncSharedScored.delete(text)
    this.syncSharedScored.set(text, { stamp, scored })
    while (this.syncSharedScored.size > SYNC_SHARED_SPACES) {
      const oldest = this.syncSharedScored.keys().next()
      if (oldest.done === true) break
      this.syncSharedScored.delete(oldest.value)
    }
    return scored
  }

  /**
   * 首 token 之后的补正：等本轮输入的向量落地，据此算出语义通道命中并留给
   * **下一轮**的 {@link MemoryService.recallSync}。
   *
   * 只落 embedding 缓存是不够的（缓存键是查询文本原样，真人对话里同一句话不会
   * 说第二遍），所以这里顺手把这一轮真算出来的语义命中留在手上；它按 agent
   * 空间隔离，扇出时各成员各留各的。
   *
   * 刻意不组装注入块、也不记访问——两者都是同步召回已经做过的事，在这里再做
   * 一次只会让共享画像的访问计数凭空翻倍。
   * @returns 是否真的补到了向量（false = 超时或不可用，下一轮仍是纯 FTS5）。
   */
  async recallRefine(agentId: string, inputText: string, deadlineMs = this.firstTokenDeadlineMs): Promise<boolean> {
    if (!this.embeddings.available) return false
    try {
      const vector = await this.embedCached(inputText.trim(), deadlineMs)
      if (vector === null) return false
      this.carrySemantic(agentId, vector)
      return true
    } catch {
      return false
    }
  }

  /** 把这一轮的语义通道命中留给下一轮（按空间隔离，触顶淘汰最旧）。 */
  private carrySemantic(agentId: string, vector: Float32Array): void {
    const shared = this.scoreSemantic(SHARED_SPACE, vector)
    const scored = [...(agentId === SHARED_SPACE ? [] : this.scoreSemantic(agentId, vector)), ...shared]
      .sort((a, b) => {
        return b.score - a.score
      })
      .slice(0, CARRIED_SEMANTIC_TOP_N)
    // 先删后插：同一个空间连续多轮补正时靠它刷新插入序，淘汰的仍是"最久没回灌"。
    this.carriedSemantic.delete(agentId)
    if (scored.length === 0) return
    this.carriedSemantic.set(agentId, scored)
    while (this.carriedSemantic.size > CARRIED_SEMANTIC_SPACES) {
      const oldest = this.carriedSemantic.keys().next()
      if (oldest.done === true) break
      this.carriedSemantic.delete(oldest.value)
    }
  }

  /** 取走某空间回灌的语义命中（一次性），并回库复核它们是否仍然 active。 */
  private takeCarriedSemantic(agentId: string): ScoredMemory[] {
    const carried = this.carriedSemantic.get(agentId)
    if (carried === undefined) return []
    this.carriedSemantic.delete(agentId)
    const out: ScoredMemory[] = []
    for (const hit of carried) {
      const row = this.store.get(hit.memory.id)
      if (row === undefined || row.status !== 'active') continue
      if (row.agentId !== agentId && row.agentId !== SHARED_SPACE) continue
      out.push({ memory: row, score: hit.score })
    }
    return out
  }

  /** 混合检索：embedding + BM25 → RRF(k=60) → 访问基准衰减 → top-N。 */
  async hybridRecall(agentId: string, input: string, limit = this.topN): Promise<MemoryRow[]> {
    return this.rankRecall(await this.recallContext(input, false, this.recallBudgetMs), agentId, limit)
  }

  /**
   * 一段输入的召回上下文：与空间无关的那部分（向量、共享画像、共享空间的
   * 语义打分、BM25 候选窗口）在这里一次算完，供本空间的通道复用。
   *
   * `withProfile` 只给注入路径开：抽取管线里的相似查询不算「注入即访问」，
   * 否则每次抽取都把共享画像的 access_count 顶上去，归档判定就失真了。
   *
   * `deadlineMs` 是这次检索的**整体**预算，`embedCached` 在它之内再 race 一次
   * ——原先 recallBudgetMs 只量了画像查询之后的那个同步点就再也不看，
   * 真正兜底的是 embedTimeoutMs=800，于是最坏 800ms 的纯等待发生在首 token
   * 之前，而记忆按设计只是增强。
   */
  private async recallContext(input: string, withProfile: boolean, deadlineMs: number): Promise<RecallContext> {
    const budgetStart = Date.now()
    const text = input.trim()
    let profile: MemoryRow[] = []
    let budgetExceeded = false
    if (withProfile) {
      profile = this.store.listSharedProfile()
      // 预算守卫：画像已超预算时直接注入画像就收尾（profile 量小，正常不会发生）。
      budgetExceeded = Date.now() - budgetStart > deadlineMs
    }

    let vector: Float32Array | null = null
    let sharedSemantic: ScoredMemory[] = []
    let ftsHits: { memory: MemoryRow; score: number }[] = []
    if (!budgetExceeded) {
      vector = await this.embedCached(text, Math.max(0, deadlineMs - (Date.now() - budgetStart)))
      if (vector !== null) {
        sharedSemantic = this.scoreSemantic(SHARED_SPACE, vector)
      }
      ftsHits = this.searchFtsChannel(text)
    }
    // 画像的访问记账不在这里发：与本轮检索命中合成一条 UPDATE（逐 id UPDATE
    // 各带隐式事务，扇出里还会重复记账）。
    return {
      vector,
      profile,
      budgetExceeded,
      sharedSemantic,
      ftsHits,
      carried: [],
      pendingTouch: profile.map((m) => {
        return m.id
      }),
    }
  }

  /** 组装注入块并记账访问（共享画像也在这里，一次性计入 pendingTouch）。 */
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
        for (const memory of recalled) context.pendingTouch.push(memory.id)
      }
    }
    // 取出即清空：扇出里多个成员共用同一份上下文，画像的访问计数按「一次输入」
    // 记 1，而不是「每个成员各记 1」。
    const pending = context.pendingTouch
    context.pendingTouch = []
    this.store.touchAccess(pending)
    // 归因记的是**这一轮真正出现在注入块里**的那些：画像 + 检索命中。
    // 注入块为 undefined（无记忆可注入）时清掉该空间的归因而不是保留上一轮——
    // 否则用户对着一句没注入任何记忆的回复点 👎，会罚到上一轮的头上。
    this.rememberInjection(agentId, sections.length === 0 ? [] : pending)
    if (sections.length === 0) return undefined
    return `[记忆] ${sections.join('\n')}`
  }

  /** 记「这个空间最近一轮注入了什么」，供 recordFeedback 归因；触顶淘汰最旧者。 */
  private rememberInjection(agentId: string, ids: readonly string[]): void {
    // 先删后插：同一个空间连续多轮靠它刷新插入序，淘汰的仍是"最久没注入过"。
    this.lastInjected.delete(agentId)
    if (ids.length > 0) this.lastInjected.set(agentId, [...ids])
    while (this.lastInjected.size > INJECTION_SPACES) {
      const oldest = this.lastInjected.keys().next()
      if (oldest.done === true) break
      this.lastInjected.delete(oldest.value)
    }
  }

  /**
   * 用户反馈回灌：👍 / 👎 落到该 agent 空间最近一轮注入的记忆上。
   *
   * 这是记忆侧唯一的**反向信号**通路。没有它时 recall 是单向棘轮：命中即加权、
   * 没有东西能减，一条被注入过的错误记忆只会随着每次召回越来越稳（详见
   * {@link recallGain}）。
   *
   * 归因是「该空间最近一次注入的集合」而不是逐轮精确记录：召回钩子的契约只有
   * (agentId, inputText)，拿不到 conversationId。这与 EvolveService 的归因是同一类
   * 近似，误差同源、可接受；真要逐轮精确需要改 AgentMemory 契约（动 packages/agent）。
   *
   * 命中集合里可能含已被软删/归档的行（它们注入时还是 active，之后才被改状态）：
   * applyFeedback 只累加计数，不改状态，因此历史记忆的反馈也不会丢。
   * @returns 实际记上信号的记忆条数（没有可归因的注入时为 0）。
   */
  recordFeedback(input: { agentId: string; signal: 'thumb_up' | 'thumb_down' }): number {
    const ids = this.lastInjected.get(input.agentId)
    if (ids === undefined || ids.length === 0) return 0
    return this.store.applyFeedback(ids, input.signal)
  }

  /** 该空间最近一轮注入的记忆 id（观测与评测用；返回副本）。 */
  lastInjectedIds(agentId: string): readonly string[] {
    return [...(this.lastInjected.get(agentId) ?? [])]
  }

  /**
   * 就地编辑一条 active 记忆的内容（用户在记忆面板上改过时事实）。
   *
   * 存储层换内容与 FTS 索引行（updateContent），这里补上语义通道：旧向量对应
   * 旧内容，不重算的话这条记忆在余弦检索里永远"说旧话"——词法改对了、语义
   * 还在学错的。向量身份与 {@link reembedAll} 同一套（带 this.embeddingModel），
   * 换过模型也不会把编辑写成混库向量。
   *
   * 嵌入失败不阻塞编辑：catch 后记日志返回已保存的行，这条记忆暂时只剩
   * BM25 通道可按新内容召回（与超时降级纯 FTS5 是同款语义，且下一次 reembed
   * 或本方法再次编辑时自愈）。
   * @returns 更新后的行；不存在或非 active 返回 undefined（由调用方决定 404）。
   */
  async updateMemory(id: string, content: string): Promise<MemoryRow | undefined> {
    const row = this.store.updateContent(id, content)
    if (row === undefined) return undefined
    if (this.embeddings.available) {
      try {
        const vector = await this.embedCached(row.content)
        if (vector !== null) this.store.setEmbedding(row.id, vector, this.embeddingModel)
      } catch (error) {
        this.log(
          `@ryharness/memory: memory edited but embedding refresh failed (FTS-only until next reembed): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return this.store.get(row.id) ?? row
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

    // 回灌通道：上一轮输入算出的语义命中，作为独立一条通道并进 RRF 而不是直接
    // 塞进结果——它与本轮两个通道是同一条式子的证据，混进去才能参与衰减与
    // top-N 竞争，而不是无视本轮问题强行注入。与当前查询向量命中同一 id 时
    // 两路分数相加（RRF 的定义），不会互相抵消。
    if (context.carried.length > 0) {
      addRanked(
        context.carried.map((hit) => {
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
    return (
      [...candidates.values()]
        .map((entry) => {
          // 衰减基准是"最后一次被召回"而不是"最后一次写入"：两个月前写下但每周
          // 都被命中的稳定偏好不该被压到 e⁻²。命中即强化：accessCount 走对数
          // 增益，避免高频条目碾压其他维度；👎 从同一项里扣回（recallGain），
          // 否则一次注入就足以让错误记忆此后每轮加分、永不沉底。
          const lastSeen = entry.memory.lastAccessedAt > 0 ? entry.memory.lastAccessedAt : entry.memory.updatedAt
          const ageDays = Math.max(0, now - lastSeen) / 86_400_000
          const reinforced = recallGain(entry.memory)
          // 衰减带上限下限（见 DECAY_FLOOR）：时间只把老记忆压到「与通道名次
          // 同量级」，不负责把它清零——清零是 👎 增益（recallGain 下界 0）的
          // 职责，两个维度不该互相越权。
          const decay = Math.max(Math.exp(-ageDays / DECAY_DAYS), DECAY_FLOOR)
          return { memory: entry.memory, score: entry.rrf * decay * reinforced }
        })
        // 增益归零（👎 净额压过命中与基线）的候选直接退出竞争：排序分恒乘出 0，
        // 占一个 top-N 名额只会挤出还有正分的记忆——「排不进去」是 recallGain
        // 下界承诺的语义（行没被软删，👍 拉回净值后自动回来），不在候选层兜底
        // 它就会在候选池小的时候无限期占坑。
        .filter((hit) => {
          return hit.score > 0
        })
        .sort((a, b) => {
          return b.score - a.score
        })
        .slice(0, limit)
        .map((hit) => {
          return hit.memory
        })
    )
  }

  /**
   * 某空间的语义通道打分（余弦降序）。
   *
   * 打分在空间桶的堆叠矩阵上单趟完成：逐行 cosine 的热路径上每行都要一次
   * 函数调用、一次 `embedding` 属性访问与两次长度检查，而这些全都跑在与流式
   * 输出共享的事件循环上；矩阵把向量字节连续排布后，内层只剩局部变量上的
   * 乘加。乘法对 IEEE 双精逐位可交换、加法按同一顺序累计，分数与逐行 cosine
   * 完全一致，排序（稳定）与召回集合不因数据结构改变。
   *
   * 只在同一向量空间内比较：模型不同或维度不符的向量一律排除，绝不让 cosine
   * 静默返回 -1 把检索质量拖垮（曾导致"换 embedding 模型即塌陷"）。
   *
   * `stamp` 供同步调用链复用写代：同一链上已读过一次就不为桶校验再付 PRAGMA。
   */
  private scoreSemantic(spaceId: string, vector: Float32Array, stamp?: string): ScoredMemory[] {
    const dim = vector.length
    const { rows, data, offsets, dims } = this.store.spaceEmbeddingMatrix(spaceId, this.embeddingModel, stamp)
    const scored: ScoredMemory[] = []
    let mismatched = 0
    for (let index = 0; index < rows.length; index++) {
      if (dims[index] !== dim) {
        mismatched += 1
        continue
      }
      let dot = 0
      const base = offsets[index]
      for (let axis = 0; axis < dim; axis++) {
        dot += data[base + axis] * vector[axis]
      }
      scored.push({ memory: rows[index], score: dot })
    }
    scored.sort((a, b) => {
      return b.score - a.score
    })
    if (mismatched > 0) {
      this.log(
        `@ryharness/memory: skipped ${mismatched} memories in "${spaceId}" whose embedding dim ` +
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
        `@ryharness/memory: FTS channel degraded to ${this.embeddings.available ? 'semantic-only' : 'no-results'}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  }

  /**
   * embedding + 按模型分桶的文本缓存 + 在途请求合并 + 真正的 deadline race。
   *
   * 三层缓存缺一不可：落库缓存挡住跨轮重复，在途合并挡住**同轮内**的并发重复
   * （扇出时 N 个成员同时问同一段输入，落库缓存那时谁都还没写回）。
   *
   * deadline 是调用方给的**剩余**预算，通常比单次请求超时短（首 token 路径
   * 只要 150ms）。超时就返回 null 降级纯 FTS5；在途请求继续跑完并把向量写回
   * 缓存——所以「等不到」不等于「白等一次」。
   * @param deadlineMs - 本次可等待的毫秒数；0 表示只吃已落库的缓存。
   */
  private async embedCached(text: string, deadlineMs = this.embedTimeoutMs): Promise<Float32Array | null> {
    if (!this.embeddings.available) return null
    const model = this.embeddingModel
    const cached = this.store.cachedEmbedding(text, model)
    if (cached !== null) return cached
    const key = `${model}\u0000${text}`
    const inFlight = this.inflightEmbeddings.get(key)
    const request = inFlight ?? this.requestEmbedding(text, model)
    if (inFlight === undefined) this.inflightEmbeddings.set(key, request)
    try {
      return await withTimeout(request, Math.max(0, deadlineMs))
    } finally {
      if (inFlight === undefined) this.inflightEmbeddings.delete(key)
    }
  }

  /** 单次 embedding 网络请求：超时返回 null（降级纯 FTS5），不回灌给调用方。 */
  private async requestEmbedding(text: string, model: string): Promise<Float32Array | null> {
    const vectors = await withTimeout(this.embeddings.embed([text]), this.embedTimeoutMs)
    const vector = vectors === null ? null : (vectors[0] ?? null)
    if (vector === null) {
      this.log(`@ryharness/memory: embedding timed out after ${this.embedTimeoutMs}ms, falling back to FTS-only`)
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
          `@ryharness/memory: reembed stalled at ${written} rows; embedding endpoint returned nothing ` +
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
      this.log(`@ryharness/memory: embedding batch timed out after ${timeoutMs}ms`)
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
        `@ryharness/memory: extraction failed, retrying once: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        await this.runExtraction(agentId, agentName, conversationId, text)
      } catch (retryError) {
        this.log(
          `@ryharness/memory: extraction gave up: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
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
      const similarRows = await this.similarForDecide(spaceId, candidate.text, RECALL_PER_CHANNEL)
      const similar = similarRows.map((memory) => {
        return { id: memory.id, content: memory.content }
      })
      const decided = await this.llm.decideOperations({ candidate, similar })
      const operations = await this.applySimilarityGuard(candidate, similarRows, decided)
      await this.applyOperations(spaceId, candidate, operations, conversationId)
    }
  }

  /**
   * DECIDE 阶段的相似旧记忆：按**纯相似度**取，不走注入路径的衰减与反馈增益。
   *
   * 衰减与增益回答的是「这一轮该想起什么」；DECIDE 要回答的是「这条候选该
   * 改写/取代哪条旧记忆」。混入时间权重时，三个月前写入、零访问的旧事实
   * （衰减 e⁻³）排不进 top-10，排进去的是新近但语义无关的行——模型拿到的
   * memoryId 列表本身就是错靶：UPDATE 改写错误目标、真重复永久遗留。mem0 与
   * Hy-Memory 的 update 路径都按与新事实的相似度检索，不混时间/访问权重。
   *
   * 候选集合沿用注入路径的口径（本空间 + 共享画像）；纯 FTS5 安装退到无衰减
   * 的 BM25 候选窗口。
   */
  private async similarForDecide(spaceId: string, text: string, limit: number): Promise<MemoryRow[]> {
    const vector = await this.embedCached(text)
    if (vector !== null) {
      const scored = [
        ...this.scoreSemantic(spaceId, vector),
        ...(spaceId === SHARED_SPACE ? [] : this.scoreSemantic(SHARED_SPACE, vector)),
      ]
        .sort((a, b) => {
          return b.score - a.score
        })
        .slice(0, limit)
        .map((hit) => {
          return hit.memory
        })
      if (scored.length > 0) return scored
    }
    return this.store
      .searchFtsHits(text, limit * 3)
      .filter((hit) => {
        return hit.memory.agentId === spaceId || hit.memory.agentId === SHARED_SPACE
      })
      .slice(0, limit)
      .map((hit) => {
        return hit.memory
      })
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
      // 与旧记忆几乎重复：ADD 是重复写入，拦下。但 UPDATE/DELETE 恰恰以「词面
      // 相近」为前提——矛盾事实（「不再吃辣」vs「喜欢吃辣」）的余弦普遍 >0.85，
      // 一刀切 NOOP 等于把用户的每次纠错永远挡在库外。结构性改写原样放行。
      const structural = operations.filter((op) => {
        return op.action === 'UPDATE' || op.action === 'DELETE'
      })
      if (structural.length > 0) return structural
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
      this.log(`@ryharness/memory: dropped near-duplicate memory in "${spaceId}": ${text}`)
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
    const write = async (
      kind: MemoryKind,
      content: string,
      importance: number,
      supersedesId?: string,
    ): Promise<void> => {
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
        importance,
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
          await write(candidate.kind as MemoryKind, text, candidate.importance)
          break
        }
        case 'UPDATE': {
          const existing = this.store.get(op.memoryId)
          if (existing === undefined || existing.status !== 'active' || existing.agentId !== spaceId) break
          this.store.supersede(op.memoryId, 'superseded')
          // UPDATE 是同一事实的演进，重要档取两侧最大：旧档不因改写而降级
          // （legacy 行是 1，被细化成关键事实时允许升档）。
          await write(existing.kind, op.newText, Math.max(existing.importance, candidate.importance), op.memoryId)
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
  /**
   * 上一轮 {@link MemoryService.recallRefine} 回灌的语义通道命中：首 token 路径
   * 上真正的语义证据只在 await 路径才有，这是它唯一的去处（await 路径恒为空）。
   */
  carried: ScoredMemory[]
  /**
   * 待记访问的行：共享画像先入，检索命中在组装注入块时补。组装时合成一条
   * UPDATE 发出并清空，所以扇出里多个成员共用这一份上下文也只记一次。
   */
  pendingTouch: string[]
}

/**
 * Promise 超时包装：超时返回 null（embedding 降级纯 FTS5 路径用）。
 *
 * 定时器必须清理：否则每轮召回都在事件循环上留一个挂起的句柄——扇出 N 个
 * 成员就留 N 个，进程也退不出去。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(null)
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
