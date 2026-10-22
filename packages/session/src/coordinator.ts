/**
 * SessionCoordinator：把 AgentLoop / GroupDispatcher 的事件流自动落成
 * messages 行，多轮对话从 store 恢复历史，群聊调度链的失败语义保证
 * "已完成的 agent 发言保留，错误以 system 消息落库，不留半成品发言"。
 *
 * 事务边界：LLM 调用是异步且耗时的，不能在跨 await 的整链上持有 SQLite
 * 事务；改为"每条完成的发言一个写入单元"——assistant 发言与其工具结果
 * 消息逐条落库（每条自身原子），错误以 system 消息收尾。半成品定义上
 * 不存在：assistant 消息只在流正常组装完成后写入。
 *
 * 取消：RunContext.signal 透传给 AgentLoop / GroupDispatcher / 工具；
 * 已推给前端的半截回复由循环固化成一条正常消息落库，再抛 AbortedError。
 *
 * 用量：LlmRuntime 被 observeUsage 包一层拦截 usage chunk，逐次挂到产出
 * 它的那条 assistant 消息上（messages.usage），并经 RunContext.onUsage
 * 上报本轮累计；会话累计由 store.conversationUsage 求和得到。
 *
 * 配额：AgentLoop 每轮自建的闸只覆盖本次运行（额度实际按轮计），这里按
 * conversationId 缓存同一个闸并传进去——单聊给 AgentLoop.quota，群聊给
 * GroupDispatcher.quota（本轮所有成员共用），额度才是"每会话"。缓存有上界
 * 且宿主删会话时可 {@link SessionCoordinator.releaseConversation} 释放。
 * @module @ryharness/session/coordinator
 */

import type {
  AgentDefinition,
  AgentEvolutionHooks,
  AgentLoopEvent,
  AgentMemoryHooks,
  SessionQuota,
  SessionQuotaLimits,
  ToolSource,
} from '@ryharness/agent'
import { AgentLoop, createSessionQuota, DEFAULT_HISTORY_BUDGET_TOKENS } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GroupEvent, GroupHistoryEntry } from '@ryharness/group'
import { GroupDispatcher, parseMentions } from '@ryharness/group'
import type {
  ContentBlock,
  GenerateOptions,
  LlmRuntime,
  Message,
  MessageId,
  StreamChunk,
  TokenUsage,
  ToolCallId,
} from '@ryharness/llm'
import { estimateMessageTokens, estimateTokens } from '@ryharness/llm'
import { composePersonaPrompt } from './persona.ts'
import { repairToolCallPairing } from './repair.ts'
import type { SessionStore } from './store.ts'
import type { StoredAgent, StoredMessage, StoredUsage } from './types.ts'

/**
 * 把 agent 定义换成"带人格"的运行态：systemPrompt = 原人设 + 人格段落。
 *
 * 只在这里拼一次：单聊、群聊、以及编辑器里那段预览文字都指向
 * {@link composePersonaPrompt}，所以"预览看到的"与"模型收到的"是同一段。
 */
function personaAgent(agent: StoredAgent): AgentDefinition {
  return { ...agent, systemPrompt: composePersonaPrompt(agent.systemPrompt, agent.persona) }
}

/** 协调器构造参数。 */
export interface CoordinatorOptions {
  store: SessionStore
  llm: LlmRuntime
  /** 可用工具全集：数组或按名注册表（AgentLoop 按 agent 定义白名单逐轮解析）。 */
  tools: ToolSource
  /** 长期记忆（可选）：每个发言 agent 用自己的空间 + 共享画像。 */
  memory?: AgentMemoryHooks
  /** 自我进化（可选）：playbook 注入 + 每轮 delta/反思。 */
  evolution?: AgentEvolutionHooks
  /** 每会话工具配额上限（可选，缺省用 DEFAULT_SESSION_QUOTA_LIMITS）。 */
  quotaLimits?: SessionQuotaLimits
  /** 内存中同时保留的会话配额闸数（可选，默认 128；超出按 LRU 淘汰）。 */
  quotaCacheSize?: number
  /**
   * 下一轮问答注入（可选）：由 ask-user 插件提供。
   *
   * 每轮组装系统提示时按 agent 调一次；返回的文本会被追加到该 agent 的系统
   * 提示末尾。`commit` 在该 agent 真的跑过之后调用——群聊里被 @ 的成员不一定
   * 每一位都发言，提前标记会让「只该给一个人的回答」悄悄消失。
   */
  questionContext?: (conversationId: string, agentId: string) => ContextInjection | undefined
  /**
   * 会话级**工作法**（可选）：一段可复用的方法，按会话与 agent 注入系统提示。
   *
   * 与 questionContext 的区别是「性质」：问答是**这一轮的事实**（问过什么、答了什么），
   * 工作法是**做事的方法**（盘问的套路、产出物的格式）。RyVibe 就靠它把「grill me」
   * 这套方法只装进那一个会话，不去改任何助理的常驻人设。
   *
   * 方法与它依赖的工具**必须一起走**：方法说"用 grill 问用户"，白名单里却没有
   * grill，模型就会把问题当普通文字复述出来——用户永远等不到问题卡，这一轮静静
   * 卡死，而且**不报任何错**。所以工具名挂在方法上，装方法时一并放行。
   *
   * 返回 undefined = 这轮不装任何方法。
   */
  conversationMethod?: (
    conversationId: string,
    agentId: string,
  ) => { skill: string; tools: readonly string[] } | undefined
  /**
   * 「你在跟谁说话」身份句（可选）：每轮组装系统提示时取一次，排在最前面。
   *
   * 由装配层从个人资料读出来传进来（见 apps/server/src/routes/profile.ts）：
   * 用户在「我的」页改的名字要让 agent 真的知道，而资料存在服务端，不该由内核
   * 自己认存储。返回 undefined / 空串 = 不注入。
   */
  identity?: () => string | undefined
}

/** 一次性上下文注入：文本 + 送达确认。 */
export interface ContextInjection {
  text: string
  /** 该 agent 的模型调用真的发生过后调用（幂等由提供方负责）。 */
  commit?(): void
}

/**
 * 一次模型调用出账后的回调载荷（RunContext.onUsage）。
 * usage 是本次调用、turnTotal 是本轮累计——server 拿它推 WS done 事件。
 */
export interface UsageReport {
  conversationId: string
  turnIndex: number
  usage: StoredUsage
  turnTotal: StoredUsage
}

/** 一次调用的运行上下文。 */
export interface RunContext {
  workspaceRoot: string
  /** 取消信号：透传给 AgentLoop / GroupDispatcher / 工具执行。 */
  signal?: AbortSignal
  /** 可选扩展点：模型调用出账后回调（server 推 WS / 记会话累计）。 */
  onUsage?: (report: UsageReport) => void
}

/**
 * 一轮对话的公共选项。
 *
 * `turnIndex` 是**外部指定**本轮的轮次序号，缺省按库里的最大值推。
 *
 * 为什么要有这个口子：库里 max(turn_index)+1 只能反映"已经落库的那几轮"。同一会话
 * 串行排队时，后面几轮在**入队那一刻**还都没落库，按库里最大值推会拿到同一个号——
 * 两轮共用一个轮次序号，气泡的键、事件的对帧、渲染层的分组全都会串。调用方
 * （server 的轮次链）在入队时就把号预占下来，执行时原样传进来，两边才对得上。
 */
export interface ChatTurnOptions {
  /** 重放：库里已经有那条用户消息了，本轮不再追加一条新的。 */
  replay?: boolean
  /** 本轮的轮次序号（缺省按库里最大值推）。 */
  turnIndex?: number
}

/** 工具结果消息文本前缀（也是历史格式化时识别工具消息的标志）。 */
const TOOL_RESULT_PREFIX = '〔tool〕'
/**
 * 工具结果消息里的失败标记块（只留在库里给回放看，不进模型上下文）。
 *
 * 工具结果的正文本来就落库（`〔tool〕<name>: <content>`），但失败态只活在实时事件里：
 * 从历史加载一条失败的调用，气泡上就只剩一行「已读文件」，用户回看时完全看不出当时
 * 错在哪。标记做成独立的零长度块而不是往正文里插前缀，是因为正文要原样回填给模型，
 * 而"这次调用失败了"这件事对模型没有新增信息（它自己知道上一轮拿到的就是错误结果）。
 * 渲染层据此把工具行画成失败态并默认展开（见 ChatView 的 fromHistory）。
 */
export const TOOL_ERROR_BLOCK_TYPE = 'tool-error'

/** 一条工具结果消息的内容块：正文 + 失败时的标记块。 */
function toolResultBlocks(name: string, content: string, isError: boolean): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${name}: ${content}` }]
  if (isError) blocks.push({ type: TOOL_ERROR_BLOCK_TYPE })
  return blocks
}

/** 这条历史消息是不是一条失败的工具结果。 */
export function isToolErrorRow(row: { contentBlocks: unknown[] }): boolean {
  return row.contentBlocks.some((block) => {
    return (block as { type?: unknown }).type === TOOL_ERROR_BLOCK_TYPE
  })
}

/**
 * 消息行里会随历史一起回填给模型的内容块。
 *
 * reasoning 在这里被剔掉：本仓的 OpenAI 序列化明确不回放它（llm/openai/serialize.ts
 * 说 chat/completions 没有 reasoning 槽位，塞进可见正文等于把模型的思考说成答案）。
 * 它留在库里只给前端回放看——既不占供应商的输入预算，也不该继续回填进下一次请求。
 * 失败标记块（{@link TOOL_ERROR_BLOCK_TYPE}）同理：它是渲染层需要的，不是模型需要的。
 * 重建与计量共用这一个函数，两边一漂，"增量读窗口 = 全量裁剪窗口"就不再成立。
 */
function modelBlocks(row: StoredMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const raw of row.contentBlocks) {
    // 存储层会带上渲染层专用的块（reasoning、工具失败标记），它们不是模型的内容块，
    // 所以先按未知形状读 type 判掉，再收进模型侧的那一份。
    const type = (raw as { type?: unknown }).type
    if (type === 'reasoning' || type === TOOL_ERROR_BLOCK_TYPE) continue
    blocks.push(raw as ContentBlock)
  }
  return blocks
}

/** 把 store 的消息行重建为 @ryharness/llm 的 Message（单聊历史用）。 */
function rebuildMessage(row: StoredMessage, agent: AgentDefinition): Message | undefined {
  const id = brandString<MessageId>(row.id)
  const content = modelBlocks(row)
  if (row.senderType === 'user') {
    return { id, role: 'user', content, source: { kind: 'user' } }
  }
  if (row.senderType === 'agent') {
    if (row.toolCallId !== undefined) {
      const callId = brandString<ToolCallId>(row.toolCallId)
      return { id, role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId } }
    }
    return {
      id,
      role: 'assistant',
      content,
      source: { kind: 'model', provider: agent.provider, model: agent.model },
    }
  }
  return undefined
}

/** 把 store 的消息行格式化为群历史条目（跳过工具结果与 system）。 */
function toGroupEntry(row: StoredMessage, agentNames: Map<string, string>): GroupHistoryEntry | undefined {
  if (row.senderType === 'system' || row.toolCallId !== undefined) return undefined
  const text = (row.contentBlocks as ContentBlock[])
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
  if (text.trim().length === 0) return undefined
  const speaker =
    row.senderType === 'user'
      ? '用户'
      : row.senderId !== undefined
        ? (agentNames.get(row.senderId) ?? row.senderId)
        : 'agent'
  return { speaker, text }
}

/**
 * 历史增量读的窗口预算（token）。
 *
 * 量纲必须与 {@link historyRowWeight} 一致，也就是与 AgentLoop 的入口历史裁剪一致：
 * 循环自己按模型上下文窗口算（resolveRequestBudget），这里的静态值只是"从库里取
 * 多少行"的上限，两边不同口径时"窗口已裁好、循环侧是兜底"就是假的。群聊窗口走
 * {@link groupHistoryRowWeight}，调度器侧的再裁（buildGroupContext）也是同一个
 * token 口径——三处同值同单位，见 packages/session/tests/budget-unit.test.ts 的
 * 不变量断言。
 */
export const HISTORY_BUDGET_TOKENS = DEFAULT_HISTORY_BUDGET_TOKENS

/**
 * 单聊历史的逐行预算权重（token）：与 @ryharness/agent 的 trimHistoryToBudget →
 * estimateMessageTokens 同一口径（role 开销 + 每块的块结构开销，中文一字一 token）。
 *
 * 这是"增量读窗口 = 旧全量裁剪窗口"逐条等价的前提，tests/history-read 用真实的
 * trimHistoryToBudget 断言这一不变量——权重一漂，等价断言立刻红。
 *
 * measurement 消息统一取 role 'user'：estimateMessageTokens 只读 content，role 开销
 * 对所有角色同值，为它伪造一条 source 只会让"这一行到底是什么角色"在 rebuildMessage
 * 之外再写一遍。system 行不属于历史（rebuildMessage 会丢弃它）。
 */
export function historyRowWeight(row: StoredMessage): number | undefined {
  if (row.senderType === 'system') return undefined
  return estimateMessageTokens({
    id: brandString<MessageId>(row.id),
    role: 'user',
    content: modelBlocks(row),
    source: { kind: 'user' },
  })
}

/**
 * 群聊历史的逐行预算权重（token）：条目行 `${speaker}: ${text}` 的估算 token，
 * 外加 1 个 token 的行分隔换行（与 toGroupEntry 拼出的行逐条对应）。
 *
 * 与单聊同理走真 token 而不是字符数：中文一字一 token，字符口径下同一份预算
 * 实际多送 4 倍。system、tool 结果与纯空白行不属于群历史（toGroupEntry 会丢弃它们）。
 */
export function groupHistoryRowWeight(row: StoredMessage, agentNames: Map<string, string>): number | undefined {
  const entry = toGroupEntry(row, agentNames)
  if (entry === undefined) return undefined
  return estimateTokens(`${entry.speaker}: ${entry.text}`) + 1
}

/** 一段用量累加器（可重置取走），零值即"没有 usage 事件"。 */
class UsageMeter {
  private input = 0
  private output = 0
  private total = 0
  private cacheRead = 0
  private cacheWrite = 0
  private reasoning = 0
  private calls = 0

  add(usage: TokenUsage): void {
    this.calls++
    this.input += usage.inputTokens
    this.output += usage.outputTokens
    this.total += usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    this.cacheRead += usage.cacheReadTokens ?? 0
    this.cacheWrite += usage.cacheWriteTokens ?? 0
    this.reasoning += usage.reasoningTokens ?? 0
  }

  private snapshot(): StoredUsage {
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      totalTokens: this.total,
      ...(this.cacheRead === 0 ? {} : { cacheReadTokens: this.cacheRead }),
      ...(this.cacheWrite === 0 ? {} : { cacheWriteTokens: this.cacheWrite }),
      ...(this.reasoning === 0 ? {} : { reasoningTokens: this.reasoning }),
    }
  }

  /** 自建以来的累计快照（不清零）；没有 usage 事件时为 undefined。 */
  get accumulated(): StoredUsage | undefined {
    return this.calls === 0 ? undefined : this.snapshot()
  }

  /** 取走自上次取走以来的用量；没有新事件返回 undefined。 */
  take(): StoredUsage | undefined {
    if (this.calls === 0) return undefined
    const usage = this.snapshot()
    this.input = 0
    this.output = 0
    this.total = 0
    this.cacheRead = 0
    this.cacheWrite = 0
    this.reasoning = 0
    this.calls = 0
    return usage
  }
}

/**
 * 包一层 LlmRuntime，只做一件事：截获 `usage` chunk 交给记账回调。
 *
 * 用 Proxy 而不是继承——LlmRuntime 是 Typert 服务类，构造与装饰器都不适合
 * 在这里复刻；AgentLoop / GroupDispatcher 也只用 `stream`，其余成员原样转发。
 * 放在协调器而不是循环里，是因为群聊路径的循环由 GroupDispatcher 自己创建，
 * 只有包住 runtime 才能让单聊与群聊共用同一套记账。
 */
function observeUsage(base: LlmRuntime, onUsage: (usage: TokenUsage) => void): LlmRuntime {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'stream') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        return (async function* (): AsyncGenerator<StreamChunk> {
          for await (const chunk of target.stream(options)) {
            if (chunk.type === 'usage') onUsage(chunk.usage)
            yield chunk
          }
        })()
      }
    },
  })
}

/** 把 TokenUsage 归一成落库形态。 */
function toStoredUsage(usage: TokenUsage): StoredUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

/** 一轮对话的用量记账：逐次抽取（挂到具体消息）+ 本轮累计（上报与查询）。 */
class TurnUsage {
  private readonly calls = new UsageMeter()
  private readonly turn = new UsageMeter()

  /** 记一次模型调用。 */
  add(usage: TokenUsage): void {
    this.calls.add(usage)
    this.turn.add(usage)
  }

  /** 取走上次取走以来累计的用量（挂到本步产出的那条消息）。 */
  takeCall(): StoredUsage | undefined {
    return this.calls.take()
  }

  /** 本轮累计用量。 */
  total(): StoredUsage | undefined {
    return this.turn.accumulated
  }
}

/** 内存里同时保留的会话配额闸数（会话数）；超出后按 LRU 淘汰。 */
const DEFAULT_QUOTA_CACHE_SIZE = 128

/**
 * 会话配额闸缓存：同一会话的每一轮、每个群成员都拿到同一个闸。
 *
 * AgentLoop 缺省自建闸，额度按轮计——一轮 40 次 shell 用完就翻篇，跨轮拦不住
 * "这一整个会话里反复跑命令"。这里把闸按 conversationId 缓存起来传进去。
 *
 * 上界：条目随会话数增长，必须有界。超限时先扫掉会话已不存在的条目（宿主直接
 * 删库、不走 {@link ConversationQuotaCache.release} 时也能真正释放），再按 LRU
 * 丢最久没用过的那个。代价是被淘汰的会话额度归零（下一轮重新计），比无界增长好。
 */
class ConversationQuotaCache {
  /** 插入序即 LRU 序：命中后删掉再插入，迭代序始终是最久未使用在前。 */
  private readonly entries = new Map<string, SessionQuota>()

  constructor(
    private readonly limits: SessionQuotaLimits,
    private readonly maxEntries: number,
    /** 会话是否还在库里（用于清理已删除会话的残留闸）。 */
    private readonly isAlive: (conversationId: string) => boolean,
  ) {}

  /** 取该会话的闸（没有就建一个并记账）。 */
  take(conversationId: string): SessionQuota {
    const cached = this.entries.get(conversationId)
    if (cached !== undefined) {
      this.entries.delete(conversationId)
      this.entries.set(conversationId, cached)
      return cached
    }
    const quota = createSessionQuota(this.limits)
    this.entries.set(conversationId, quota)
    this.evict()
    return quota
  }

  /** 只查不建：没有就返回 undefined（供宿主查看用量/清理）。 */
  peek(conversationId: string): SessionQuota | undefined {
    return this.entries.get(conversationId)
  }

  /** 释放一个会话的闸（会话已删除时由宿主调用）。 */
  release(conversationId: string): boolean {
    return this.entries.delete(conversationId)
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    for (const id of [...this.entries.keys()]) {
      if (!this.isAlive(id)) this.entries.delete(id)
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }
}

/** Session 协调器：单聊 chatDirect + 群聊 chatGroup。 */
export class SessionCoordinator {
  private readonly quotas: ConversationQuotaCache

  constructor(private readonly options: CoordinatorOptions) {
    const { store } = options
    this.quotas = new ConversationQuotaCache(
      options.quotaLimits ?? {},
      Math.max(1, options.quotaCacheSize ?? DEFAULT_QUOTA_CACHE_SIZE),
      (conversationId) => {
        return store.getConversation(conversationId) !== undefined
      },
    )
  }

  /**
   * 查某会话当前的配额闸（只读，不创建）：没有就返回 undefined。
   * @param conversationId - 会话 id。
   */
  quotaOf(conversationId: string): SessionQuota | undefined {
    return this.quotas.peek(conversationId)
  }

  /**
   * 释放某会话的内存态（当前只有配额闸）。宿主删除会话时调用：
   * `store.deleteConversation(id)` 之后紧跟一句，否则额度要等缓存淘汰才回收。
   * @param conversationId - 会话 id。
   * @returns 该会话此前确实占用着一个闸。
   */
  releaseConversation(conversationId: string): boolean {
    return this.quotas.release(conversationId)
  }

  /**
   * 单聊：用户消息落库 → 从 store 恢复历史 → AgentLoop → 发言落库。
   *
   * `replay: true` = **重放**：库里已经有那条用户消息了（"编辑并重发"改写过的，
   * 或"重新生成"要重跑的那条），本轮不再追加一条新的，只把库里那一条原样交给
   * 模型再答一次。
   *
   * 实现是"加载历史时把末尾那条用户消息摘掉"：AgentLoop 每次 run 都会把自己
   * 那条 user 消息推进历史（loop.ts 的 history.push），摘掉再让它推回去，模型
   * 看到的历史与首次发送时**逐条相同**，而库里的那条用户消息**一条没动**
   * （用户那句话的 seq 因此不变）。
   *
   * @param conversationId - 会话 id。
   * @param agentId - 响应的 agent id。
   * @param text - 用户输入（重放时是库里那条用户消息的正文）。
   * @param context - 工作区根目录等。
   * @param options - `replay` = 重放已有那条用户消息，不追加新的；`turnIndex` = 本轮
   *   的轮次序号（缺省按库里最大值推）。
   * @returns AgentLoop 事件流（透传）。
   */
  async *chatDirect(
    conversationId: string,
    agentId: string,
    text: string,
    context: RunContext,
    options: ChatTurnOptions = {},
  ): AsyncGenerator<AgentLoopEvent> {
    const { store, llm, tools } = this.options
    const stored = store.getAgent(agentId)
    if (stored === undefined) throw new Error(`@ryharness/session: unknown agent "${agentId}"`)
    // 人格在这一刻才拼进系统提示：库里的 systemPrompt 保持"用户写的原话"，
    // 拼出来的版本只在本次调用里用，编辑器预览与实际发送因此永远一致。
    // 问答注入接在人格之后：它是本轮的事实补充，不是 agent 人设的一部分。
    const { agent, commit: commitQuestion } = this.injectTurnContext(personaAgent(stored), conversationId)
    const conversation = store.getConversation(conversationId)
    if (conversation === undefined) throw new Error(`@ryharness/session: unknown conversation "${conversationId}"`)

    const turnIndex = options.turnIndex ?? store.nextTurnIndex(conversationId)
    const history = this.loadDirectHistory(conversationId, agent)
    if (options.replay === true) {
      // 重放：库里末尾那条用户消息就是这一轮要重放的。摘掉它，让 AgentLoop
      // 把它原样推回去——用户那句话留在库里、seq 不变，模型看到的历史与首次
      // 发送时逐条相同。
      const last = history.at(-1)
      if (last === undefined || last.role !== 'user') {
        throw new Error('@ryharness/session: replay needs the conversation to end with the user message')
      }
      history.pop()
    } else {
      // 先恢复历史（不含本条用户消息），再落库用户消息，避免历史里出现重复输入。
      store.appendMessage({
        conversationId,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text }],
        turnIndex,
      })
    }

    const memory = this.bindMemory(conversationId)
    const evolution = this.bindEvolution(conversationId)
    const usage = new TurnUsage()
    let lastAssistant: StoredMessage | undefined
    const loop = new AgentLoop({
      definition: agent,
      llm: observeUsage(llm, (call) => {
        usage.add(call)
      }),
      tools,
      history,
      // 每步组装出的 assistant 消息（含 tool_calls、可能无文本）即时落库：
      // 不持久化它们，重建历史里 tool 消息就没有前置的 assistant tool_calls
      // 消息，违反 OpenAI 消息序列契约（第二轮必 400）。
      onAssistantMessage: (message, callUsage) => {
        if (message.content.length === 0) return
        const row = store.appendMessage({
          conversationId,
          senderType: 'agent',
          senderId: agentId,
          contentBlocks: [...message.content],
          turnIndex,
        })
        lastAssistant = row
        // 一次模型调用恰好产出一条消息，取走的记账就是这条消息的用量；循环
        // 直接递来的 usage 是同一个值，作为供应商漏报 usage chunk 时的兜底。
        const drained = usage.takeCall()
        this.settleUsage(row, callUsage === undefined ? drained : toStoredUsage(callUsage), usage, turnIndex, context)
      },
      // 按会话缓存的闸：额度跨轮累计，不随这一轮的 AgentLoop 重建而清零。
      quota: this.quotas.take(conversationId),
      ...(this.options.identity === undefined ? {} : { identity: this.options.identity }),
      ...(memory === undefined ? {} : { memory }),
      ...(evolution === undefined ? {} : { evolution }),
    })

    let failed: { message: string; code: string } | undefined
    /** 本轮的模型调用真的产生了事件；只有它才能证明问答注入被送到了模型。 */
    let sawEvent = false
    try {
      // 会话 id 作为工具上下文的一部分下发：待办等按会话落数据的工具无法自己知道
      // 当前在与谁说话，也不该从全局「当前会话」里猜（并发会话会串）。
      for await (const event of loop.run({ text }, { ...context, conversationId })) {
        // 文本/工具/完成事件能证明请求真的发出去过；单条 error 也可能发生在
        // 发起请求之前（例如没有可用路由），那不算模型看到了注入。
        if (event.type !== 'error') sawEvent = true
        yield event
        if (event.type === 'tool-result') {
          store.appendMessage({
            conversationId,
            senderType: 'agent',
            senderId: agentId,
            // 失败态一起落库：正文与标记都在，回看时工具行仍是失败态而不是一行"已完成"。
            contentBlocks: toolResultBlocks(event.name, event.result.content, event.isError === true),
            toolCallId: event.callId,
            // 产物卡片随消息落库：WS 的 produce-card 只覆盖实时渲染，不落库
            // 的话刷新/重开后历史里就查不到这份产物（产品链路断点）。
            ...(event.result.produce === undefined
              ? {}
              : { artifacts: [{ callId: event.callId, ...event.result.produce }] }),
            turnIndex,
          })
        }
        if (event.type === 'error') failed = { message: event.message, code: event.code }
      }
    } finally {
      // 本轮确实产出了事件（模型调用成功、报错或取消后仍有半截输出），问答才
      // 算送达；在发请求前就失败的 turn 不能吃掉回答。
      if (sawEvent) commitQuestion?.()
      // 取消时循环会抛 AbortedError：未挂到消息上的那次调用用量不能丢。
      this.settleUsage(lastAssistant, usage.takeCall(), usage, turnIndex, context)
    }

    if (failed !== undefined) {
      store.appendMessage({
        conversationId,
        senderType: 'system',
        contentBlocks: [{ type: 'text', text: `[error:${failed.code}] ${failed.message}` }],
        turnIndex,
      })
    }

    // 亲密度按"完成了一轮对话"增长：只有真的接住了话才算互动，中途报错的一轮
    // 不给分。落库发生在本轮系统提示拼接之后，所以这一轮生效的是新亲密度之前
    // 的档位——下一轮才换称呼，不会在同一段对话里前后不一致。
    if (lastAssistant !== undefined) store.bumpAgentAffinity(agentId, { turns: 1 })
  }

  /**
   * 群聊：用户消息（带 mentions）落库 → 共享历史（"名字:"前缀 + 预算裁剪）→
   * GroupDispatcher 调度链 → 每条 dispatch 落 dispatch_events，每条完成的
   * agent 发言与其工具结果落 messages，错误以 system 消息收尾。
   * @param conversationId - 群会话 id。
   * @param text - 用户输入（重放时是库里那条用户消息的正文）。
   * @param context - 工作区根目录等。
   * @param options - `replay` = 重放已有那条用户消息，不追加新的；`turnIndex` = 本轮
   *   的轮次序号（缺省按库里最大值推）。
   * @returns GroupDispatcher 事件流（透传）。
   */
  async *chatGroup(
    conversationId: string,
    text: string,
    context: RunContext,
    options: ChatTurnOptions = {},
  ): AsyncGenerator<GroupEvent> {
    const { store, llm, tools } = this.options
    const conversation = store.getConversation(conversationId)
    if (conversation === undefined) throw new Error(`@ryharness/session: unknown conversation "${conversationId}"`)
    if (conversation.kind !== 'group') {
      throw new Error(`@ryharness/session: conversation "${conversationId}" is not a group`)
    }
    const members: AgentDefinition[] = []
    /** 每个成员待确认的问答注入：事件里第一次出现该成员时再标记送达。 */
    const questionCommits = new Map<string, () => void>()
    for (const id of conversation.memberAgentIds) {
      const stored = store.getAgent(id)
      if (stored === undefined) continue
      const { agent, commit } = this.injectTurnContext(personaAgent(stored), conversationId)
      if (commit !== undefined) questionCommits.set(agent.id, commit)
      members.push(agent)
    }
    if (members.length === 0) throw new Error(`@ryharness/session: group "${conversationId}" has no resolvable members`)
    const dispatcherId = conversation.dispatcherAgentId ?? members[0]!.id
    const markAgentRan = (agentId: string): void => {
      const commit = questionCommits.get(agentId)
      if (commit === undefined) return
      questionCommits.delete(agentId)
      commit()
    }

    const turnIndex = options.turnIndex ?? store.nextTurnIndex(conversationId)
    /**
     * 重放时历史要从"要重放的那一轮"之前取起。
     *
     * 群聊的历史是按 turn_index 切段的（`beforeTurnIndex`），重放的那一轮正是
     * 库里末尾那条用户消息所在的那一轮——把它整轮排除，调度器看到的就与首次
     * 发送时一致（当前输入单独递给它，不在历史里出现第二遍）。
     */
    let historyBeforeTurn = turnIndex
    if (options.replay === true) {
      const last = store.listMessages(conversationId, { limit: 1 })[0]
      if (last === undefined || last.senderType !== 'user') {
        throw new Error('@ryharness/session: replay needs the conversation to end with the user message')
      }
      historyBeforeTurn = last.turnIndex
    } else {
      const mentions = parseMentions(text, members).map((member) => {
        return member.id
      })
      store.appendMessage({
        conversationId,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text }],
        mentions,
        turnIndex,
      })
    }

    const agentNames = new Map(
      members.map((member) => {
        return [member.id, member.name]
      }),
    )
    // 历史增量读：按预算从最新往回取"本 turn 之前"的行（内核评审 P0-2：不再整读
    // 1000 行）。keepNewest=false：群历史允许裁空；beforeTurnIndex 排除本轮已落库的
    // 行。窗口内行数受预算约束，二次格式化开销可忽略。
    //
    // 口径必须是 token：行权重走 {@link groupHistoryRowWeight}，调度器侧的再裁
    // （@ryharness/group 的 buildGroupContext）也是同一个 token 预算与同样的逐行
    // 权重，因此这里取出的窗口在它那里是 no-op——字符口径曾经让它在 ASCII 群聊
    // 上再收一刀（30k 字符 ≈ 7.5k token），中文群聊则整个窗口放行。
    const historyRows = store.listMessagesForHistory(conversationId, HISTORY_BUDGET_TOKENS, {
      weightOf: (row) => {
        return groupHistoryRowWeight(row, agentNames)
      },
      keepNewest: false,
      beforeTurnIndex: historyBeforeTurn,
    })
    const history: GroupHistoryEntry[] = []
    for (const row of historyRows) {
      const entry = toGroupEntry(row, agentNames)
      if (entry !== undefined) history.push(entry)
    }

    const usage = new TurnUsage()
    let lastAssistant: StoredMessage | undefined
    /** 本轮真的发言过的成员：亲密度按人给一次，而不是按他说了几句给几次。 */
    const speakers = new Set<string>()
    const dispatcher = new GroupDispatcher({
      llm: observeUsage(llm, (call) => {
        usage.add(call)
      }),
      members,
      dispatcherId,
      tools,
      ...(this.bindMemory(conversationId) === undefined ? {} : { memory: this.bindMemory(conversationId) }),
      ...(this.bindEvolution(conversationId) === undefined ? {} : { evolution: this.bindEvolution(conversationId) }),
      ...(this.options.identity === undefined ? {} : { identity: this.options.identity }),
      // 调度器把同一个闸分给本轮所有成员：接力链变长不会放大工具预算。
      quota: this.quotas.take(conversationId),
    })
    try {
      for await (const event of dispatcher.runTurn({
        text,
        history,
        workspaceRoot: context.workspaceRoot,
        conversationId,
        turnIndex,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })) {
        // 只有真的产生了事件（文本/工具/发言）才算这位成员跑过；dispatch 事件
        // 在护栏拦截时也会出现，不能拿它当「模型已看到注入」的证据。
        if ('agentId' in event) markAgentRan(event.agentId)
        yield event
        switch (event.type) {
          case 'dispatch':
            store.recordDispatchEvent({
              conversationId,
              fromAgent: event.fromAgent,
              toAgent: event.toAgent,
              reason: event.reason,
              turnIndex,
            })
            break
          case 'agent-message': {
            const row = store.appendMessage({
              conversationId,
              senderType: 'agent',
              senderId: event.agentId,
              contentBlocks: [...event.message.content],
              turnIndex,
            })
            lastAssistant = row
            speakers.add(event.agentId)
            // 群聊的循环由调度器创建，usage 只能按"这条发言之前发生的调用"
            // 归集；入口扇出并行时多名成员的用量会并到先提交的那条消息上，
            // 总额仍与实际开销一致。
            this.settleUsage(row, usage.takeCall(), usage, turnIndex, context)
            break
          }
          case 'tool-result':
            store.appendMessage({
              conversationId,
              senderType: 'agent',
              senderId: event.agentId,
              contentBlocks: toolResultBlocks(event.name, event.result.content, event.isError === true),
              toolCallId: event.callId,
              // 与单聊路径同一契约：产物卡片随工具结果消息落库。
              ...(event.result.produce === undefined
                ? {}
                : { artifacts: [{ callId: event.callId, ...event.result.produce }] }),
              turnIndex,
            })
            break
          case 'error':
            store.appendMessage({
              conversationId,
              senderType: 'system',
              contentBlocks: [{ type: 'text', text: `[error:${event.code}] ${event.message}` }],
              turnIndex,
            })
            break
          default:
            break
        }
      }
    } finally {
      // 失败或被取消的那次调用没有产出发言，其用量挂到本轮最后一条发言上，
      // 保证会话累计口径完整。
      this.settleUsage(lastAssistant, usage.takeCall(), usage, turnIndex, context)
      // 亲密度：群聊里按"这一轮说过话的人"各加一次，没发言的成员不加。
      for (const speaker of speakers) store.bumpAgentAffinity(speaker, { turns: 1 })
    }
  }

  /**
   * 一次模型调用的用量出账：写回产出它的那条消息，并回调上报本轮累计
   * （server 据此推 WS done 事件）。没有用量（供应商漏报）或没有消息可挂时
   * 静默跳过——成本口径宁可少一条，不可把用量算到别的消息上。
   */
  private settleUsage(
    message: StoredMessage | undefined,
    usage: StoredUsage | undefined,
    turnUsage: TurnUsage,
    turnIndex: number,
    context: RunContext,
  ): void {
    if (message === undefined || usage === undefined) return
    this.options.store.attachUsage(message.id, usage)
    const turnTotal = turnUsage.total()
    if (turnTotal === undefined) return
    context.onUsage?.({ conversationId: message.conversationId, turnIndex, usage, turnTotal })
  }

  /**
   * 把该 agent 的**会话级补充**接到定义上：问答上下文、工作法、额外工具。
   *
   * 注入点选在协调器组装 agent 定义时：单聊与群聊都从这里拿到最终定义，不必
   * 触碰 AgentLoop 的循环/压缩；群聊按成员各调一次，问题只回到问它的那个人。
   *
   * 顺序有讲究：**工作法（怎么做事）在前、问答（这一轮的事实）在后**——先告诉
   * 它按什么方法做事，再把刚收到的答案摆到它面前；反过来读着像先给结论再补规则。
   */
  private injectTurnContext(
    agent: AgentDefinition,
    conversationId: string,
  ): { agent: AgentDefinition; commit?: () => void } {
    const injection = this.options.questionContext?.(conversationId, agent.id)
    const method = this.options.conversationMethod?.(conversationId, agent.id)
    const parts: string[] = []
    if (method !== undefined && method.skill.trim().length > 0) parts.push(method.skill.trim())
    if (injection !== undefined && injection.text.trim().length > 0) parts.push(injection.text.trim())
    // 工具白名单按「名字」解析（见 AgentLoop 的 resolveAllowedTools）：这里加名即可，
    // 不必拿到工具实例——插件热重挂后实例会换，名字不会。
    const extra = method?.tools ?? []
    const tools = extra.length === 0 ? agent.tools : [...new Set([...agent.tools, ...extra])]
    if (parts.length === 0 && tools === agent.tools) return { agent }
    return {
      agent: {
        ...agent,
        ...(parts.length === 0 ? {} : { systemPrompt: `${agent.systemPrompt}\n\n${parts.join('\n\n')}` }),
        ...(tools === agent.tools ? {} : { tools }),
      },
      ...(injection?.commit === undefined ? {} : { commit: injection.commit }),
    }
  }

  /** 绑定会话 id 的记忆钩子（AgentLoop 不关心 conversationId，由这里注入）。 */
  private bindMemory(conversationId: string): AgentMemoryHooks | undefined {
    const memory = this.options.memory
    if (memory === undefined) return undefined
    // bind 不是多余动作：memory 可能是 MemoryService（原型方法 + this 状态，
    // recallRefine 还有 this 相关的默认参数），裸取出来调用会在进入函数体之前就抛
    // TypeError，再被 catch 吞成「本轮没注入记忆」——静默失效比崩更难查。
    const sync = memory.recallSync?.bind(memory)
    const refine = memory.recallRefine?.bind(memory)
    return {
      recall: (agentId, inputText) => {
        return memory.recall(agentId, inputText)
      },
      enqueueExtraction: (agentId, agentName, _conversationId, turnText) => {
        memory.enqueueExtraction(agentId, agentName, conversationId, turnText)
      },
      // 同步召回与后台补正必须原样透传：漏掉它们，AgentLoop 就退回 await 路径，
      // 首 token 前白白多等一次 embedding 网络往返。条件展开而不是恒定转发——补一个
      // 永远返回 undefined 的 recallSync 会让循环以为"同步路径跑过了"从而跳过 await
      // 兜底，记忆直接静默失效。
      ...(sync === undefined
        ? {}
        : {
            recallSync: (agentId: string, inputText: string) => {
              return sync(agentId, inputText)
            },
          }),
      ...(refine === undefined
        ? {}
        : {
            recallRefine: (agentId: string, inputText: string, deadlineMs?: number) => {
              return refine(agentId, inputText, deadlineMs)
            },
          }),
    }
  }

  /** 绑定会话 id 的进化钩子（conversationId 由这里注入轨迹与归因）。 */
  private bindEvolution(conversationId: string): AgentEvolutionHooks | undefined {
    const evolution = this.options.evolution
    if (evolution === undefined) return undefined
    return {
      compile: (agentId, inputText) => {
        return evolution.compile(agentId, inputText)
      },
      enqueueTurn: (agentId, agentName, _conversationId, turn) => {
        evolution.enqueueTurn(agentId, agentName, conversationId, turn)
      },
    }
  }

  private loadDirectHistory(conversationId: string, agent: AgentDefinition): Message[] {
    // 历史增量读：按预算从最新往回取（内核评审 P0-2），预算与权重同为 token 口径
    // （{@link HISTORY_BUDGET_TOKENS} / {@link historyRowWeight}）；取出的窗口已在其
    // 内，loop 侧 trimHistoryToBudget 成为兜底（窗口权重 ≤ 预算或仅剩 1 条时为 no-op）。
    const rows = repairToolCallPairing(
      this.options.store.listMessagesForHistory(conversationId, HISTORY_BUDGET_TOKENS, {
        weightOf: historyRowWeight,
      }),
    )
    // 崩溃恢复：上次可能在 assistant 消息（含 tool_call 块）落库后、工具结果落库前
    // 死掉，重建历史先过一遍配对修复（见 repair.ts），否则供应商按断配对拒掉整个请求。
    const messages: Message[] = []
    for (const row of rows) {
      const rebuilt = rebuildMessage(row, agent)
      if (rebuilt !== undefined) messages.push(rebuilt)
    }
    return messages
  }
}
