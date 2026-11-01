/**
 * 会话历史查询服务：一个服务，把会话历史查全。
 *
 * 解决的问题是「各写各的 SQL」：翻页、筛选、追关系、搜正文，每处都自己拼一遍
 * 查询，条件一多就对不上，搜出来的结果还常常和模型看到的历史不是一回事。
 * 这里把这些收成**一个服务**：
 * - 精确读：按 id 取一条消息、一轮、一个会话；
 * - 筛选列表：按会话 / 发言者 / 种类 / 时间区间列消息，带游标翻页；
 * - 关系追踪：一条消息和谁有关系；
 * - 血缘：一条消息是哪一轮的第几条、那轮之前是什么；
 * - 全文搜索：跨会话搜正文，后端可换。
 *
 * 一条硬规矩贯穿全服务：**内容一律从 `@ryharness/session` 的 SessionStore 读**。
 * 模型看到的历史是从那里读出来的，于是「搜出来的」与「模型看到的」天然对得上；
 * 搜索命中还要再回存储核一遍（消息还在不在、正文还对不对得上），索引过期时
 * 宁可少给一条，也不给一条对不上的。
 *
 * 软删的会话按「查不到」处理：底座自己就不把它列出来，查询服务与之一致。
 * @module @ryharness/session-query/service
 */

import type { Conversation, SessionStore, StoredMessage } from '@ryharness/session'
import { decodeCursor, encodeCursor, filterFingerprint } from './cursor.ts'
import { SessionQueryError } from './errors.ts'
import { matchesFilter } from './filters.ts'
import { MemorySearchBackend } from './search.ts'
import { makeSnippet, searchableText, textMatchesQuery } from './text.ts'
import { buildLineage, traceRelations } from './tracing.ts'
import type {
  ConversationSummary,
  MessageFilter,
  MessageLineage,
  MessagePage,
  RelationTrace,
  RelationTraceOptions,
  SearchHit,
  SearchOptions,
  SearchResult,
  SessionQueryServiceOptions,
  SessionSearchBackend,
  TurnView,
} from './types.ts'

/** 默认一次最多看多少个会话。 */
const DEFAULT_MAX_CONVERSATIONS = 50

/** 默认单个会话最多读多少条消息。 */
const DEFAULT_MAX_MESSAGES = 20_000

/** 默认一页多少条。 */
const DEFAULT_PAGE_SIZE = 50

/** 默认返回多少条搜索命中。 */
const DEFAULT_SEARCH_LIMIT = 20

/** 默认片段长度。 */
const DEFAULT_SNIPPET_LENGTH = 160

/** 会话历史查询服务。 */
export class SessionQueryService {
  /** 会话存储：内容的唯一事实来源。 */
  private readonly store: SessionStore

  /** 全文搜索后端。 */
  private readonly backend: SessionSearchBackend

  /** 跨会话查询时最多看多少个会话。 */
  private readonly maxConversations: number

  /** 单个会话最多读多少条消息。 */
  private readonly maxMessagesPerConversation: number

  /** 消息 id → 它在哪个会话、第几号（读过的会话就记下来，省得下次再翻一遍）。 */
  private readonly locator = new Map<string, { conversationId: string; seq: number }>()

  /** 会话 id → 已进索引的状态（最大 seq 与条数）。 */
  private readonly indexed = new Map<string, { maxSeq: number; count: number }>()

  /** 构造函数。 */
  constructor(options: SessionQueryServiceOptions) {
    this.store = options.store
    this.backend = options.search ?? new MemorySearchBackend()
    this.maxConversations = Math.max(1, options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS)
    this.maxMessagesPerConversation = Math.max(1, options.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES)
  }

  // ---- 精确读 ----

  /**
   * 按消息 id 取一条消息。
   *
   * 给了会话 id 就只在那一个会话里找；不给就跨会话找（先查已建立的定位表，
   * 查不到再一个会话一个会话翻过去）。
   */
  getMessage(messageId: string, options: { conversationId?: string } = {}): StoredMessage | undefined {
    if (options.conversationId !== undefined) {
      const found = this.loadConversation(options.conversationId).find((message) => {
        return message.id === messageId
      })
      if (found !== undefined) return found
      return undefined
    }
    const located = this.locator.get(messageId)
    if (located !== undefined) {
      const message = this.store.getMessage(located.conversationId, located.seq)
      if (message !== undefined && message.id === messageId) return message
      this.locator.delete(messageId)
    }
    for (const conversation of this.store.listConversations(this.maxConversations)) {
      const found = this.loadConversation(conversation.id).find((message) => {
        return message.id === messageId
      })
      if (found !== undefined) return found
    }
    return undefined
  }

  /** 按会话 id 取一个会话；不存在或已软删返回 undefined。 */
  getConversation(conversationId: string): Conversation | undefined {
    return this.store.getConversation(conversationId)
  }

  /** 取一轮（同一 turnIndex 的全部消息）；这一轮没有消息返回 undefined。 */
  getTurn(conversationId: string, turnIndex: number): TurnView | undefined {
    const messages = this.loadConversation(conversationId).filter((message) => {
      return message.turnIndex === turnIndex
    })
    if (messages.length === 0) return undefined
    return { conversationId, turnIndex, messages, size: messages.length }
  }

  /** 会话清单（带消息条数），按最后更新时间倒序。 */
  listConversations(limit = this.maxConversations): ConversationSummary[] {
    return this.store.listConversations(limit).map((conversation) => {
      return {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        memberAgentIds: [...conversation.memberAgentIds],
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: this.loadConversation(conversation.id).length,
      }
    })
  }

  // ---- 筛选列表 ----

  /**
   * 按条件列消息（带游标翻页）。
   *
   * 排序用 `seq`（全局单调的自增号），不拿时间戳排：时间戳是毫秒精度，同一毫秒
   * 落库的两条消息谁先谁后是随机的，翻页会漏。区间过滤仍按时间戳。
   */
  listMessages(filter: MessageFilter = {}): MessagePage {
    const order = filter.order ?? 'desc'
    const limit = Math.max(1, filter.limit ?? DEFAULT_PAGE_SIZE)
    const fingerprint = filterFingerprint(filter)
    const candidates = this.collectCandidates(filter)
    const matched = candidates.filter((message) => {
      return matchesFilter(message, filter)
    })
    matched.sort((left, right) => {
      return order === 'asc' ? left.seq - right.seq : right.seq - left.seq
    })
    const cursorSeq = filter.cursor === undefined ? undefined : decodeCursor(filter.cursor, fingerprint)
    const windowed =
      cursorSeq === undefined
        ? matched
        : matched.filter((message) => {
            return order === 'asc' ? message.seq > cursorSeq : message.seq < cursorSeq
          })
    const items = windowed.slice(0, limit)
    const hasMore = windowed.length > items.length
    const last = items[items.length - 1]
    return {
      items,
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last.seq, fingerprint) } : {}),
      hasMore,
      total: matched.length,
    }
  }

  // ---- 关系追踪 ----

  /**
   * 追一条消息和谁有关系：同轮的、它回复的、引用了它的，外加同会话的前后文。
   */
  traceRelations(
    messageId: string,
    options: RelationTraceOptions & { conversationId?: string } = {},
  ): RelationTrace | undefined {
    const message = this.getMessage(messageId, { conversationId: options.conversationId })
    if (message === undefined) return undefined
    const messages = this.loadConversation(message.conversationId)
    return traceRelations(message, messages, options)
  }

  // ---- 血缘 ----

  /** 一条消息的血缘：它是哪一轮的第几条、那轮之前是什么。 */
  getLineage(messageId: string, options: { conversationId?: string } = {}): MessageLineage | undefined {
    const message = this.getMessage(messageId, { conversationId: options.conversationId })
    if (message === undefined) return undefined
    return buildLineage(message, this.loadConversation(message.conversationId))
  }

  // ---- 全文搜索 ----

  /**
   * 跨会话搜正文。
   *
   * 流程是「先同步、再搜、最后回存储核一遍」：同步保证新消息能被搜到；
   * 回存储核一遍保证给出去的结果**确实还在历史里、正文确实还对得上**——
   * 索引过期时宁可少给一条，也不给一条模型看不到的消息（搜出来的等于没用）。
   */
  search(query: string, options: SearchOptions = {}): SearchResult {
    const trimmed = query.trim()
    if (trimmed.length === 0) return { query: trimmed, hits: [], dropped: 0 }
    const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT)
    const snippetLength = Math.max(16, options.snippetLength ?? DEFAULT_SNIPPET_LENGTH)
    for (const conversationId of this.searchScope(options.conversationId)) {
      this.syncConversation(conversationId)
    }
    const raw = this.backend.search(trimmed, {
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      limit: limit * 3,
    })
    let dropped = 0
    const hits: SearchHit[] = []
    for (const hit of raw) {
      const message = this.getMessage(hit.messageId)
      if (message === undefined) {
        dropped++
        continue
      }
      if (options.senderType !== undefined && message.senderType !== options.senderType) {
        dropped++
        continue
      }
      const text = searchableText(message)
      if (!textMatchesQuery(text, trimmed)) {
        dropped++
        continue
      }
      hits.push({
        messageId: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        senderType: message.senderType,
        ...(message.senderId === undefined ? {} : { senderId: message.senderId }),
        createdAt: message.createdAt,
        snippet: makeSnippet(text, trimmed, snippetLength),
        score: hit.score,
      })
    }
    hits.sort((left, right) => {
      return right.score - left.score || right.seq - left.seq
    })
    return { query: trimmed, hits: hits.slice(0, limit), dropped }
  }

  // ---- 索引维护 ----

  /**
   * 把一个会话的消息同步进搜索索引。
   *
   * 增量：会话没变（新消息没有、条数没少）就什么都不做。正文被**改**过
   * （编辑并重发）这种「seq 与条数都没变」的情况这里看不出来，搜索时那一条会
   * 因为回存储核对不上而被丢掉——宁可少给一条，也不给一条对不上的。
   *
   * @returns 这次新进了多少条。
   */
  syncConversation(conversationId: string): number {
    const messages = this.loadConversation(conversationId)
    const maxSeq = messages.length === 0 ? -1 : messages[messages.length - 1].seq
    const known = this.indexed.get(conversationId)
    if (known !== undefined && known.maxSeq === maxSeq && known.count === messages.length) return 0
    this.backend.removeConversation(conversationId)
    let count = 0
    for (const message of messages) {
      const text = searchableText(message)
      if (text.length === 0) continue
      this.backend.index({
        messageId: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        senderType: message.senderType,
        ...(message.senderId === undefined ? {} : { senderId: message.senderId }),
        createdAt: message.createdAt,
        text,
      })
      count++
    }
    this.indexed.set(conversationId, { maxSeq, count })
    return count
  }

  /** 全量重建索引（会话清单里的每一个都同步一遍）。 */
  reindexAll(): number {
    let count = 0
    for (const conversation of this.store.listConversations(this.maxConversations)) {
      this.indexed.delete(conversation.id)
      count += this.syncConversation(conversation.id)
    }
    return count
  }

  /** 释放资源（关掉搜索后端的文件句柄）。 */
  close(): void {
    this.backend.close()
  }

  /** 搜索用的会话范围：指定了就一个，没指定就最近的这些。 */
  private searchScope(conversationId: string | undefined): string[] {
    if (conversationId !== undefined) return [conversationId]
    return this.store.listConversations(this.maxConversations).map((conversation) => {
      return conversation.id
    })
  }

  /** 按筛选条件收集候选消息。 */
  private collectCandidates(filter: MessageFilter): StoredMessage[] {
    if (filter.conversationId !== undefined) return this.loadConversation(filter.conversationId)
    const messages: StoredMessage[] = []
    for (const conversation of this.store.listConversations(this.maxConversations)) {
      messages.push(...this.loadConversation(conversation.id))
    }
    return messages
  }

  /**
   * 读一个会话的全部消息（按 seq 升序）。
   *
   * 每次都重新读，不缓存：消息会被追加、截断、改写，缓存一放就与模型看到的历史
   * 对不上——而「对得上」是本包唯一不能退让的一条。会话已软删时返回空数组。
   */
  private loadConversation(conversationId: string): StoredMessage[] {
    if (this.store.getConversation(conversationId) === undefined) return []
    const messages = this.store.listMessages(conversationId, { limit: this.maxMessagesPerConversation })
    for (const message of messages) {
      this.locator.set(message.id, { conversationId: message.conversationId, seq: message.seq })
    }
    return messages
  }
}

/** 会话不存在时的报错（给不想拿 undefined 的调用方用）。 */
export function requireConversation(service: SessionQueryService, conversationId: string): Conversation {
  const conversation = service.getConversation(conversationId)
  if (conversation === undefined) {
    throw new SessionQueryError('CONVERSATION_NOT_FOUND', `会话 ${conversationId} 不存在（或者已经被删了）。`)
  }
  return conversation
}
