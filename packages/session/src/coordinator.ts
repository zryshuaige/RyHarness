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

import { brandString } from '@ryagent/brand'
import { AgentLoop } from '@ryagent/agent'
import type { AgentDefinition, AgentLoopEvent, Tool } from '@ryagent/agent'
import { GroupDispatcher, parseMentions } from '@ryagent/group'
import type { GroupEvent, GroupHistoryEntry } from '@ryagent/group'
import type {
  ContentBlock,
  LlmRuntime,
  Message,
  MessageId,
  ToolCallId,
} from '@ryagent/llm'
import type { SessionStore } from './store.ts'
import type { StoredMessage } from './types.ts'

/** 协调器构造参数。 */
export interface CoordinatorOptions {
  store: SessionStore
  llm: LlmRuntime
  /** 可用工具全集（AgentLoop 按 agent 定义白名单过滤）。 */
  tools: readonly Tool[]
}

/** 一次调用的运行上下文。 */
export interface RunContext {
  workspaceRoot: string
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
      id, role: 'assistant', content: blocks,
      source: { kind: 'model', provider: agent.provider, model: agent.model },
    }
  }
  return undefined
}

/** 把 store 的消息行格式化为群历史条目（跳过工具结果与 system）。 */
function toGroupEntry(row: StoredMessage, agentNames: Map<string, string>): GroupHistoryEntry | undefined {
  if (row.senderType === 'system' || row.toolCallId !== undefined) return undefined
  const text = (row.contentBlocks as ContentBlock[])
    .filter((block) => { return block.type === 'text' })
    .map((block) => { return block.type === 'text' ? block.text : '' })
    .join('\n')
  if (text.trim().length === 0) return undefined
  const speaker = row.senderType === 'user'
    ? '用户'
    : (row.senderId !== undefined ? (agentNames.get(row.senderId) ?? row.senderId) : 'agent')
  return { speaker, text }
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
      conversationId, senderType: 'user', senderId: 'user',
      contentBlocks: [{ type: 'text', text }], turnIndex,
    })

    const loop = new AgentLoop({ definition: agent, llm, tools, history })

    let reply = ''
    let failed: { message: string; code: string } | undefined
    for await (const event of loop.run({ text }, context)) {
      yield event
      if (event.type === 'text-delta') reply += event.text
      if (event.type === 'tool-result') {
        store.appendMessage({
          conversationId, senderType: 'agent', senderId: agentId,
          contentBlocks: [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${event.name}: ${event.result.content}` }],
          toolCallId: event.callId, turnIndex,
        })
      }
      if (event.type === 'error') failed = { message: event.message, code: event.code }
    }

    if (failed !== undefined) {
      store.appendMessage({
        conversationId, senderType: 'system',
        contentBlocks: [{ type: 'text', text: `[error:${failed.code}] ${failed.message}` }],
        turnIndex,
      })
    } else if (reply.length > 0) {
      store.appendMessage({
        conversationId, senderType: 'agent', senderId: agentId,
        contentBlocks: [{ type: 'text', text: reply }], turnIndex,
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
  async *chatGroup(
    conversationId: string,
    text: string,
    context: RunContext,
  ): AsyncGenerator<GroupEvent> {
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
    const mentions = parseMentions(text, members).map((member) => { return member.id })
    store.appendMessage({
      conversationId, senderType: 'user', senderId: 'user',
      contentBlocks: [{ type: 'text', text }], mentions, turnIndex,
    })

    const agentNames = new Map(members.map((member) => { return [member.id, member.name] }))
    const history: GroupHistoryEntry[] = []
    for (const row of store.listMessages(conversationId, { limit: HISTORY_PAGE_SIZE })) {
      if (row.turnIndex === turnIndex) break // 只取本 turn 之前的历史
      const entry = toGroupEntry(row, agentNames)
      if (entry !== undefined) history.push(entry)
    }

    const dispatcher = new GroupDispatcher({ llm, members, dispatcherId, tools })
    for await (const event of dispatcher.runTurn({ text, history, workspaceRoot: context.workspaceRoot, turnIndex })) {
      yield event
      switch (event.type) {
        case 'dispatch':
          store.recordDispatchEvent({
            conversationId, fromAgent: event.fromAgent, toAgent: event.toAgent,
            reason: event.reason, turnIndex,
          })
          break
        case 'agent-message':
          store.appendMessage({
            conversationId, senderType: 'agent', senderId: event.agentId,
            contentBlocks: [...event.message.content], turnIndex,
          })
          break
        case 'tool-result':
          store.appendMessage({
            conversationId, senderType: 'agent', senderId: event.agentId,
            contentBlocks: [{ type: 'text', text: `${TOOL_RESULT_PREFIX}${event.name}: ${event.result.content}` }],
            toolCallId: event.callId, turnIndex,
          })
          break
        case 'error':
          store.appendMessage({
            conversationId, senderType: 'system',
            contentBlocks: [{ type: 'text', text: `[error:${event.code}] ${event.message}` }],
            turnIndex,
          })
          break
        default:
          break
      }
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
