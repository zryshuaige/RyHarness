/**
 * 跨会话快照：把另一个会话的最近进展装配进来，让模型知道「上次聊到哪」。
 * @module @ryharness/context/session-snapshot
 */

import { DEFAULT_CONTEXT_LIMITS } from './types.ts'

/** 快照里的一条消息。 */
export interface SnapshotMessage {
  /** 说话方：'user' 或 agent 的名字 / 标识。 */
  sender: string
  /** 正文纯文本。 */
  text: string
}

/** 另一个会话的元信息。 */
export interface SnapshotSession {
  id: string
  /** 会话标题（给模型看的人话标题）。 */
  title?: string
}

/**
 * 快照的数据源。
 *
 * 本包不碰存储：宿主实现它（本仓是 packages/session 的 SessionStore）。
 * 实现方要保证两件事：recentMessages 给的是**最近**的若干条、且按时间从旧到新排好；
 * recentSessions 按最近优先排好序。
 */
export interface SessionSnapshotSource {
  /** 取会话元信息；没有这个会话时返回 undefined。 */
  session(conversationId: string): SnapshotSession | undefined
  /** 取会话最近的消息（旧→新）。 */
  recentMessages(conversationId: string, limit: number): readonly SnapshotMessage[]
  /** 最近会话列表；excludeId 里的要排除。 */
  recentSessions(excludeId: string | undefined, limit: number): readonly SnapshotSession[]
}

/** 装配跨会话快照的参数。 */
export interface SessionSnapshotOptions {
  /** 数据源。 */
  source: SessionSnapshotSource
  /** 明确引用的会话 id；缺省取最近的一个（排除当前会话）。 */
  conversationId?: string
  /** 当前会话 id：它不该出现在「另一个会话」里。 */
  currentConversationId?: string
  /** 最多几条消息；缺省 8。 */
  maxMessages?: number
  /** 正文上限；缺省 2000 字符。 */
  maxChars?: number
}

/** 装配出来的快照。 */
export interface SessionSnapshotBlock {
  /** 快照来自哪个会话。 */
  session: SnapshotSession
  /** 实际装配进去的消息条数。 */
  messageCount: number
  /** 给模型的正文。 */
  text: string
}

/**
 * 装配另一个会话的近况快照。
 *
 * 正文里必须写明这是**另一个会话**：否则模型会把里面的话当成自己说过的话，
 * 接着编出「我们之前讨论过」这种其实没发生过的对话。
 * @param options - 装配参数。
 * @returns 装配结果；没有可用会话或会话里没有消息时为 undefined。
 */
export function buildSessionSnapshot(options: SessionSnapshotOptions): SessionSnapshotBlock | undefined {
  const maxMessages = options.maxMessages ?? DEFAULT_CONTEXT_LIMITS.snapshotMaxMessages
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_LIMITS.snapshotMaxChars
  const target = pickSession(options)
  if (target === undefined) return undefined
  const messages = options.source.recentMessages(target.id, maxMessages)
  const lines: string[] = []
  let used = 0
  let count = 0
  let truncated = false
  for (const message of messages) {
    const body = message.text.trim()
    if (body === '') continue
    const line = `${senderLabel(message.sender)}：${body}`
    if (used + line.length > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length
    count += 1
  }
  if (count === 0) return undefined
  const title = target.title ?? target.id
  const head = `[另一个会话的近况 · ${title}]\n下面这段来自另一个会话（不是本次对话里说过的话），只是让你知道上次聊到哪。`
  const tail = truncated ? '\n（快照已截断：更早的内容没有装进来）' : ''
  return {
    session: target,
    messageCount: count,
    text: `${head}\n\n${lines.join('\n')}${tail}`,
  }
}

/** 挑要快照的会话：明确指定了就用它，否则取最近的一个（当前会话除外）。 */
function pickSession(options: SessionSnapshotOptions): SnapshotSession | undefined {
  if (options.conversationId !== undefined) return options.source.session(options.conversationId)
  const recent = options.source.recentSessions(options.currentConversationId, 1)
  return recent.length > 0 ? recent[0] : undefined
}

/** 说话方的展示名。 */
function senderLabel(sender: string): string {
  return sender === 'user' ? '用户' : sender
}
