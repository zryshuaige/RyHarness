/**
 * RyHarness 精简 agent 运行时。
 *
 * 三个部分组成：AgentDefinition（可持久化的身份+能力定义）、内置模板
 * （Ryen 猫管家总管 + forkTemplate 派生）、AgentLoop（消息+工具循环，
 * 构造注入 LlmRuntime，不依赖 cordis 插件化）。
 * @module @ryharness/agent
 */

export { ABORTED_CODE, AbortedError, abortedErrorOf, isAbortedError, throwIfAborted } from './aborted.ts'
export type { RequestBudget } from './budget.ts'
export {
  DEFAULT_RESERVED_COMPLETION_TOKENS,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  MIN_OUTPUT_TOKENS,
  outputTokenCap,
  resolveRequestBudget,
} from './budget.ts'
export { BUILTIN_TEMPLATES, forkTemplate, RYEN_TEMPLATE } from './builtin.ts'
export type { CompactionOptions, CompactResult, CompactSpec } from './compact.ts'
export {
  alignWindowStart,
  compactHistory,
  createLlmSummarizer,
  PRUNE_MARKER,
  pruneToolResults,
  resolveCompactSpec,
} from './compact.ts'
export type {
  AgentEvolutionHooks,
  AgentLoopOptions,
  AgentMemoryHooks,
  AgentRunOptions,
  EvolutionTurnData,
  SessionQuota,
  SessionQuotaLimits,
  SessionQuotaUsage,
} from './loop.ts'
export {
  AgentLoop,
  createSessionQuota,
  DEFAULT_HISTORY_BUDGET_TOKENS,
  DEFAULT_SESSION_QUOTA_LIMITS,
  DEFAULT_TOOL_CONCURRENCY,
  MAX_LOOP_CONTEXT_TOKENS,
  trimHistoryToBudget,
} from './loop.ts'
export type { PermissionPreset, PermissionPresetSpec } from './permission.ts'
export {
  applyPermissionPreset,
  CORE_TOOL_NAMES,
  detectPermissionPreset,
  PERMISSION_PRESETS,
  permissionPreset,
} from './permission.ts'
export { listTools, resolveAllowedTools } from './tool-source.ts'
export type {
  AgentDefinition,
  AgentLoopEvent,
  ProduceCard,
  Tool,
  ToolContext,
  ToolExecutionMode,
  ToolLookup,
  ToolResult,
  ToolSource,
} from './types.ts'
