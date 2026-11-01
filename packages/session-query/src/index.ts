/**
 * RyHarness 会话历史查询：把「查历史」收成一个服务。
 *
 * 四件事：
 *   1. **精确读**——按 id 取一条消息、一轮、一个会话；
 *   2. **筛选列表**——按会话 / 发言者 / 种类 / 时间区间列消息，游标翻页；
 *   3. **关系追踪与血缘**——一条消息和谁有关系、它是哪一轮的第几条；
 *   4. **全文搜索**——跨会话搜正文，后端可换（内存倒排 / SQLite FTS5）。
 *
 * 外加**会话导出**：把一个会话打成一个 ZIP（自己拼格式，不引外部依赖）。
 *
 * 内容一律以 `@ryharness/session` 的 SessionStore 为准：模型看到的历史是从那里
 * 读出来的，于是「搜出来的」与「模型看到的」不会对不上——这是上游反复强调的
 * 一条硬要求，也是本包唯一不能让步的地方。
 *
 * 不做上游那套**投影层**（projection）：投影是把提交过的事件流折成「当前值」的
 * 机制，属于写侧；本包只管读，写的形状由 `@ryharness/session` 那一族负责。
 * @module @ryharness/session-query
 */

export { decodeCursor, encodeCursor, filterFingerprint } from './cursor.ts'
export type { SessionQueryErrorCode } from './errors.ts'
export { SessionQueryError } from './errors.ts'
export type { SessionExportArtifact, SessionExportOptions, SessionExportResult } from './export.ts'
export { exportSession } from './export.ts'
export { matchesFilter, messageKinds } from './filters.ts'
export type { Fts5SearchBackendOptions } from './fts5.ts'
export { Fts5SearchBackend } from './fts5.ts'
export { MemorySearchBackend } from './search.ts'
export { requireConversation, SessionQueryService } from './service.ts'
export {
  hasTextBlock,
  hasToolCallBlock,
  makeSnippet,
  searchableText,
  searchTokenList,
  searchTokens,
  textMatchesQuery,
  toolCallIds,
} from './text.ts'
export type {
  SessionQueryTool,
  SessionQueryToolContext,
  SessionQueryToolHost,
  SessionQueryToolResult,
} from './tools.ts'
export {
  createSessionQueryTools,
  createSessionReadTool,
  createSessionSearchTool,
  createSessionTraceTool,
  formatTime,
  renderMessage,
  SESSION_QUERY_TOOL_NAMES,
  SESSION_READ_TOOL_NAME,
  SESSION_SEARCH_TOOL_NAME,
  SESSION_TRACE_TOOL_NAME,
} from './tools.ts'
export type { ReplyGraph } from './tracing.ts'
export { buildLineage, buildReplyGraph, traceRelations } from './tracing.ts'
export type {
  ConversationSummary,
  MessageFilter,
  MessageKind,
  MessageLineage,
  MessageOrder,
  MessagePage,
  RelationTrace,
  RelationTraceOptions,
  SearchBackendQuery,
  SearchDocument,
  SearchHit,
  SearchOptions,
  SearchResult,
  SessionQueryServiceOptions,
  SessionSearchBackend,
  TurnSummary,
  TurnView,
} from './types.ts'
export type { ZipEntry, ZipOptions } from './zip.ts'
export { crc32, createZip } from './zip.ts'
