/**
 * RyAgent SQLite 会话持久化。
 *
 * 表：agents（Agent 定义，常用字段展开）、conversations（direct|group）、
 * messages（内容块/提及以 JSON 存储，seq 自增做分页游标）、dispatch_events
 * （群聊调度决策记录）。schema 演进遵循 dsh 规则：单调 SCHEMA_VERSION，
 * 只追加迁移，不修改或删除已发布版本。
 * @module @ryagent/session
 */

export { SessionStore } from './store.ts'
export type { AgentInput, ConversationInput, MessageInput, MessagePage } from './store.ts'
export { SCHEMA_VERSION, MIGRATIONS, migrate } from './schema.ts'
export type {
  Conversation,
  ConversationKind,
  DispatchEvent,
  SenderType,
  StoredAgent,
  StoredMessage,
} from './types.ts'
