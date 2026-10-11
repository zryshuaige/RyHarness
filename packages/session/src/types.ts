/**
 * Session 持久化类型：Agent 定义、会话、消息、群聊调度事件。
 * @module @ryagent/session/types
 */

/** 持久化的 Agent 定义（与 @ryagent/agent 的 AgentDefinition 同构，常用字段展开便于 SQL 查询）。 */
export interface StoredAgent {
  id: string
  name: string
  avatar?: string
  systemPrompt: string
  provider: string
  model: string
  temperature?: number
  /** 工具名白名单。 */
  tools: string[]
  isBuiltin: boolean
  createdAt: number
  updatedAt: number
}

/** 会话种类：单聊（direct）或群聊（group）。 */
export type ConversationKind = 'direct' | 'group'

/** 一个会话（单聊 = 用户与一个 agent；群聊 = 多个 agent + 调度员）。 */
export interface Conversation {
  id: string
  kind: ConversationKind
  title: string
  /** 群聊成员 agent id 列表（单聊为单元素）。 */
  memberAgentIds: string[]
  /** 群聊调度员 agent id：决定每条用户消息路由给谁；单聊为空。 */
  dispatcherAgentId?: string
  createdAt: number
  updatedAt: number
}

/** 消息发送者种类。 */
export type SenderType = 'user' | 'agent' | 'system'

/** 一条消息；contentBlocks 与 mentions 以 JSON 存储，保持 @ryagent/llm 的 ContentBlock 结构。 */
export interface StoredMessage {
  id: string
  /** 单调递增序号，分页游标。 */
  seq: number
  conversationId: string
  senderType: SenderType
  /** user/agent 时为对应 id；system 时为空。 */
  senderId?: string
  /** 内容块数组（@ryagent/llm 的 ContentBlock JSON）。 */
  contentBlocks: unknown[]
  /** 群聊 @提及的 agent id 列表。 */
  mentions: string[]
  /** 工具结果消息对应的 callId（其他消息为空）。 */
  toolCallId?: string
  /** 会话内的轮次序号（同一轮用户输入 + agent 回复 + 工具结果共享）。 */
  turnIndex: number
  createdAt: number
}

/** 群聊调度事件：调度员决定本条输入由哪个 agent 响应。 */
export interface DispatchEvent {
  id: string
  conversationId: string
  /** 发起调度的 agent（通常是调度员）；系统兜底时为空。 */
  fromAgent?: string
  toAgent: string
  reason: string
  turnIndex: number
  createdAt: number
}
