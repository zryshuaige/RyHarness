/**
 * 助理主动往会话里写一条消息（后台任务跑完、计划待批这类通知）。
 *
 * 为什么单独一个模块：这类通知有**三处**要做对——落库、推界面、取轮次序号。
 * 三处分开做就会出现「界面上一条、库里两条」或者「刷新就没了」这种对不上的情况，
 * 所以它们必须在同一个函数里完成。
 * @module @ryharness/server/agent-notice
 */

import type { SessionStore } from '@ryharness/session'
import type { EventHub } from './bus.ts'
import type { WsEvent } from './events.ts'

/** 写一条通知需要的依赖。 */
export interface AgentNoticeDeps {
  store: SessionStore
  hub: EventHub
}

/** 一条通知的内容。 */
export interface AgentNotice {
  /** 写进哪个会话。 */
  conversationId: string
  /** 以谁的身份写（助理 id）。 */
  agentId: string
  /** 正文。 */
  text: string
}

/**
 * 把一条通知写进会话并推给界面。
 *
 * 落库与推送同源：库里那条与界面上那条是同一条消息的两种呈现，序号也取自同一处。
 * @param deps - 会话存储与事件出口。
 * @param notice - 通知内容。
 */
export function deliverAgentNotice(deps: AgentNoticeDeps, notice: AgentNotice): void {
  const conversation = deps.store.getConversation(notice.conversationId)
  if (conversation === undefined) return
  const turnIndex = deps.store.nextTurnIndex(notice.conversationId)
  const senderName = deps.store.getAgent(notice.agentId)?.name ?? notice.agentId
  deps.store.appendMessage({
    conversationId: notice.conversationId,
    senderType: 'agent',
    senderId: notice.agentId,
    contentBlocks: [{ type: 'text', text: notice.text }],
    turnIndex,
  })
  const publish = (event: WsEvent): void => {
    deps.hub.publish(event)
  }
  publish({
    type: 'message-start',
    conversationId: notice.conversationId,
    senderId: notice.agentId,
    senderName,
    turnIndex,
  })
  publish({
    type: 'text-delta',
    conversationId: notice.conversationId,
    senderId: notice.agentId,
    text: notice.text,
  })
  publish({ type: 'message-done', conversationId: notice.conversationId, senderId: notice.agentId, turnIndex })
}
