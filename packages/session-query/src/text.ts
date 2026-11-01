/**
 * 正文抽取与检索分词：把一条消息变成「可搜索的文本」与「可比较的词」。
 *
 * 正文抽取直接用 `@ryharness/session` 的 `messageSearchText`——它取的就是
 * `type === 'text'` 的内容块，与模型在历史里看到的正文**逐字一致**。自己再写
 * 一份抽取逻辑，早晚与底座分叉：分叉之后「搜出来的」与「模型看到的」就对不上，
 * 而这正是本包要消灭的那类不一致。
 *
 * 分词沿用底座的 bigram 口径（相邻两字一个词），并做一次「只留字母数字」的
 * 归一：FTS5 的 unicode61 会把标点当分隔符，`好。` 在索引里是词 `好`；不归一
 * 就会拿 `好。` 去比 `好`，明明命中了却被判成没命中。
 * @module @ryharness/session-query/text
 */

import type { StoredMessage } from '@ryharness/session'
import { bigrams, messageSearchText } from '@ryharness/session'

/** 一条消息里可搜索的正文（只取文本块）。 */
export function searchableText(message: StoredMessage): string {
  return messageSearchText(message.contentBlocks)
}

/** 一条消息里的工具调用 id（assistant 消息发起工具调用时带上）。 */
export function toolCallIds(message: StoredMessage): string[] {
  const ids: string[] = []
  for (const block of message.contentBlocks) {
    if (!isRecord(block)) continue
    if (block.type !== 'tool-call') continue
    const id = block.id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/** 一条消息是否含有文本块。 */
export function hasTextBlock(message: StoredMessage): boolean {
  return message.contentBlocks.some((block) => {
    return isRecord(block) && block.type === 'text'
  })
}

/** 一条消息是否含有工具调用块。 */
export function hasToolCallBlock(message: StoredMessage): boolean {
  return message.contentBlocks.some((block) => {
    return isRecord(block) && block.type === 'tool-call'
  })
}

/**
 * 检索用的词集合：bigram 切分 + 去掉非字母数字 + 去重。
 *
 * 与 {@link searchableText} 配套使用，判断「这条消息还讲不讲这个词」。
 */
export function searchTokens(text: string): Set<string> {
  return new Set(searchTokenList(text))
}

/**
 * 检索用的词列表：bigram 切分 + 去掉非字母数字（**保留重复**）。
 *
 * 与 {@link searchTokens} 配套：那边去重用来判断「有没有这个词」，这边保留
 * 重复用来算词频（同一个词在一条消息里出现三次，比出现一次更相关）。
 */
export function searchTokenList(text: string): string[] {
  const tokens: string[] = []
  for (const token of bigrams(text).split(' ')) {
    if (token.length === 0) continue
    const normalized = normalizeToken(token)
    if (normalized.length === 0) continue
    tokens.push(normalized)
  }
  return tokens
}

/**
 * 文本与查询是不是「讲的是同一件事」。
 *
 * 口径是**词有交集**：查询词切出来的任何一个 bigram 出现在正文里就算命中。
 * 这是 OR 语义（候选词常常比消息长，全 AND 会零命中），与 FTS5 的 MATCH 语义
 * 一致——两边用同一个口径，索引里的排序与校验时的判定才不会互相打架。
 */
export function textMatchesQuery(text: string, query: string): boolean {
  const queryTokens = searchTokens(query)
  if (queryTokens.size === 0) return false
  const textTokens = searchTokens(text)
  for (const token of queryTokens) {
    if (textTokens.has(token)) return true
  }
  return false
}

/**
 * 截一段带上下文的片段。
 *
 * 命中位置找不到时（查询词与正文只是「词有交集」而不是原样包含）就取正文开头，
 * 宁可给一段没有高亮的正文，也不给空片段。
 */
export function makeSnippet(text: string, query: string, maxLength: number): string {
  const limit = Math.max(16, maxLength)
  const at = firstMatchAt(text, query)
  if (at < 0) return text.slice(0, limit)
  const start = Math.max(0, at - Math.floor(limit / 3))
  const body = text.slice(start, start + limit)
  const prefix = start > 0 ? '…' : ''
  const suffix = start + limit < text.length ? '…' : ''
  return `${prefix}${body}${suffix}`
}

/** 词归一：只留字母与数字（unicode 字母），其余丢掉。 */
function normalizeToken(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, '')
}

/** 正文里第一个命中词的位置；没有原样命中就返回 -1。 */
function firstMatchAt(text: string, query: string): number {
  let at = -1
  for (const token of bigrams(query).split(' ')) {
    if (token.length === 0) continue
    const index = text.indexOf(token)
    if (index < 0) continue
    if (at < 0 || index < at) at = index
  }
  return at
}

/** 是不是一个普通对象（用来收窄 contentBlocks 里的未知结构）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
