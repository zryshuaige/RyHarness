/**
 * SessionCoordinator：把 AgentLoop / GroupDispatcher 的事件流自动落成
 * messages 行，多轮对话从 store 恢复历史，群聊调度链的失败语义保证
 * "已完成的 agent 发言保留，错误以 system 消息落库，不留半成品发言"。
 *
 * 事务边界：LLM 调用是异步且耗时的，不能在跨 await 的整链上持有 SQLite
 * 事务；改为"每条完成的发言一个写入单元"——assistant 发言与其工具结果
 * 消息逐条落库（每条自身原子），错误以 system 消息收尾。半成品定义上
 * 不存在：assistant 消息只在流正常组装完成后写入。
 * @module @ryagent/session/coordinator
 */

import type { AgentDefinition, AgentEvolutionHooks, AgentLoopEvent, AgentMemoryHooks, Tool } from '@ryagent/agent'
import { AgentLoop } from '@ryagent/agent'
import { brandString } from '@ryagent/brand'
import type { GroupEvent, GroupHistoryEntry } from '@ryagent/group'
import { GroupDispatcher, parseMentions } from '@ryagent/group'
import type {
  ContentBlock,
  GenerateOptions,
  LlmRuntime,
  Message,
  MessageId,
  StreamChunk,
  TokenUsage,
  ToolCallId,
} from '@ryagent/llm'
import type { SessionStore } from './store.ts'
import type { StoredMessage, StoredUsage } from './types.ts'

/** 协调器构造参数。 */
export interface CoordinatorOptions {
  store: SessionStore
  llm: LlmRuntime
  /** 可用工具全集（AgentLoop 按 agent 定义白名单过滤）。 */
  tools: readonly Tool[]
  /** 长期记忆（可选）：每个发言 agent 用自己的空间 + 共享画像。 */
  memory?: AgentMemoryHooks
  /** 自我进化（可选）：playbook 注入 + 每轮 delta/反思。 */
  evolution?: AgentEvolutionHooks
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

const HISTORY_PAGE_SIZE = 1000
/** 工具结果消息文本前缀（也是历史格式化时识别工具消息的标志）。 */
const TOOL_RESULT_PREFIX = '〔tool〕'

/** 把 store 的消息行重建为 @ryagent/llm 的 Message（单聊历史用）。 */
function rebuildMessage(row: StoredMessage, agent: AgentDefinition): Message | undefined {
  const id = brandString<MessageId>(row.id)
  const blocks = row.contentBlocks as ContentBlock[]
  if (row.senderType === 'user') {
    return { id, role: 'user', content: blocks, source: { kind: 'user' } }
  }
  if (row.senderType === 'agent') {
    if (row.toolCallId !== undefined) {
      const callId = brandString<ToolCallId>(row.toolCallId)
      return { id, role: 'tool', toolCallId: callId, content: blocks, source: { kind: 'tool', callId } }
    }
    return {
      id,
      role: 'assistant',
      content: blocks,
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

  /** 取走自上次取走以来的用量；没有新事件返回 undefined。 */
  take(): StoredUsage | undefined {
    if (this.calls === 0) return undefined
    const usage: StoredUsage = {
      inputTokens: this.input,
      outputTokens: this.output,
      totalTokens: this.total,
      ...(this.cacheRead === 0 ? {} : { cacheReadTokens: this.cacheRead }),
      ...(this.cacheWrite === 0 ? {} : { cacheWriteTokens: this.cacheWrite }),
      ...(this.reasoning === 0 ? {} : { reasoningTokens: this.reasoning }),
    }
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
 * 包一层 LlmRuntime，只做一件事：截获 `usage` chunk 交给 meter。
 *
 * 用 Proxy 而不是继承——LlmRuntime 是 Typert 服务类，构造与装饰器都不适合
 * 在这里复刻；AgentLoop / GroupDispatcher 也只用 `stream`，其余成员原样转发。
 */
function observeUsage(base: LlmRuntime, meter: UsageMeter): LlmRuntime {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'stream') {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        return (async function* (): AsyncGenerator<StreamChunk> {
          for await (const chunk of target.stream(options)) {
            if (chunk.type === 'usage') meter.add(chunk.usage)
            yield chunk
          }
        })()
      }
    },
  })
}

/** 把 TokenUsage 归一成落库形态。 */
function toStoredUsage(usage: StoredUsage): StoredUsage {
  return usage
}

/** Session 协调器：单聊 chatDirect + 群聊 chatGroup。 */
export class SessionCoordinator {
  constructor(private readonly options: CoordinatorOptions) {}

  /**
   * 单聊：用户消息落库 → 从 store 恢复历史 → AgentLoop → 发言落库。
   * @param conversationId - 会话 id。
   * @param agentId - 响应的 agent id。
   * @param text - 用户输入。
   * @param context - 工作区根目录等。
   * @returns AgentLoop 事件流（透传）。
   */
  async *chatDirect(
    conversationId: string,
    agentId: string,
    text: string,
    context: RunContext,
  ): AsyncGenerator<AgentLoopEvent> {
    const { store, llm, tools } = this.options
    const agent = store.getAgent(agentId)
    if (agent === undefined) throw new Error(`@ryagent/session: unknown agent "${agentId}"`)
    const conversation = store.getConversation(conversationId)
    if (conversation === undefined) throw new Error(`@ryagent/session: unknown conversation "${conversationId}"`)

    const turnIndex = store.nextTurnIndex(conversationId)
    // 先恢复历史（不含本条用户消息），再落库用户消息，避免历史里出现重复输入。
    const history = this.loadDirectHistory(conversationId, agent)
    store.appendMessage({
      conversationId,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text }],
      turnIndex,
    })

    const memory = this.bindMemory(conversationId)
    const evolution = this.bindEvolution(conversationId)
    const loop = new AgentLoop({
      definition: agent,
      llm,
      tools,
      history,
      // 每步组装出的 assistant 消息（含 tool_calls、可能无文本）即时落库：
      // 不持久化它们，重建历史里 tool 消息就没有前置的 assistant tool_calls
      // 消息，违反 OpenAI 消息序列契约（第二轮必 400）。
      onAssistantMessage: (message) => {
        if (message.content.length === 0) return
        store.appendMessage({
          conversationId,
          senderType: 'agent',
          senderId: agentId,
          contentBlocks: [...message.content],
          turnIndex,
        })
      },
      ...(memory === undefined ? {} : { memory }),
      ...(evolution === undefined ? {} : { evolution }),
    })

    let failed: { message: string; code: string } | undefined
    for await (const event of loop.run({ text }, context)) {
      yield event
      if (event.type === 'tool-result') {
        store.appendMessage({
          conversationId,
          senderType: 'agent',
          senderId: agentId,
          contentBlocks: [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${event.name}: ${event.result.content}` }],
          toolCallId: event.callId,
          turnIndex,
        })
      }
      if (event.type === 'error') failed = { message: event.message, code: event.code }
    }

    if (failed !== undefined) {
      store.appendMessage({
        conversationId,
        senderType: 'system',
        contentBlocks: [{ type: 'text', text: `[error:${failed.code}] ${failed.message}` }],
        turnIndex,
      })
    }
  }

  /**
   * 群聊：用户消息（带 mentions）落库 → 共享历史（"名字:"前缀 + 预算裁剪）→
   * GroupDispatcher 调度链 → 每条 dispatch 落 dispatch_events，每条完成的
   * agent 发言与其工具结果落 messages，错误以 system 消息收尾。
   * @param conversationId - 群会话 id。
   * @param text - 用户输入。
   * @param context - 工作区根目录等。
   * @returns GroupDispatcher 事件流（透传）。
   */
  async *chatGroup(conversationId: string, text: string, context: RunContext): AsyncGenerator<GroupEvent> {
    const { store, llm, tools } = this.options
    const conversation = store.getConversation(conversationId)
    if (conversation === undefined) throw new Error(`@ryagent/session: unknown conversation "${conversationId}"`)
    if (conversation.kind !== 'group') {
      throw new Error(`@ryagent/session: conversation "${conversationId}" is not a group`)
    }
    const members: AgentDefinition[] = []
    for (const id of conversation.memberAgentIds) {
      const agent = store.getAgent(id)
      if (agent !== undefined) members.push(agent)
    }
    if (members.length === 0) throw new Error(`@ryagent/session: group "${conversationId}" has no resolvable members`)
    const dispatcherId = conversation.dispatcherAgentId ?? members[0]!.id

    const turnIndex = store.nextTurnIndex(conversationId)
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

    const agentNames = new Map(
      members.map((member) => {
        return [member.id, member.name]
      }),
    )
    const history: GroupHistoryEntry[] = []
    for (const row of store.listMessages(conversationId, { limit: HISTORY_PAGE_SIZE })) {
      if (row.turnIndex === turnIndex) break // 只取本 turn 之前的历史
      const entry = toGroupEntry(row, agentNames)
      if (entry !== undefined) history.push(entry)
    }

    const dispatcher = new GroupDispatcher({
      llm,
      members,
      dispatcherId,
      tools,
      ...(this.bindMemory(conversationId) === undefined ? {} : { memory: this.bindMemory(conversationId) }),
      ...(this.bindEvolution(conversationId) === undefined ? {} : { evolution: this.bindEvolution(conversationId) }),
    })
    for await (const event of dispatcher.runTurn({ text, history, workspaceRoot: context.workspaceRoot, turnIndex })) {
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
        case 'agent-message':
          store.appendMessage({
            conversationId,
            senderType: 'agent',
            senderId: event.agentId,
            contentBlocks: [...event.message.content],
            turnIndex,
          })
          break
        case 'tool-result':
          store.appendMessage({
            conversationId,
            senderType: 'agent',
            senderId: event.agentId,
            contentBlocks: [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${event.name}: ${event.result.content}` }],
            toolCallId: event.callId,
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
  }

  /** 绑定会话 id 的记忆钩子（AgentLoop 不关心 conversationId，由这里注入）。 */
  private bindMemory(conversationId: string): AgentMemoryHooks | undefined {
    const memory = this.options.memory
    if (memory === undefined) return undefined
    return {
      recall: (agentId, inputText) => {
        return memory.recall(agentId, inputText)
      },
      enqueueExtraction: (agentId, agentName, _conversationId, turnText) => {
        memory.enqueueExtraction(agentId, agentName, conversationId, turnText)
      },
    }
  }

  /** 绑定会话 id 的进化钩子（conversationId 由这里注入轨迹与归因）。 */
  private bindEvolution(conversationId: string): AgentEvolutionHooks | undefined {
    const evolution = this.options.evolution
    if (evolution === undefined) return undefined
    return {
      compile: (agentId) => {
        return evolution.compile(agentId)
      },
      enqueueTurn: (agentId, agentName, _conversationId, turn) => {
        evolution.enqueueTurn(agentId, agentName, conversationId, turn)
      },
    }
  }

  private loadDirectHistory(conversationId: string, agent: AgentDefinition): Message[] {
    const messages: Message[] = []
    for (const row of this.options.store.listMessages(conversationId, { limit: HISTORY_PAGE_SIZE })) {
      const rebuilt = rebuildMessage(row, agent)
      if (rebuilt !== undefined) messages.push(rebuilt)
    }
    return messages
  }
}
