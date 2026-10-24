/**
 * WS 推送事件契约（M4b UI 按此开发）。
 *
 * 服务器把 AgentLoop / GroupDispatcher / SessionCoordinator 的事件流
 * 统一映射为以下 JSON 事件，推送给订阅了对应会话的 WS 客户端。
 * 所有事件都带 conversationId；senderId 为 'user' 或 agent id。
 * @module @ryharness/server/events
 */

import type { ProduceCard } from '@ryharness/agent'
import type { StoredUsage } from '@ryharness/session'

/** WS 事件（/ws?conversationId= 订阅后推送）。 */
export type WsEvent =
  | {
      type: 'message-start'
      conversationId: string
      /** 'user' 或 agent id。 */
      senderId: string
      senderName: string
      turnIndex: number
      /**
       * 这一轮是 agent **主动开口**说的（每日回顾那条），不是用户问出来的。
       *
       * 渲染层据此给气泡加「主动找你」的标识：它与用户消息长得一样，就等于
       * 「我什么时候问过这句」这件事在界面上消失了。历史里的同一条消息靠
       * content_blocks 里的标记块认出（见 apps/server/src/proactive.ts），两处
       * 认的是同一件事——实时那条也得带这个标记，否则刷新一次标识就没了。
       */
      proactive?: boolean
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
  | {
      type: 'message-done'
      conversationId: string
      senderId: string
      turnIndex: number
      /** 本轮（含本条发言）的累计 token 用量；供应商未回报时缺省。 */
      usage?: StoredUsage
    }
  | { type: 'error'; conversationId: string; message: string; code: string }
  /**
   * 这一轮进队列了（会话内已有在途轮次）。
   *
   * **刻意不带 turnIndex**：入队那一刻这一轮还没有自己的序号（同一会话串行，它的
   * 序号要等真正执行时才取），此时另读一次 nextTurnIndex 给出的值属于「排队者」而
   * 不属于这一轮。渲染层把它只当"排队中"这一个状态用，与序号无关。
   */
  | {
      type: 'queued'
      conversationId: string
      /** 排队的用户消息。 */
      senderId: 'user'
    }
  | {
      /** 一条 requiresApproval 工具调用（如 shell_exec）等用户批准。 */
      type: 'approval-request'
      conversationId: string
      /** 发起这次工具调用的 agent id。 */
      senderId: string
      approvalId: string
      toolName: string
      /** 原始 JSON 字符串参数（命令在这里）。 */
      arguments: string
    }
  | {
      /** 一次审批有了结果（用户决定 / 超时 / 轮次取消）：渲染层据此撤卡。 */
      type: 'approval-resolved'
      conversationId: string
      approvalId: string
      outcome: 'allow' | 'deny' | 'timeout' | 'cancelled'
    }

/**
 * 实际推上 WS 的事件：EventHub 发布时打上每会话单调递增的 `seq`（从 1 起）。
 * 客户端按 seq 检测断线期间的事件缺口（seq 跳号即需要重拉历史补齐）。
 */
export type StampedWsEvent = WsEvent & { seq: number }
