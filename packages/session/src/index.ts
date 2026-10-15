/**
 * RyAgent SQLite 会话持久化。
 *
 * 表：agents（Agent 定义，常用字段展开）、conversations（direct|group）、
 * messages（内容块/提及以 JSON 存储，seq 自增做分页游标，usage 记录该条
 * 消息关联的模型调用开销）、messages_fts（正文 bigram FTS5 索引，供关键词
 * 搜索）、dispatch_events（群聊调度决策记录）。schema 演进遵循 dsh 规则：
 * 单调 SCHEMA_VERSION，只追加迁移，不修改或删除已发布版本。
 * @module @ryagent/session
 */

export type { CoordinatorOptions, RunContext, UsageReport } from './coordinator.ts'
export { SessionCoordinator } from './coordinator.ts'
export { bigrams, ftsMatchQuery, messageSearchText } from './fts.ts'
export { MIGRATIONS, migrate, SCHEMA_VERSION } from './schema.ts'
export type {
  AgentInput,
  ConversationInput,
  DeleteAgentResult,
  MessageInput,
  MessagePage,
  MessageSearchHit,
  MessageSearchOptions,
} from './store.ts'
export { MESSAGE_SEARCH_WINDOW, SessionStore } from './store.ts'
export type {
  Conversation,
  ConversationKind,
  DispatchEvent,
  SenderType,
  StoredAgent,
  StoredMessage,
  StoredUsage,
  UsageTotals,
} from './types.ts'
