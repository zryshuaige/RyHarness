/**
 * 会话历史查询的公共词汇：筛选条件、分页游标、关系追踪、血缘、全文搜索。
 *
 * 这一层只放**形状**，不放实现：查询服务（service.ts）、搜索后端（search.ts 与
 * fts5.ts）、导出（export.ts）都按这里的类型对齐，调用方只需要认识这一层。
 *
 * 有一个前提贯穿全包：**历史内容一律以 `@ryharness/session` 的 SessionStore 为准**。
 * 模型看到的历史是从那里读出来的，查询服务读的是同一份，于是「搜出来的」与
 * 「模型看到的」不会对不上——这条是上游反复强调的硬要求，也是本包存在的理由。
 * @module @ryharness/session-query/types
 */

import type { Conversation, SenderType, SessionStore, StoredMessage } from '@ryharness/session'

/**
 * 消息的种类：按「这条消息里含有什么内容」判定，不是按角色。
 *
 * 一条 assistant 消息常常既有正文又有工具调用，所以这里的判定是「含有」，
 * 不是「只有」。筛选 `kind: 'tool-call'` 会把「说了话也调了工具」的消息一并带上。
 */
export type MessageKind = 'text' | 'tool-call' | 'tool-result'

/** 列表排序方向。 */
export type MessageOrder = 'asc' | 'desc'

/** 按条件列消息时的筛选条件。 */
export interface MessageFilter {
  /** 限定会话；缺省 = 所有会话（受服务的会话上限约束）。 */
  conversationId?: string
  /** 限定发言者种类。 */
  senderType?: SenderType
  /** 限定发言者 id（用户 id 或 agent id）。 */
  senderId?: string
  /** 限定消息含有的内容种类。 */
  kind?: MessageKind
  /** 时间区间下界（含）。 */
  fromTime?: number
  /** 时间区间上界（含）。 */
  toTime?: number
  /** 正文包含的片段（大小写不敏感的子串匹配）。 */
  text?: string
  /** 排序方向；缺省 = `desc`（新的在前）。 */
  order?: MessageOrder
  /** 最多取多少条；缺省 = 50。 */
  limit?: number
  /** 上一页返回的游标；带上它就是「接着往下翻」。 */
  cursor?: string
}

/** 一页消息。 */
export interface MessagePage {
  /** 这一页的消息（按 seq 排好序）。 */
  items: StoredMessage[]
  /** 下一页的游标；没有下一页时缺省。 */
  nextCursor?: string
  /** 后面还有没有更多。 */
  hasMore: boolean
  /** 命中的总条数（翻页前统计的）。 */
  total: number
}

/** 一轮（一轮 = 同一条用户输入引发的用户消息、agent 回复与工具结果）。 */
export interface TurnView {
  /** 所属会话 id。 */
  conversationId: string
  /** 轮次序号（与 `messages.turn_index` 一致，首轮为 0）。 */
  turnIndex: number
  /** 这一轮的消息，按 seq 升序。 */
  messages: StoredMessage[]
  /** 这一轮有几条消息。 */
  size: number
}

/** 一轮摘要（血缘里用，不重复带整轮消息）。 */
export interface TurnSummary {
  /** 轮次序号。 */
  turnIndex: number
  /** 这一轮的第一条消息。 */
  first: StoredMessage
  /** 这一轮有几条消息。 */
  size: number
}

/** 关系追踪的参数。 */
export interface RelationTraceOptions {
  /** 同会话前后文各取几条；缺省 = 2。 */
  contextSize?: number
}

/**
 * 一条消息和谁有关系。
 *
 * 三种关系分开列，不混成一堆「相关消息」：
 * - `turnMessages`：同一轮里的其它消息（这一轮的上下文）；
 * - `repliesTo`：它回复的那条（它答的是谁 / 它的工具调用出自谁的请求）；
 * - `referencedBy`：引用了它的那些（接了它的工具调用 / 答了它的话）。
 */
export interface RelationTrace {
  /** 被追的那条消息。 */
  message: StoredMessage
  /** 同一轮里的其它消息（不含目标消息本身，按 seq 升序）。 */
  turnMessages: StoredMessage[]
  /** 它回复的消息；没有就缺省。 */
  repliesTo?: StoredMessage
  /** 引用了它的消息（按 seq 升序）。 */
  referencedBy: StoredMessage[]
  /** 同一会话里，它前面的消息（按 seq 升序）。 */
  before: StoredMessage[]
  /** 同一会话里，它后面的消息（按 seq 升序）。 */
  after: StoredMessage[]
}

/** 一条消息的血缘：它是哪一轮的第几条、那轮之前是什么。 */
export interface MessageLineage {
  /** 消息 id。 */
  messageId: string
  /** 所属会话 id。 */
  conversationId: string
  /** 轮次序号。 */
  turnIndex: number
  /** 这一轮里的第几条（从 1 开始）。 */
  positionInTurn: number
  /** 这一轮一共几条。 */
  turnSize: number
  /** 这一轮的第一条消息。 */
  turnFirst: StoredMessage
  /** 同一会话里，它前面那条消息；它是本会话第一条时缺省。 */
  previousMessage?: StoredMessage
  /** 上一轮；本轮是第一轮时缺省。 */
  previousTurn?: TurnSummary
}

/** 搜索后端要索引的一条文档。 */
export interface SearchDocument {
  /** 消息 id。 */
  messageId: string
  /** 所属会话 id。 */
  conversationId: string
  /** 消息序号（全局单调）。 */
  seq: number
  /** 发言者种类。 */
  senderType: SenderType
  /** 发言者 id。 */
  senderId?: string
  /** 落库时间（Unix 毫秒）。 */
  createdAt: number
  /** 可搜索正文（与模型看到的一致：只取文本块）。 */
  text: string
}

/** 搜索命中。 */
export interface SearchHit {
  /** 消息 id。 */
  messageId: string
  /** 所属会话 id。 */
  conversationId: string
  /** 消息序号。 */
  seq: number
  /** 发言者种类。 */
  senderType: SenderType
  /** 发言者 id。 */
  senderId?: string
  /** 落库时间（Unix 毫秒）。 */
  createdAt: number
  /** 命中处的正文片段。 */
  snippet: string
  /** 相关度：**越大越相关**（FTS5 的 BM25 取了负号，与内存倒排同一个方向）。 */
  score: number
}

/** 搜索参数。 */
export interface SearchOptions {
  /** 限定会话；缺省 = 所有会话。 */
  conversationId?: string
  /** 限定发言者种类。 */
  senderType?: SenderType
  /** 最多返回几条；缺省 = 20。 */
  limit?: number
  /** 片段最大长度（字符）；缺省 = 160。 */
  snippetLength?: number
}

/** 搜索结果。 */
export interface SearchResult {
  /** 原样回显的查询串（已去掉首尾空白）。 */
  query: string
  /** 命中的消息，按相关度降序。 */
  hits: SearchHit[]
  /** 被丢掉的结果数（索引里有、但正文已经对不上或消息已被删）。 */
  dropped: number
}

/** 搜索后端收到的查询参数。 */
export interface SearchBackendQuery {
  /** 限定会话。 */
  conversationId?: string
  /** 最多返回几条。 */
  limit: number
}

/**
 * 全文搜索后端：可插拔的那一头。
 *
 * 抽成接口是为了让「搜什么」与「怎么搜」分开：内存倒排够用且零配置，SQLite
 * FTS5 扛得住大库，两者对调用方是同一套接口，换后端不用改查询代码。
 */
export interface SessionSearchBackend {
  /** 后端名字（诊断用）。 */
  readonly name: string
  /** 灌一条消息进索引（正文为空的消息不进索引）。 */
  index(document: SearchDocument): void
  /** 丢掉一个会话的全部索引行（消息被删掉时用）。 */
  removeConversation(conversationId: string): void
  /** 搜。 */
  search(query: string, options: SearchBackendQuery): SearchHit[]
  /** 清空索引。 */
  clear(): void
  /** 释放资源（关掉文件句柄）。 */
  close(): void
}

/** 查询服务的参数。 */
export interface SessionQueryServiceOptions {
  /** 会话存储：历史内容的唯一事实来源。 */
  store: SessionStore
  /** 全文搜索后端；缺省用内存倒排索引（零配置）。 */
  search?: SessionSearchBackend
  /** 跨会话查询时最多看多少个会话；缺省 = 50。 */
  maxConversations?: number
  /** 单个会话最多读多少条消息；缺省 = 20000。 */
  maxMessagesPerConversation?: number
}

/** 会话在查询结果里的样子。 */
export interface ConversationSummary {
  /** 会话 id。 */
  id: string
  /** 会话种类。 */
  kind: Conversation['kind']
  /** 标题。 */
  title: string
  /** 成员 agent id。 */
  memberAgentIds: string[]
  /** 创建时间。 */
  createdAt: number
  /** 最后更新时间。 */
  updatedAt: number
  /** 这个会话里有多少条消息。 */
  messageCount: number
}
