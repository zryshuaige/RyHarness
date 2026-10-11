/**
 * WS 推送事件契约（M4b UI 按此开发）。
 *
 * 服务器把 AgentLoop / GroupDispatcher / SessionCoordinator 的事件流
 * 统一映射为以下 JSON 事件，推送给订阅了对应会话的 WS 客户端。
 * 所有事件都带 conversationId；senderId 为 'user' 或 agent id。
 * @module @ryagent/server/events
 */

import type { ProduceCard } from '@ryagent/agent'

/** WS 事件（/ws?conversationId= 订阅后推送）。 */
export type WsEvent =
  | {
    type: 'message-start'
    conversationId: string
    /** 'user' 或 agent id。 */
    senderId: string
    senderName: string
    turnIndex: number
  }
  | { type: 'text-delta'; conversationId: string; senderId: string; text: string }
  | {
    type: 'tool-call-start'
    conversationId: string
    senderId: string
    callId: string
    name: string
    /** 原始 JSON 字符串参数。 */
    arguments: string
  }
  | {
    type: 'tool-result'
    conversationId: string
    senderId: string
    callId: string
    name: string
    isError: boolean
    content: string
  }
  | {
    type: 'produce-card'
    conversationId: string
    senderId: string
    callId: string
    /** file_produce 等工具的产物卡片元数据。 */
    card: ProduceCard
  }
  | {
    type: 'dispatch'
    conversationId: string
    fromAgent?: string
    toAgent: string
    reason: string
    turnIndex: number
  }
  | { type: 'message-done'; conversationId: string; senderId: string; turnIndex: number }
  | { type: 'error'; conversationId: string; message: string; code: string }
  | {
    type: 'queued'
    conversationId: string
    /** 排队的用户消息。 */
    senderId: 'user'
    turnIndex: number
  }
