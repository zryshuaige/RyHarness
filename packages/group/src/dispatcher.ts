/**
 * 群聊调度器：混合模式（@提及直路由 + 调度员自然语言选路）。
 *
 * 设计要点（与"单独的 LLM 路由调用"方案相对）：
 * - **入口**：用户消息有 @X → X 直接响应（可多个，按出现顺序）；无 @ →
 *   调度员（dispatcherAgentId）响应。调度员的 system prompt 追加路由指令：
 *   能答就答，要转交就在回复里 @成员名。
 * - **选路即生成**：不做结构化路由 LLM 调用——调度员正常生成回复，
 *   解析其输出中的 @提及作为路由信号；输出无 @ 视为"自己回答"，一轮结束。
 * - **接力**：任何 agent 输出含 @Y → Y 接力。护栏：
 *   - 单条用户消息触发的总接力轮次 ≤ maxTurns（默认 8）；
 *   - 连续两次路由同一 agent（自己 @ 自己 / 冷却不足）→ 停止；
 *   - A@B、B@A 互踢（A-B-A 模式）→ 停止；
 *   - 每次停止都写 dispatch 事件（reason: 'loop-guard' / 'max-turns'）。
 * - **上下文**：所有成员共享群历史，发言带"名字:"前缀，按字符预算从
 *   最旧裁剪（默认 30k 字符，token 的近似）。
 * @module @ryagent/group/dispatcher
 */

import type { AgentDefinition, AgentEvolutionHooks, AgentMemoryHooks, Tool, ToolResult } from '@ryagent/agent'
import { AgentLoop } from '@ryagent/agent'
import type { AssistantMessage, LlmRuntime, ToolCallId } from '@ryagent/llm'
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
}

/** 群历史字符预算默认值（token 的字符数近似）。 */
export const DEFAULT_HISTORY_BUDGET_CHARS = 30_000

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

/** 群聊调度器。无状态：每个 turn 调 runTurn。 */
export class GroupDispatcher {
  private readonly maxTurns: number

  constructor(private readonly options: GroupDispatcherOptions) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    if (
      !options.members.some((member) => {
        return member.id === options.dispatcherId
      })
    ) {
      throw new Error(`@ryagent/group: dispatcher "${options.dispatcherId}" is not a group member`)
    }
  }

  /**
   * 处理一条用户消息：入口路由 → 逐 agent 生成 → @接力 → 护栏终止。
   * @param input - 用户原文、群历史、turn 序号与工具上下文。
   * @returns 事件异步流；dispatch 事件由协调器落 dispatch_events。
   */
  async *runTurn(input: {
    text: string
    history: readonly GroupHistoryEntry[]
    workspaceRoot: string
    turnIndex: number
    historyBudgetChars?: number
  }): AsyncGenerator<GroupEvent> {
    const { llm, members, dispatcherId } = this.options
    const budget = input.historyBudgetChars ?? DEFAULT_HISTORY_BUDGET_CHARS
    const context = buildGroupContext(input.history, budget)
    const memberById = new Map(
      members.map((member) => {
        return [member.id, member]
      }),
    )
    const turnIndex = input.turnIndex

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

    while (queue.length > 0) {
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
      const definition: AgentDefinition =
        member.id === dispatcherId
          ? { ...member, systemPrompt: member.systemPrompt + DISPATCHER_ROUTING_SUFFIX }
          : member
      const promptText =
        speakers.length === 0
          ? context.length > 0
            ? `${context}\n\n——新消息——\n${input.text}`
            : input.text
          : context.length > 0
            ? `${context}\n\n——新消息——\n${relayText}`
            : relayText
      const loop = new AgentLoop({
        definition,
        llm,
        tools: this.options.tools,
        onAssistantMessage: (message) => {
          assistant = message
        },
        ...(this.options.memory === undefined ? {} : { memory: this.options.memory }),
        ...(this.options.evolution === undefined ? {} : { evolution: this.options.evolution }),
      })
      let assistant: AssistantMessage | undefined
      let failed = false
      for await (const event of loop.run({ text: promptText }, { workspaceRoot: input.workspaceRoot })) {
        switch (event.type) {
          case 'text-delta':
            yield { type: 'text-delta', agentId: member.id, agentName: member.name, text: event.text }
            break
          case 'tool-call-start':
            yield {
              type: 'tool-call-start',
              agentId: member.id,
              callId: event.callId,
              name: event.name,
              arguments: event.arguments,
            }
            break
          case 'tool-result':
            yield {
              type: 'tool-result',
              agentId: member.id,
              callId: event.callId,
              name: event.name,
              isError: event.isError,
              result: event.result,
            }
            break
          case 'done':
            break
          case 'error':
            failed = true
            yield event
            break
        }
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
}
