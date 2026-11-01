/**
 * RyHarness 溢出文本：工具结果太长时，原文落到模型看不见的地方。
 *
 * 三块，分工明确：
 * - **存储服务**（{@link LocalSpillStore}）：把一大段文字存到本机私有文件，
 *   给你一个定位符；按定位符取回来。取回是分页的——一次给全文等于把刚省下来的
 *   上下文又塞回去。
 * - **策略**（{@link applySpillPolicy}）：判定一个工具结果要不要溢出，溢出了给
 *   模型看什么。纯函数，存储从外面注入。
 * - **取回工具**（{@link createSpillReadTool}）：模型拿着定位符自己来取。
 *
 * 边界写在 README 里：这一包**不做**压缩、不做代际轮转，也不认识 agent 与会话
 * 循环——它只管「存下来」和「取回去」。
 * @module @ryharness/spill
 */

export type { LocalSpillStoreOptions } from './local.ts'
export { isSpillId, LocalSpillStore, sessionSlug } from './local.ts'
export type {
  SpillApplyOverrides,
  SpillCandidate,
  SpillPolicyOptions,
  SpillPolicyOutcome,
} from './policy.ts'
export {
  applySpillPolicy,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MAX_INLINE_TOKENS,
  DEFAULT_PREVIEW_CHARS,
  formatSpillNotice,
  inlineLimitChars,
  isPlainTextResult,
  SpillPolicy,
} from './policy.ts'
export type { SpillReadToolOptions } from './tools.ts'
export { createSpillReadTool, DEFAULT_READ_CHARS } from './tools.ts'
export type {
  SpillCleanupOptions,
  SpillCleanupResult,
  SpillErrorCode,
  SpillMeta,
  SpillReadOptions,
  SpillReadResult,
  SpillRef,
  SpillStore,
  SpillTool,
  SpillToolContext,
  SpillToolResult,
} from './types.ts'
export { SPILL_READ_TOOL_NAME, SpillError } from './types.ts'
