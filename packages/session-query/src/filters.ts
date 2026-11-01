/**
 * 筛选：一条消息要不要进结果。
 *
 * 筛选条件放在这里而不是散在服务里，是为了「同一条消息在列表、搜索、导出里
 * 用的是同一把尺子」——列表里出现过的消息，搜索命中它时不会被另一套规则判掉。
 * @module @ryharness/session-query/filters
 */

import type { StoredMessage } from '@ryharness/session'
import { hasTextBlock, hasToolCallBlock, searchableText } from './text.ts'
import type { MessageFilter, MessageKind } from './types.ts'

/**
 * 这条消息含有的内容种类（一条消息可能同时含好几种）。
 *
 * 「含有」而不是「只有」：assistant 消息常常既有正文又有工具调用，两种都算。
 */
export function messageKinds(message: StoredMessage): MessageKind[] {
  const kinds: MessageKind[] = []
  if (hasTextBlock(message)) kinds.push('text')
  if (hasToolCallBlock(message)) kinds.push('tool-call')
  if (message.toolCallId !== undefined) kinds.push('tool-result')
  return kinds
}

/** 这条消息符不符合筛选条件。 */
export function matchesFilter(message: StoredMessage, filter: MessageFilter): boolean {
  if (filter.conversationId !== undefined && message.conversationId !== filter.conversationId) return false
  if (filter.senderType !== undefined && message.senderType !== filter.senderType) return false
  if (filter.senderId !== undefined && message.senderId !== filter.senderId) return false
  if (filter.kind !== undefined && !messageKinds(message).includes(filter.kind)) return false
  if (filter.fromTime !== undefined && message.createdAt < filter.fromTime) return false
  if (filter.toTime !== undefined && message.createdAt > filter.toTime) return false
  if (filter.text !== undefined && filter.text.length > 0) {
    const text = searchableText(message)
    if (!text.toLowerCase().includes(filter.text.toLowerCase())) return false
  }
  return true
}
