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
 * - **接力**：任何 agent 输出含 @Y → Y 接力。护栏：
 *   - 单条用户消息触发的总接力轮次 ≤ maxTurns（默认 8）；
 *   - 连续两次路由同一 agent（自己 @ 自己 / 冷却不足）→ 停止；
 *   - A@B、B@A 互踢（A-B-A 模式）→ 停止；
 *   - 每次停止都写 dispatch 事件（reason: 'loop-guard' / 'max-turns'）。
 *   接力链始终串行：接力的 prompt 依赖上一个发言者的输出。
 * - **上下文**：所有成员共享群历史，发言带"名字:"前缀，按字符预算从
 *   最旧裁剪（默认 30k 字符，token 的近似）。
 * - **取消**：runTurn 接受 AbortSignal，透传给每个 AgentLoop 与工具；取消
 *   后不再接力，以 code=ABORTED 的 error 事件收尾。
 * @module @ryagent/group/dispatcher
 */

import type {
  AgentDefinition,
  AgentEvolutionHooks,
  AgentLoopEvent,
  AgentMemoryHooks,
  Tool,
  ToolContext,
  ToolResult,
} from '@ryagent/agent'
import { ABORTED_CODE, AgentLoop, isAbortedError } from '@ryagent/agent'
import type { AssistantMessage, LlmRuntime, ToolCallId } from '@ryagent/llm'
import { errorChain } from '@ryagent/llm'
import { parseMentions } from './mentions.ts'

/** 调度员 system prompt 追加的路由指令。 */
export const DISPATCHER_ROUTING_SUFFIX = [
  '',
  '你是本群的调度员，负责协调群成员。规则：',
  '1. 能直接回答的问题直接回答，回复中不要 @ 任何人，一轮即结束。',
  '2. 需要转交时，在回复中 @成员名（如 @CodeBot）把任务交出去。',
  '3. 绝不 @ 自己。',
].join('\n')

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
  /** 共享工具集。 */
  tools: readonly Tool[]
  /** 长期记忆钩子（每个发言 agent 各自的空间 + 共享画像）。 */
  memory?: AgentMemoryHooks
  /** 自我进化钩子（playbook 注入 + 每轮轨迹入队）。 */
  evolution?: AgentEvolutionHooks
  /** 单条用户消息触发的最大接力轮次，默认 8。 */
  maxTurns?: number
  /** 入口 @ 多成员并行扇出的并发上限，默认 3（供应商限流保护）。 */
  fanoutConcurrency?: number
}

/** 群历史字符预算默认值（token 的字符数近似）。 */
export const DEFAULT_HISTORY_BUDGET_CHARS = 30_000

/** 入口 @ 多成员并行扇出的默认并发上限。 */
export const DEFAULT_FANOUT_CONCURRENCY = 3

const DEFAULT_MAX_TURNS = 8

/** 把群历史格式化为"名字: 内容"行，并按预算从最旧裁剪。 */
export function buildGroupContext(history: readonly GroupHistoryEntry[], budgetChars: number): string {
  const lines = history.map((entry) => {
    return `${entry.speaker}: ${entry.text}`
  })
  let total = lines.reduce((sum, line) => {
    return sum + line.length + 1
  }, 0)
  let start = 0
  while (total > budgetChars && start < lines.length) {
    total -= (lines[start] as string).length + 1
    start++
  }
  return lines.slice(start).join('\n')
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

  constructor(private readonly options: GroupDispatcherOptions) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.fanoutConcurrency = Math.max(1, options.fanoutConcurrency ?? DEFAULT_FANOUT_CONCURRENCY)
    if (
      !options.members.some((member) => {
        return member.id === options.dispatcherId
      })
    ) {
      throw new Error(`@ryagent/group: dispatcher "${options.dispatcherId}" is not a group member`)
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
    turnIndex: number
    historyBudgetChars?: number
    /** 调用方取消信号：取消后不再接力，以 code=ABORTED 的 error 事件收尾。 */
    signal?: AbortSignal
  }): AsyncGenerator<GroupEvent> {
    const { members, dispatcherId } = this.options
    const signal = input.signal
    const budget = input.historyBudgetChars ?? DEFAULT_HISTORY_BUDGET_CHARS
    const context = buildGroupContext(input.history, budget)
    const memberById = new Map(
      members.map((member) => {
        return [member.id, member]
      }),
    )
    const turnIndex = input.turnIndex
    const toolContext: ToolContext = {
      workspaceRoot: input.workspaceRoot,
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
          message: `@ryagent/group: agent "${unknownId}" is not a group member`,
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
          if (parseMentions(outputText, [member]).length > 0) {
            yield { type: 'dispatch', fromAgent: member.id, toAgent: member.id, reason: 'loop-guard', turnIndex }
            continue
          }
          for (const target of parseMentions(outputText, members)) {
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
          message: `@ryagent/group: agent "${nextId}" is not a group member`,
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
      const promptText = this.promptText(context, speakers.length === 0 ? input.text : relayText)
      let assistant: AssistantMessage | undefined
      const loop = this.createLoop(this.definitionOf(member), (message) => {
        assistant = message
      })
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
      const selfMentioned = parseMentions(outputText, [member]).length > 0
      if (selfMentioned) {
        yield { type: 'dispatch', fromAgent: member.id, toAgent: member.id, reason: 'loop-guard', turnIndex }
        break
      }
      for (const target of parseMentions(outputText, members)) {
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

  /** 调度员发言时追加路由指令。 */
  private definitionOf(member: AgentDefinition): AgentDefinition {
    return member.id === this.options.dispatcherId
      ? { ...member, systemPrompt: member.systemPrompt + DISPATCHER_ROUTING_SUFFIX }
      : member
  }

  private createLoop(definition: AgentDefinition, onAssistantMessage: (message: AssistantMessage) => void): AgentLoop {
    return new AgentLoop({
      definition,
      llm: this.options.llm,
      tools: this.options.tools,
      onAssistantMessage,
      ...(this.options.memory === undefined ? {} : { memory: this.options.memory }),
      ...(this.options.evolution === undefined ? {} : { evolution: this.options.evolution }),
    })
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
  ): Promise<MemberTurnOutcome> {
    let assistant: AssistantMessage | undefined
    const loop = this.createLoop(this.definitionOf(member), (message) => {
      assistant = message
    })
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
    }
  }
}
