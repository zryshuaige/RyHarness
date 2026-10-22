/**
 * 群聊调度器：混合模式（@提及直路由 + 调度员自然语言选路）。
 *
 * 设计要点（与"单独的 LLM 路由调用"方案相对）：
 * - **入口**：用户消息有 @X → X 直接响应（可多个，按出现顺序）；无 @ →
 *   调度员（dispatcherAgentId）响应。调度员的 system prompt 追加路由指令：
 *   能答就答，要转交就在回复里 @成员名。
 * - **选路即生成**：不做结构化路由 LLM 调用——调度员正常生成回复，
 *   解析其输出中的 @提及作为路由信号；输出无 @ 视为"自己回答"，一轮结束。
 * - **扇出**：入口一次 @ 多个成员时并发起跑（上限 fanoutConcurrency，
 *   默认 3），B 的首 token 不必等 A 跑完整轮；事件按 @ 出现顺序增量转发
 *   （排在前面的成员生成一块就推一块，不必等整批扇出跑完），消息顺序确定。
 *   扇出内的记忆召回按同一段输入共享一次（{@link FanoutMemory}）：N 个成员
 *   问同一段输入，本来就该拿同一份注入块，不该打 N 次 embedding 网络往返。
 * - **接力**：任何 agent 输出含 @Y → Y 接力。护栏：
 *   - 单条用户消息触发的总接力轮次 ≤ maxTurns（默认 8）；
 *   - 连续两次路由同一 agent（自己 @ 自己 / 冷却不足）→ 停止；
 *   - A@B、B@A 互踢（A-B-A 模式）→ 停止；
 *   - 每次停止都写 dispatch 事件（reason: 'loop-guard' / 'max-turns'）。
 *   接力链始终串行：接力的 prompt 依赖上一个发言者的输出。
 * - **上下文**：所有成员共享群历史，发言带"名字:"前缀，按 token 预算从
 *   最旧裁剪（默认 {@link DEFAULT_HISTORY_BUDGET_TOKENS}，与协调器从库里取行
 *   用的同一个数、同一种单位）。
 * - **配额**：一轮里所有成员共用同一个 {@link SessionQuota}，群聊的工具预算
 *   是"每条用户消息"的量级，不会因为接力链变长而被放大；由调用方传入跨轮
 *   复用的同一个闸才升级为"每会话"。
 * - **取消**：runTurn 接受 AbortSignal，透传给每个 AgentLoop 与工具；取消
 *   后不再接力，以 code=ABORTED 的 error 事件收尾。
 * @module @ryharness/group/dispatcher
 */

import type {
  AgentDefinition,
  AgentEvolutionHooks,
  AgentLoopEvent,
  AgentMemoryHooks,
  SessionQuota,
  Tool,
  ToolContext,
  ToolResult,
  ToolSource,
} from '@ryharness/agent'
import {
  ABORTED_CODE,
  DEFAULT_HISTORY_BUDGET_TOKENS as AGENT_DEFAULT_HISTORY_BUDGET_TOKENS,
  AgentLoop,
  createSessionQuota,
  isAbortedError,
  listTools,
} from '@ryharness/agent'
import type { AssistantMessage, LlmRuntime, ToolCallId } from '@ryharness/llm'
import { errorChain, estimateTokens } from '@ryharness/llm'
import { parseMentions } from './mentions.ts'

/**
 * 调度员 system prompt 追加的路由指令（**按群成员现生成**）。
 *
 * 为什么不能是一段写死的常量：里面那个示例名（曾经是 `@CodeBot`）会被模型照抄——
 * 真机实测调度员直接在回复里喊「@CodeBot 去查…」，而群里根本没有这个人，接力链
 * 于是永远派不出去，而且看上去一切正常（调度员回复了，只是没人接手）。示例必须
 * 是这个群真实存在的成员名，最好连 id 一起给：模型有时会拿 id 称呼成员。
 */
export function dispatcherRoutingSuffix(members: readonly AgentDefinition[], dispatcherId: string): string {
  const others = members.filter((member) => {
    return member.id !== dispatcherId
  })
  const roster =
    others.length === 0
      ? '（本群没有其他成员，你只能自己回答）'
      : others
          .map((member) => {
            return `@${member.name}（id: ${member.id}）`
          })
          .join('、')
  // 示例必须用名单里的真人：真机实测模型会照抄示例名，抄真人抄得对，抄假人接力链静默失效。
  const first = others[0]
  const example =
    first === undefined
      ? []
      : [`   示例：用户说「让${first.name}算个数」→ 你调用 handoff(to="${first.name}", task="算出用户要的数")。`]
  return [
    '',
    '你是本群的调度员，负责协调群成员。规则：',
    '1. 能直接回答的问题直接回答，不要交接，一轮即结束。',
    '2. 需要把活交给别人时，调用 handoff 工具：to 写成员名或 id，task 写清楚要对方做什么。',
    `   可交接的成员：${roster}`,
    ...example,
    '3. 光在文字里说「我让某人去办」不算交接，必须调用 handoff 工具。',
    '4. 绝不交给自己，也绝不在 to 里编造名单之外的名字——写错名字等于没派出去。',
  ].join('\n')
}

/**
 * 非调度员成员的交接提示（调度员用 {@link dispatcherRoutingSuffix}）。
 *
 * 接力链上任何一位都可能需要把活往下传（工程师算完 → 管家点评）。调度员的 suffix
 * 只挂在调度员身上，其他成员原本一句交接指引都没有——工具在白名单里，模型却不知
 * 道何时该用，接力于是永远只有一跳。这里给一段短的：什么时候交、交给谁、怎么交。
 */
export function memberHandoffSuffix(members: readonly AgentDefinition[], selfId: string): string {
  const others = members.filter((member) => {
    return member.id !== selfId
  })
  if (others.length === 0) return ''
  const roster = others
    .map((member) => {
      return `@${member.name}（id: ${member.id}）`
    })
    .join('、')
  return [
    '',
    '你在一个多人群组里。做完自己的部分后：',
    `- 如果需要另一位成员继续（点评、补充、汇总），调用 handoff 工具交过去。可交接的成员：${roster}`,
    '- 光在文字里说「让某人看看」不算交接，必须调用 handoff 工具。',
    '- 不需要别人接手就直接收尾，不要为交接而交接。',
  ].join('\n')
}

/**
 * 交接行的行首标记：模型偶尔不肯用工具时会退回写这一行（见 handoffText）。
 * 它是工具通道失效时的兜底，不是主路径。
 */
const HANDOFF_MARKER = '[交办]'

/** 交接工具名（模型通过它把任务交给另一位成员，见 handoffTool）。 */
const HANDOFF_TOOL = 'handoff'

/** 一轮里被工具登记的交接请求（谁交给谁、交什么活）。 */
interface HandoffRequest {
  fromId: string
  toId: string
  task: string
}

/**
 * 从调度员回复里取出**用于解析交接的那段文本**。
 *
 * 为什么要单独一段：路由信号是「@ 某人」。真机实测模型会照抄示例里的成员名却
 * 忘了 @ 号（回复写着「让工程师查最近没去过的店」，一个 @ 都没有），接力链于是静默
 * 失效——界面上只看到调度员答了话，没人接手。约定一个显式标记后，交接语义落在
 * 标记行里：正文里顺口提到成员（"管家说上次那家不错"）不会被误判成派工。
 *
 * 找不到标记行时退回整段文本：模型完全自由发挥（直接写 @工程师 而不加标记）时，
 * 老行为仍然成立，不至于把接力弄丢。
 */
export function handoffText(outputText: string): string {
  const marked = outputText.split('\n').filter((line) => {
    return line.includes(HANDOFF_MARKER)
  })
  return marked.length === 0 ? outputText : marked.join('\n')
}

/** 群历史条目（已由协调器格式化并裁剪）。 */
export interface GroupHistoryEntry {
  /** 显示名（agent name 或"用户"）。 */
  speaker: string
  text: string
}

/** 调度器产出的事件流。 */
export type GroupEvent =
  | { type: 'dispatch'; fromAgent?: string; toAgent: string; reason: string; turnIndex: number }
  | { type: 'text-delta'; agentId: string; agentName: string; text: string }
  | { type: 'tool-call-start'; agentId: string; callId: ToolCallId; name: string; arguments: string }
  | { type: 'tool-result'; agentId: string; callId: ToolCallId; name: string; isError: boolean; result: ToolResult }
  | { type: 'agent-message'; agentId: string; message: AssistantMessage }
  | { type: 'turn-done'; turns: number }
  | { type: 'error'; message: string; code: string }

/** 调度器构造参数。 */
export interface GroupDispatcherOptions {
  llm: LlmRuntime
  /** 全部群成员。 */
  members: readonly AgentDefinition[]
  /** 调度员 agent id（无 @ 消息的默认入口）。 */
  dispatcherId: string
  /** 共享工具集：数组或按名注册表（每个成员按自己的白名单解析）。 */
  tools: ToolSource
  /** 长期记忆钩子（每个发言 agent 各自的空间 + 共享画像）。 */
  memory?: AgentMemoryHooks
  /** 自我进化钩子（playbook 注入 + 每轮轨迹入队）。 */
  evolution?: AgentEvolutionHooks
  /**
   * 工具配额闸：本轮所有成员共用这一个实例（接力链再长也只有一份预算）。
   * 缺省时调度器自建一个，只覆盖本轮；要"每会话"累计，由协调器按
   * conversationId 缓存同一个闸传进来。
   */
  quota?: SessionQuota
  /** 单条用户消息触发的最大接力轮次，默认 8。 */
  maxTurns?: number
  /** 入口 @ 多成员并行扇出的并发上限，默认 3（供应商限流保护）。 */
  fanoutConcurrency?: number
  /**
   * 「你在跟谁说话」身份句（可选）：群成员与单聊一样要知道用户的名字，
   * 否则群聊里会出现「单聊叫得出名字、群里退回『您』」这种割裂。
   * 与协调器转发的是同一个钩子，来源见 apps/server/src/routes/profile.ts。
   */
  identity?: () => string | undefined
}

/**
 * 群历史窗口的默认 token 预算。
 *
 * 直接取 @ryharness/agent 的同一个常量，而不是在这里另写一份：协调器从库里取行
 * 用的也是这个数，两边口径一旦分叉（这里退回字符、那里用 token），群历史就会在
 * ASCII 文本上被再收一刀、中文上被放行四倍，而症状只表现为"模型好像忘事"。
 */
export const DEFAULT_HISTORY_BUDGET_TOKENS = AGENT_DEFAULT_HISTORY_BUDGET_TOKENS

/** 入口 @ 多成员并行扇出的默认并发上限。 */
export const DEFAULT_FANOUT_CONCURRENCY = 3

const DEFAULT_MAX_TURNS = 8

/**
 * 把群历史格式化为"名字: 内容"行，并按 token 预算从最旧裁剪。
 *
 * 口径是真 token（{@link estimateTokens}）而不是字符数：字符口径只在纯 ASCII 下
 * 近似成立，同一份预算在中文群聊里会多送 4 倍；而 ASCII 群聊恰恰是"看起来没超、
 * 实际被收窄"的那一侧。逐行权重与 @ryharness/session 的
 * {@link HISTORY_BUDGET_TOKENS} 权重函数（`estimateTokens(行) + 1` 的换行）逐条
 * 对齐，因此同一个预算在两边裁出的行集相同。
 * @param history - 协调器已格式化并按同一口径裁过的群历史条目。
 * @param budgetTokens - token 预算；非有限值（`Infinity`）表示不裁。
 */
export function buildGroupContext(history: readonly GroupHistoryEntry[], budgetTokens: number): string {
  if (!Number.isFinite(budgetTokens)) return history.map(groupLine).join('\n')
  const lines = history.map((entry) => {
    return { text: groupLine(entry), tokens: estimateTokens(groupLine(entry)) + 1 }
  })
  let total = lines.reduce((sum, line) => {
    return sum + line.tokens
  }, 0)
  let start = 0
  while (total > budgetTokens && start < lines.length) {
    total -= (lines[start] as { text: string; tokens: number }).tokens
    start++
  }
  return lines
    .slice(start)
    .map((line) => {
      return line.text
    })
    .join('\n')
}

/** 群历史的一行（与 @ryharness/session 的 groupHistoryRowWeight 同一拼法）。 */
function groupLine(entry: GroupHistoryEntry): string {
  return `${entry.speaker}: ${entry.text}`
}

function messageText(message: AssistantMessage): string {
  return message.content
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}

/** 把一个成员的 AgentLoop 事件翻译为群事件（补上 agentId / agentName）。 */
async function* memberEvents(
  agentId: string,
  agentName: string,
  source: AsyncGenerator<AgentLoopEvent>,
): AsyncGenerator<GroupEvent> {
  for await (const event of source) {
    switch (event.type) {
      case 'text-delta':
        yield { type: 'text-delta', agentId, agentName, text: event.text }
        break
      case 'tool-call-start':
        yield {
          type: 'tool-call-start',
          agentId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        }
        break
      case 'tool-result':
        yield {
          type: 'tool-result',
          agentId,
          callId: event.callId,
          name: event.name,
          isError: event.isError,
          result: event.result,
        }
        break
      case 'done':
        break
      case 'error':
        yield event
        break
    }
  }
}

/** 取消事件：与 AgentLoop 的 AbortedError 对齐，协调器落 [error:ABORTED] system 消息。 */
function abortedEvent(): GroupEvent {
  return { type: 'error', message: 'agent run aborted', code: ABORTED_CODE }
}

/** 记忆钩子可选的批量召回面（@ryharness/memory 的 MemoryService 提供）。 */
interface MemoryRecallMany {
  recallMany(agentIds: readonly string[], inputText: string): Promise<Map<string, string | undefined>>
}

function supportsRecallMany(memory: AgentMemoryHooks): memory is AgentMemoryHooks & MemoryRecallMany {
  return typeof (memory as Partial<MemoryRecallMany>).recallMany === 'function'
}

/**
 * 一次扇出内的记忆视图：同一段输入只召回一次，多成员共享。
 *
 * 扇出的 N 个成员拿到的是同一个 prompt（同一段用户输入 + 同一份群历史），于是
 * 它们的记忆召回必然是同一段输入的 N 次重复：一次 fan-out 要打 N 次 embedding
 * 网络请求、N 次 BM25 扫描。记忆系统实现了 {@link MemoryRecallMany} 就走批量
 * 召回（N 个成员一次拿齐），否则退化成并发调用 recall（此时内存侧的请求合并
 * 仍会把同一段文本的网络往返压成一次）。
 *
 * 视图的作用域只有这一次扇出：接力链每轮输入不同，不共享。
 */
class FanoutMemory {
  /** 按输入文本缓存的共享召回结果（同一段输入只建一次 promise）。 */
  private readonly byText = new Map<string, Promise<Map<string, string | undefined>>>()

  constructor(
    private readonly memory: AgentMemoryHooks,
    private readonly memberIds: readonly string[],
  ) {}

  recall(agentId: string, inputText: string): Promise<string | undefined> {
    return this.shared(inputText).then((blocks) => {
      return blocks.get(agentId)
    })
  }

  enqueueExtraction(agentId: string, agentName: string, conversationId: string, turnText: string): void {
    this.memory.enqueueExtraction(agentId, agentName, conversationId, turnText)
  }

  /**
   * 交回 AgentLoop 的钩子形状。
   *
   * 同步召回与后台补正按底层是否实现**条件**透传：漏掉它们，扇出里的成员就退回
   * await 路径，首 token 前白白多等一次 embedding 网络往返；而补一个恒定存在、
   * 永远返回 undefined 的 recallSync 更糟——AgentLoop 会以为同步路径跑过了而跳过
   * await 兜底，记忆在群聊里静默失效。
   */
  asHooks(): AgentMemoryHooks {
    // bind 不是多余动作：memory 可能是 MemoryService（原型方法 + this 状态，
    // recallRefine 还有 this 相关的默认参数），裸取出来调用会在进入函数体之前就抛
    // TypeError，再被 catch 吞成「本轮没注入记忆」——静默失效比崩更难查。
    const sync = this.memory.recallSync?.bind(this.memory)
    const refine = this.memory.recallRefine?.bind(this.memory)
    return {
      recall: (agentId, inputText) => {
        return this.recall(agentId, inputText)
      },
      enqueueExtraction: (agentId, agentName, conversationId, turnText) => {
        return this.enqueueExtraction(agentId, agentName, conversationId, turnText)
      },
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

  private shared(inputText: string): Promise<Map<string, string | undefined>> {
    const hit = this.byText.get(inputText)
    if (hit !== undefined) return hit
    const pending = supportsRecallMany(this.memory)
      ? this.memory.recallMany(this.memberIds, inputText)
      : Promise.all(
          this.memberIds.map((agentId) => {
            return this.memory.recall(agentId, inputText).then((block) => {
              return [agentId, block] as const
            })
          }),
        ).then((entries) => {
          return new Map(entries)
        })
    this.byText.set(inputText, pending)
    return pending
  }
}

/** 每轮重新读取取消状态（signal 可能在 await 期间被中止）。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** 一个成员一轮发言的收尾信息（事件已在生成过程中增量转发）。 */
interface MemberTurnOutcome {
  /** 完成发言时为该成员的完整 assistant 消息。 */
  assistant?: AssistantMessage
  /** 该成员是否以失败/取消收尾（不再接力）。 */
  halted: boolean
  /** 该成员用 handoff 工具登记的交接请求（扇出路径的接力信号）。 */
  handoffs?: HandoffRequest[]
}

/** 扇出增量项：事件边生成边转发，outcome 在该成员收尾时给出。 */
type FanoutItem =
  | { kind: 'event'; index: number; event: GroupEvent }
  | { kind: 'outcome'; index: number; outcome: MemberTurnOutcome | undefined }

/**
 * 单个成员的事件队列：生成一块推一块，close 之后 drain 结束。
 * 增量转发靠它把「成员还在跑」和「消费方正在读」解耦。
 */
class EventQueue {
  private readonly items: GroupEvent[] = []
  private readonly waiters: (() => void)[] = []
  private closed = false

  push(event: GroupEvent): void {
    this.items.push(event)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift()
      if (resolve === undefined) return
      resolve()
    }
  }

  /** 按产生顺序取完本队列；中途到达的事件实时 yield，不必等整批扇出结束。 */
  async *drain(): AsyncGenerator<GroupEvent> {
    for (;;) {
      while (this.items.length > 0) {
        yield this.items.shift() as GroupEvent
      }
      // 下面三步之间没有 await，push() 不可能插进来丢唤醒。
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }
}

/** 群聊调度器。无状态：每个 turn 调 runTurn。 */
export class GroupDispatcher {
  private readonly maxTurns: number
  private readonly fanoutConcurrency: number
  private readonly quota: SessionQuota

  constructor(private readonly options: GroupDispatcherOptions) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.fanoutConcurrency = Math.max(1, options.fanoutConcurrency ?? DEFAULT_FANOUT_CONCURRENCY)
    this.quota = options.quota ?? createSessionQuota()
    if (
      !options.members.some((member) => {
        return member.id === options.dispatcherId
      })
    ) {
      throw new Error(`@ryharness/group: dispatcher "${options.dispatcherId}" is not a group member`)
    }
  }

  /**
   * 处理一条用户消息：入口路由（多 @ 目标并行扇出）→ 逐 agent 生成 → @接力 →
   * 护栏终止。
   * @param input - 用户原文、群历史、turn 序号、工具上下文与取消信号。
   * @returns 事件异步流；dispatch 事件由协调器落 dispatch_events。
   */
  async *runTurn(input: {
    text: string
    history: readonly GroupHistoryEntry[]
    workspaceRoot: string
    /** 当前会话 id：按会话落数据的工具（待办）据此分组；缺省时那类工具会拒绝执行。 */
    conversationId?: string
    turnIndex: number
    historyBudgetTokens?: number
    /** 调用方取消信号：取消后不再接力，以 code=ABORTED 的 error 事件收尾。 */
    signal?: AbortSignal
  }): AsyncGenerator<GroupEvent> {
    const { members, dispatcherId } = this.options
    const signal = input.signal
    const budget = input.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS
    const context = buildGroupContext(input.history, budget)
    const memberById = new Map(
      members.map((member) => {
        return [member.id, member]
      }),
    )
    const turnIndex = input.turnIndex
    const toolContext: ToolContext = {
      workspaceRoot: input.workspaceRoot,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(signal === undefined ? {} : { signal }),
    }
    if (signal?.aborted === true) {
      yield abortedEvent()
      yield { type: 'turn-done', turns: 0 }
      return
    }

    // ---- 入口路由 ----
    const userMentions = parseMentions(input.text, members)
    const queue: string[] = []
    if (userMentions.length > 0) {
      for (const agent of userMentions) {
        queue.push(agent.id)
        yield { type: 'dispatch', toAgent: agent.id, reason: 'user-mention', turnIndex }
      }
    } else {
      queue.push(dispatcherId)
      yield { type: 'dispatch', toAgent: dispatcherId, reason: 'default-dispatcher', turnIndex }
    }

    const speakers: string[] = []
    let turns = 0
    let relayText = ''
    let stopped = false
    // handoff 工具登记的交接任务：成员被工具派工时，它的 prompt 必须带上任务本身——
    // 真机实测不带任务的接力 prompt 只有上一位的正文（「交给我，先去办。」），接手
    // 成员根本不知道要做什么，只能回「需要做什么？」。
    const handoffTasks = new Map<string, { fromId: string; task: string }>()

    // ---- 入口 @ 多目标并行扇出 ----
    // 多个 @ 目标并发起跑（上限 fanoutConcurrency），谁先出首 token 谁先出，
    // 但结果一律按 @ 出现顺序提交，事件顺序与消息落库顺序都确定。接力链
    // 仍在下面串行执行：接力的 prompt 依赖上一个发言者的输出。
    const entry = queue.splice(0, queue.length)
    if (entry.length > 1) {
      const allowed = Math.max(0, this.maxTurns - turns)
      const targets: AgentDefinition[] = []
      let unknownId: string | undefined
      for (const id of entry.slice(0, allowed)) {
        const member = memberById.get(id)
        if (member === undefined) {
          unknownId = id
          break
        }
        targets.push(member)
      }
      const dropped = entry.slice(allowed)
      if (unknownId !== undefined) {
        yield {
          type: 'error',
          message: `@ryharness/group: agent "${unknownId}" is not a group member`,
          code: 'UNKNOWN_AGENT',
        }
        stopped = true
      } else {
        const relayed: string[] = []
        for await (const item of this.runFanout(targets, this.promptText(context, input.text), toolContext, signal)) {
          // 成员还在跑就先把已产出的事件推出去，不等整批扇出结束。
          if (item.kind === 'event') {
            yield item.event
            continue
          }
          const { index, outcome } = item
          if (outcome === undefined) {
            // 未起跑就取消：后续目标不再发言，以 ABORTED 收尾。
            if (isAborted(signal)) yield abortedEvent()
            stopped = true
            break
          }
          const member = targets[index] as AgentDefinition
          if (outcome.halted || outcome.assistant === undefined) {
            // error 事件已随事件流发出：不再由该成员接力（其他成员的结果仍提交）。
            stopped = true
            continue
          }
          const assistant = outcome.assistant
          turns++
          speakers.push(member.id)
          yield { type: 'agent-message', agentId: member.id, message: assistant }

          const outputText = messageText(assistant)
          relayText = outputText
          // 交接工具登记的请求优先（结构化信号）；没有才退回文本里的 @/[交办]。
          const relayedByTool = new Set<string>()
          // 派工方是否已经发过言：它接过话就算做过判断，此后成员再 @ 它是回程收口，
          // 不是新任务。
          //
          // 判据用 speakers（发言事实）而不是 handoffTasks（工具调用记录），因为
          // 真机上 Ryen 派工常常就是正文里一句「@CodeBot 你来」——工具没被调用，
          // 按工具判会把回程当成正常调度，用户看到的仍是「派工方在原地复述」。
          const dispatcherSpoke = speakers.includes(this.options.dispatcherId)
          // 工具交接同样要走收口判据（与串行路径同一口径，详见该处的完整说明）：
          // 成员把活交回派工方而派工方已经发过言，这条 @/交接是报备不是新任务。
          // 此前这里只对正文 @ 做了这个判断（下面那处），工具交接一路排到队列里，
          // 于是扇出场景同样留下「交接 + 循环保护」两条矛盾的轨迹。
          const toolHandoffs = (outcome.handoffs ?? []).filter((handoff) => {
            return handoff.toId !== member.id
          })
          const relayToolHandoffs = dispatcherSpoke
            ? toolHandoffs.filter((handoff) => {
                return handoff.toId !== this.options.dispatcherId
              })
            : toolHandoffs
          for (const handoff of relayToolHandoffs) {
            if (relayedByTool.has(handoff.toId)) continue
            relayedByTool.add(handoff.toId)
            relayed.push(handoff.toId)
            handoffTasks.set(handoff.toId, { fromId: member.id, task: handoff.task })
            yield {
              type: 'dispatch',
              fromAgent: member.id,
              toAgent: handoff.toId,
              reason: `交接：${handoff.task}`,
              turnIndex,
            }
          }
          const routingText = handoffText(outputText)
          if (relayedByTool.size === 0 && parseMentions(routingText, [member]).length > 0) {
            yield { type: 'dispatch', fromAgent: member.id, toAgent: member.id, reason: 'loop-guard', turnIndex }
            continue
          }
          for (const target of parseMentions(routingText, members)) {
            if (relayedByTool.has(target.id)) continue
            // 同串行路径的收口语义（见下方 wrap-up 处的完整说明）：派工方自己
            // 派过活之后，成员再 @ 它是道谢/报备，不是新任务。扇出时派工方正在
            // 等所有人的结果，成员把它排回队列只会让 Ryen 复述一遍派工。
            if (target.id === this.options.dispatcherId && dispatcherSpoke) continue
            relayed.push(target.id)
            yield {
              type: 'dispatch',
              fromAgent: member.id,
              toAgent: target.id,
              reason: `relay @${target.name}`,
              turnIndex,
            }
          }
        }
        if (dropped.length > 0) {
          yield {
            type: 'dispatch',
            fromAgent: speakers[speakers.length - 1],
            toAgent: dropped[0] as string,
            reason: 'max-turns',
            turnIndex,
          }
          stopped = true
        }
        if (!stopped) queue.push(...relayed)
      }
    } else {
      queue.push(...entry)
    }

    // ---- 接力链（串行：prompt 依赖上一个发言者）----
    while (queue.length > 0 && !stopped) {
      if (turns >= this.maxTurns) {
        yield {
          type: 'dispatch',
          fromAgent: speakers[speakers.length - 1],
          toAgent: queue[0] as string,
          reason: 'max-turns',
          turnIndex,
        }
        break
      }
      const nextId = queue.shift() as string
      const member = memberById.get(nextId)
      if (member === undefined) {
        yield {
          type: 'error',
          message: `@ryharness/group: agent "${nextId}" is not a group member`,
          code: 'UNKNOWN_AGENT',
        }
        break
      }

      // ---- 接力护栏（首个响应者免检）----
      if (speakers.length > 0) {
        const last = speakers[speakers.length - 1] as string
        const twoBack = speakers.length >= 2 ? (speakers[speakers.length - 2] as string) : undefined
        if (nextId === last || (twoBack !== undefined && nextId === twoBack)) {
          yield { type: 'dispatch', fromAgent: last, toAgent: nextId, reason: 'loop-guard', turnIndex }
          break
        }
      }

      // ---- 生成回复 ----
      // 被 handoff 工具派工的成员拿到的是任务本身；文本接力的成员拿到上一位的发言。
      const pendingTask = handoffTasks.get(nextId)
      const taskFrom =
        pendingTask === undefined
          ? undefined
          : (members.find((m) => {
              return m.id === pendingTask.fromId
            })?.name ?? pendingTask.fromId)
      const body =
        pendingTask === undefined
          ? speakers.length === 0
            ? input.text
            : relayText
          : `——${taskFrom} 交给你的任务——\n${pendingTask.task}`
      const promptText = this.promptText(context, body)
      let assistant: AssistantMessage | undefined
      // 交接工具先把请求攒在这轮里，等这一位说完再统一转成 dispatch 事件
      // （工具执行发生在 AgentLoop 内部，事件流由外层按顺序 yield）。
      const handoffs: HandoffRequest[] = []
      const loop = this.createLoop(
        this.definitionOf(member),
        (message) => {
          assistant = message
        },
        undefined,
        [this.handoffTool(member, handoffs)],
      )
      let failed = false
      try {
        for await (const event of memberEvents(
          member.id,
          member.name,
          loop.run({ text: promptText }, toolContext, { signal }),
        )) {
          if (event.type === 'error') failed = true
          yield event
        }
      } catch (error) {
        if (!isAbortedError(error)) throw error
        // 取消时 AgentLoop 已把收到的半截文本通过 onAssistantMessage 交回来；
        // 不补发的话用户看得到半句话，刷新后消息却会消失。
        if (assistant !== undefined) {
          yield { type: 'agent-message', agentId: member.id, message: assistant }
        }
        yield { type: 'error', message: errorChain(error), code: ABORTED_CODE }
        break
      }
      if (failed || assistant === undefined) {
        // error 事件已发出：中断本 turn（协调器会以 system 消息落库）。
        break
      }

      turns++
      speakers.push(member.id)
      yield { type: 'agent-message', agentId: member.id, message: assistant }

      // ---- 接力解析 ----
      const outputText = messageText(assistant)
      relayText = outputText
      // 交接工具登记的请求优先（结构化、模型守得住）；没有才退回文本里的 @ 提及。
      const byTool = handoffs.filter((handoff) => {
        return handoff.toId !== member.id
      })
      // 工具交接也要认「回程收口」：成员把活交回派工方、而派工方这轮已经发过言，
      // 这一轮就到此为止。
      //
      // 此前只有下面 wrapsUp 那条（正文 @）认，工具这条路漏了——而工具恰恰是系统
      // 提示里明确推荐的方式（模型常照抄成员名却漏掉 @ 号，tool calling 却可靠）。
      // 漏掉的后果不是「派工方又说一遍」（A-B-A 护栏拦得住那个），而是**先排了一条
      // 「交接」假产**，紧接着护栏再补一条 loop-guard：界面上两条互相矛盾的轨迹并排，
      // 用户看到的就是「别人做完了，调度员还在说指派」——活早干完了。
      const dispatcherSpoke = speakers.includes(this.options.dispatcherId)
      const wrapUpByTool =
        dispatcherSpoke &&
        byTool.some((handoff) => {
          return handoff.toId === this.options.dispatcherId
        })
      // 收口只摘掉交回派工方的那一条：同一句里若还派给了别的成员，那部分是真活，
      // 照常排进队列，不因为一次收口把整轮掐掉。
      const relayHandoffs = wrapUpByTool
        ? byTool.filter((handoff) => {
            return handoff.toId !== this.options.dispatcherId
          })
        : byTool
      const seenTargets = new Set<string>()
      for (const handoff of relayHandoffs) {
        if (seenTargets.has(handoff.toId)) continue
        seenTargets.add(handoff.toId)
        queue.push(handoff.toId)
        handoffTasks.set(handoff.toId, { fromId: member.id, task: handoff.task })
        yield {
          type: 'dispatch',
          fromAgent: member.id,
          toAgent: handoff.toId,
          reason: `交接：${handoff.task}`,
          turnIndex,
        }
      }
      if (wrapUpByTool && relayHandoffs.length === 0) {
        // 收口掉的就是链条的尾巴：留一条终止事件，轨迹才有头有尾（与 wrapsUp 同口径）。
        yield {
          type: 'dispatch',
          fromAgent: member.id,
          toAgent: this.options.dispatcherId,
          reason: 'loop-guard',
          turnIndex,
        }
        break
      }
      // 与扇出路径同一口径：只解析 [交办] 行（无标记行时退回整段）。
      const routingText = handoffText(outputText)
      const selfMentioned = parseMentions(routingText, [member]).length > 0
      if (selfMentioned && byTool.length === 0) {
        yield { type: 'dispatch', fromAgent: member.id, toAgent: member.id, reason: 'loop-guard', turnIndex }
        break
      }
      // @ 的目标是派工方、而派工方这轮已经发过言 = 回程收口：链条到此为止。
      //
      // 真机症状：用户要一份 PDF，CodeBot 交付后正文写「@Ryen 请查收」，于是
      // 排产出一条 CodeBot → Ryen 的接力；Ryen 刚派过活，再被拉回来只会复述
      // 「已经安排给 CodeBot 了」——活明明干完了，用户看到的是它在原地打转。
      //
      // 之前只有 A-B-A 护栏兜着：它确实阻止了 Ryen 再生成，但**已经先吐了一条
      // relay 派工事件**，界面上于是留下「接力 → 循环保护」两条互相矛盾的轨迹，
      // 观感比真的转圈还糟。所以判据前移到「派工方发过言 + @ 指向派工方」——
      // 此时这条 @ 是道谢/报备，不是新任务，直接收口。
      //
      // 事件类型沿用 loop-guard 而不是新造一个：终止这件事的对外契约早已是它
      // （UI 按它渲染警示色、测试按它断言），换名字等于凭空改契约；而「为什么停」
      // 的差别已经体现在「不再先吐一条假接力」上。
      const mentions = parseMentions(routingText, members)
      const wrapsUp =
        dispatcherSpoke &&
        mentions.some((target) => {
          return target.id === this.options.dispatcherId
        })
      if (wrapsUp && byTool.length === 0) {
        yield {
          type: 'dispatch',
          fromAgent: member.id,
          toAgent: this.options.dispatcherId,
          reason: 'loop-guard',
          turnIndex,
        }
        break
      }
      const targets = mentions.filter((target) => {
        return dispatcherSpoke && target.id === this.options.dispatcherId ? false : true
      })
      for (const target of targets) {
        if (seenTargets.has(target.id)) continue
        seenTargets.add(target.id)
        queue.push(target.id)
        yield { type: 'dispatch', fromAgent: member.id, toAgent: target.id, reason: `relay @${target.name}`, turnIndex }
      }
    }

    yield { type: 'turn-done', turns }
  }

  /** 拼接成员 prompt：群历史（已裁剪）+ 新消息/接力文本。 */
  private promptText(context: string, body: string): string {
    return context.length > 0 ? `${context}\n\n——新消息——\n${body}` : body
  }

  /**
   * 成员定义（按身份微调）。
   *
   * 调度员：追加路由指令（{@link dispatcherRoutingSuffix}），并把 handoff 加进工具
   * 白名单——AgentLoop 按 definition.tools 过滤工具，忘了加，模型看得见工具声明却
   * 调不动，交接静默失效（这正是最初那版接线漏掉的一环）。
   * 其他成员：追加交接提示（{@link memberHandoffSuffix}）——接力链上任何一位都可能
   * 要把活往下传，不给指引，模型不知道 handoff 该在什么时候用，接力永远只有一跳。
   */
  private definitionOf(member: AgentDefinition): AgentDefinition {
    const isDispatcher = member.id === this.options.dispatcherId
    return {
      ...member,
      tools: member.tools.includes(HANDOFF_TOOL) ? member.tools : [...member.tools, HANDOFF_TOOL],
      systemPrompt:
        member.systemPrompt +
        (isDispatcher
          ? dispatcherRoutingSuffix(this.options.members, this.options.dispatcherId)
          : memberHandoffSuffix(this.options.members, member.id)),
    }
  }

  private createLoop(
    definition: AgentDefinition,
    onAssistantMessage: (message: AssistantMessage) => void,
    memory?: AgentMemoryHooks,
    extraTools: readonly Tool[] = [],
  ): AgentLoop {
    const hooks = memory ?? this.options.memory
    return new AgentLoop({
      definition,
      llm: this.options.llm,
      tools: [...listTools(this.options.tools), ...extraTools],
      onAssistantMessage,
      quota: this.quota,
      ...(hooks === undefined ? {} : { memory: hooks }),
      ...(this.options.identity === undefined ? {} : { identity: this.options.identity }),
      ...(this.options.evolution === undefined ? {} : { evolution: this.options.evolution }),
    })
  }

  /**
   * 交接工具：把活交给群里另一位成员。
   *
   * 为什么必须是工具而不是「回复里写 @名字」：真机（DeepSeek-V3）实测，模型会照抄
   * 提示里的成员名却漏掉 @ 号（回复是「让工程师查最近没去过的店」，一个 @ 都没有），
   * 接力链于是静默失效——界面上只看到调度员答了话，没人接手，而且没有任何报错。
   * 工具调用是结构化的：同一个模型在同一轮里的 tool calling 完全可靠（冒烟脚本里
   * `echo` 工具的参数 JSON 一次成型），所以把路由信号放到工具参数里。
   *
   * 目标只认本群成员的名字或 id：名单外的名字在 execute 里直接报错，模型会看到
   * 中文失败原因并在下一轮改对，而不是把活派给不存在的人。
   */
  private handoffTool(from: AgentDefinition, sink: HandoffRequest[]): Tool {
    const roster = this.options.members
      .filter((member) => {
        return member.id !== from.id
      })
      .map((member) => {
        return `${member.name}（${member.id}）`
      })
      .join('、')
    return {
      name: HANDOFF_TOOL,
      description:
        `把任务交接给群里的另一位成员。可交接的成员：${roster || '（没有其他成员）'}。` +
        '自己能答就直接答；需要别人做（或需要别人的信息）时才调用。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '接手成员的显示名或 id，如「工程师」或「ryen-team-coding」' },
          task: { type: 'string', description: '交给对方要做的具体事情，写清楚交付什么' },
        },
        required: ['to', 'task'],
      },
      execute: async (args: unknown): Promise<ToolResult> => {
        const { to, task } = (args ?? {}) as { to?: unknown; task?: unknown }
        const name = typeof to === 'string' ? to.trim() : ''
        const detail = typeof task === 'string' ? task.trim() : ''
        if (name.length === 0 || detail.length === 0) {
          return { content: '交接失败：to 与 task 都要填。', isError: true }
        }
        const target =
          this.options.members.find((member) => {
            return member.name === name || member.id === name
          }) ?? undefined
        if (target === undefined) {
          return {
            content: `交接失败：「${name}」不在本群。可交接的是：${roster || '（没有其他成员）'}`,
            isError: true,
          }
        }
        if (target.id === from.id) {
          return { content: '交接失败：不能交给自己。', isError: true }
        }
        sink.push({ fromId: from.id, toId: target.id, task: detail })
        return { content: `已交给 ${target.name}：${detail}`, isError: false }
      },
    }
  }

  /**
   * 并发跑一批成员（工作池，上限 fanoutConcurrency），按 @ 出现顺序增量产出。
   *
   * 事件边生成边 yield：排在第 i 位的成员不必等第 i+1..n 位跑完，它的
   * 首 token 一到就转发（这才是流式，不是等整批缓冲完再一次性倒出来）。
   * 消费顺序仍严格按 @ 出现顺序，所以消息顺序不随谁先跑完变化。
   */
  private async *runFanout(
    targets: readonly AgentDefinition[],
    promptText: string,
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<FanoutItem> {
    const queues = targets.map(() => {
      return new EventQueue()
    })
    const outcomes: (MemberTurnOutcome | undefined)[] = new Array(targets.length)
    // 同一段输入的记忆召回在整个扇出里共享一次（不再 N 倍 embedding 往返）。
    const memory =
      this.options.memory === undefined
        ? undefined
        : new FanoutMemory(
            this.options.memory,
            targets.map((target) => {
              return target.id
            }),
          ).asHooks()
    let failure: unknown
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        if (isAborted(signal)) return
        const index = next++
        const queue = queues[index] as EventQueue
        try {
          outcomes[index] = await this.runMember(
            targets[index] as AgentDefinition,
            promptText,
            toolContext,
            signal,
            queue,
            memory,
          )
        } finally {
          queue.close()
        }
      }
    }
    const lanes = Math.min(this.fanoutConcurrency, targets.length)
    const running = Promise.all(
      Array.from({ length: lanes }, () => {
        return worker()
      }),
    )
    // 所有 lane 收工后把没跑到的成员的队列也关上（含取消导致的提前返回），
    // 否则 drain 会一直等下去。
    const settle = (error?: unknown): void => {
      failure = error
      for (const queue of queues) queue.close()
    }
    void running.then(
      () => {
        settle()
      },
      (error: unknown) => {
        settle(error)
      },
    )
    for (const [index, queue] of queues.entries()) {
      for await (const event of queue.drain()) {
        yield { kind: 'event', index, event }
      }
      if (failure !== undefined) throw failure
      // outcome 为 undefined = 该成员因取消压根没起跑。
      yield { kind: 'outcome', index, outcome: outcomes[index] }
    }
  }

  /** 跑一个成员，事件生成一块往队列推一块（并行扇出时增量转发）。 */
  private async runMember(
    member: AgentDefinition,
    promptText: string,
    toolContext: ToolContext,
    signal: AbortSignal | undefined,
    queue: EventQueue,
    memory?: AgentMemoryHooks,
  ): Promise<MemberTurnOutcome> {
    let assistant: AssistantMessage | undefined
    const handoffs: HandoffRequest[] = []
    const loop = this.createLoop(
      this.definitionOf(member),
      (message) => {
        assistant = message
      },
      memory,
      [this.handoffTool(member, handoffs)],
    )
    let failed = false
    try {
      for await (const event of memberEvents(
        member.id,
        member.name,
        loop.run({ text: promptText }, toolContext, { signal }),
      )) {
        if (event.type === 'error') failed = true
        queue.push(event)
      }
    } catch (error) {
      if (!isAbortedError(error)) throw error
      queue.push({ type: 'error', message: errorChain(error), code: ABORTED_CODE })
      return { halted: true }
    }
    return {
      halted: failed || assistant === undefined,
      ...(assistant === undefined ? {} : { assistant }),
      ...(handoffs.length === 0 ? {} : { handoffs }),
    }
  }
}
