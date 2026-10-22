/**
 * RyHarness SQLite 会话持久化。
 *
 * 表：agents（Agent 定义，常用字段展开、persona 存人格 JSON）、conversations
 * （direct|group）、messages（内容块/提及以 JSON 存储，seq 自增做分页游标，usage
 * 记录该条消息关联的模型调用开销）、messages_fts（正文 bigram FTS5 索引，供关键词
 * 搜索）、dispatch_events（群聊调度决策记录）。schema 演进遵循 dsh 规则：
 * 单调 SCHEMA_VERSION，只追加迁移，不修改或删除已发布版本。
 * @module @ryharness/session
 */

export type {
  ChatTurnOptions,
  ContextInjection,
  CoordinatorOptions,
  RunContext,
  UsageReport,
} from './coordinator.ts'
export {
  groupHistoryRowWeight,
  HISTORY_BUDGET_TOKENS,
  historyRowWeight,
  isToolErrorRow,
  SessionCoordinator,
  TOOL_ERROR_BLOCK_TYPE,
} from './coordinator.ts'
export { bigrams, ftsMatchQuery, messageSearchText } from './fts.ts'
export type {
  AffinityEvent,
  AffinityTier,
  AgentPersona,
  TraitBand,
  TraitKey,
  TraitMeta,
  VoicePreset,
} from './persona.ts'
export {
  AFFINITY_DISLIKE_LOSS,
  AFFINITY_LIKE_GAIN,
  AFFINITY_TIERS,
  affinityTier,
  affinityTurnGain,
  clampTrait,
  composePersonaPrompt,
  NO_VOICE_ID,
  normalizePersona,
  normalizeVoiceId,
  PERSONA_DEFAULTS,
  PERSONA_PROMPT_HEADER,
  serializePersona,
  suggestTemperature,
  TRAIT_KEYS,
  TRAIT_META,
  traitBand,
  traitMeta,
  VOICE_PRESETS,
  voiceName,
} from './persona.ts'
export { repairToolCallPairing } from './repair.ts'
export { MIGRATIONS, migrate, SCHEMA_VERSION } from './schema.ts'
export type {
  AgentInput,
  ConversationInput,
  DeleteAgentResult,
  HistoryReadOptions,
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
  MessageArtifact,
  SenderType,
  StoredAgent,
  StoredMessage,
  StoredUsage,
  UsageTotals,
} from './types.ts'
