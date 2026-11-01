/**
 * 关系追踪与血缘：一条消息和谁有关系、它是哪一轮的第几条。
 *
 * 这里的「关系」不是猜的，是从会话数据里**读出来**的三种实打实的边：
 * - **同一轮**：同一 `turnIndex` 的消息共享一次用户输入，是一段完整的来回；
 * - **它回复的**：agent 消息答的是哪条用户消息；工具结果接的是哪次工具调用；
 * - **引用了它的**：接了它的工具调用的工具结果；答了它的话的 agent 消息。
 *
 * 边是双向算出来的：先算「谁回复谁」，再取反向就是「谁引用谁」。这样两种关系
 * 不会各写一套判定而对不上。
 * @module @ryharness/session-query/tracing
 */

import type { StoredMessage } from '@ryharness/session'
import { toolCallIds } from './text.ts'
import type { MessageLineage, RelationTrace, RelationTraceOptions, TurnSummary } from './types.ts'

/** 一张关系图：谁回复谁、谁引用谁。 */
export interface ReplyGraph {
  /** 消息 id → 它回复的那条消息。 */
  readonly repliesTo: Map<string, StoredMessage>
  /** 消息 id → 引用了它的那些消息（按 seq 升序）。 */
  readonly referencedBy: Map<string, StoredMessage[]>
}

/**
 * 算出一段消息之间的关系图。
 *
 * 判定口径：
 * - 工具结果（有 `toolCallId`）→ 发起那次调用的那条消息；
 * - agent 消息 → 同一轮里的那条用户消息；这一轮里没有就退到本会话上一条用户消息
 *   （群里 agent 接着上文说话是常事，硬说「没有回复对象」反而不像话）。
 */
export function buildReplyGraph(messages: readonly StoredMessage[]): ReplyGraph {
  const callers = new Map<string, StoredMessage>()
  for (const message of messages) {
    for (const id of toolCallIds(message)) {
      if (!callers.has(id)) callers.set(id, message)
    }
  }
  const repliesTo = new Map<string, StoredMessage>()
  const referencedBy = new Map<string, StoredMessage[]>()
  let lastUser: StoredMessage | undefined
  let lastUserInTurn: StoredMessage | undefined
  let currentTurn = Number.NaN
  for (const message of messages) {
    if (message.turnIndex !== currentTurn) {
      currentTurn = message.turnIndex
      lastUserInTurn = undefined
    }
    if (message.senderType === 'user') {
      lastUser = message
      lastUserInTurn = message
    }
    let target: StoredMessage | undefined
    if (message.toolCallId !== undefined) {
      target = callers.get(message.toolCallId)
    } else if (message.senderType === 'agent') {
      target = lastUserInTurn ?? lastUser
    }
    if (target === undefined) continue
    repliesTo.set(message.id, target)
    const list = referencedBy.get(target.id) ?? []
    list.push(message)
    referencedBy.set(target.id, list)
  }
  return { repliesTo, referencedBy }
}

/**
 * 追一条消息和谁有关系。
 *
 * @param message - 被追的消息。
 * @param messages - 同一会话的全部消息（按 seq 升序）。
 * @param options - 前后文取几条。
 */
export function traceRelations(
  message: StoredMessage,
  messages: readonly StoredMessage[],
  options: RelationTraceOptions = {},
): RelationTrace {
  const contextSize = Math.max(0, options.contextSize ?? 2)
  const index = messages.findIndex((item) => {
    return item.id === message.id
  })
  const graph = buildReplyGraph(messages)
  const turnMessages = messages.filter((item) => {
    return item.turnIndex === message.turnIndex && item.id !== message.id
  })
  const repliesTo = graph.repliesTo.get(message.id)
  const referencedBy = graph.referencedBy.get(message.id) ?? []
  const before = index < 0 ? [] : messages.slice(Math.max(0, index - contextSize), index)
  const after = index < 0 ? [] : messages.slice(index + 1, index + 1 + contextSize)
  return {
    message,
    turnMessages,
    ...(repliesTo === undefined ? {} : { repliesTo }),
    referencedBy,
    before,
    after,
  }
}

/**
 * 算一条消息的血缘：它是哪一轮的第几条、那轮之前是什么。
 *
 * @param message - 目标消息。
 * @param messages - 同一会话的全部消息（按 seq 升序）。
 */
export function buildLineage(message: StoredMessage, messages: readonly StoredMessage[]): MessageLineage {
  const index = messages.findIndex((item) => {
    return item.id === message.id
  })
  const turnMessages = messages.filter((item) => {
    return item.turnIndex === message.turnIndex
  })
  const position = turnMessages.findIndex((item) => {
    return item.id === message.id
  })
  const previousMessage = index > 0 ? messages[index - 1] : undefined
  const previousTurn = findPreviousTurn(message.turnIndex, messages)
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    turnIndex: message.turnIndex,
    positionInTurn: position < 0 ? 1 : position + 1,
    turnSize: turnMessages.length,
    turnFirst: turnMessages[0] ?? message,
    ...(previousMessage === undefined ? {} : { previousMessage }),
    ...(previousTurn === undefined ? {} : { previousTurn }),
  }
}

/** 上一轮的摘要：轮次号、第一条消息、消息条数。 */
function findPreviousTurn(turnIndex: number, messages: readonly StoredMessage[]): TurnSummary | undefined {
  let previousIndex: number | undefined
  for (const message of messages) {
    if (message.turnIndex >= turnIndex) continue
    if (previousIndex === undefined || message.turnIndex > previousIndex) previousIndex = message.turnIndex
  }
  if (previousIndex === undefined) return undefined
  const turnMessages = messages.filter((item) => {
    return item.turnIndex === previousIndex
  })
  const first = turnMessages[0]
  if (first === undefined) return undefined
  return { turnIndex: previousIndex, first, size: turnMessages.length }
}
