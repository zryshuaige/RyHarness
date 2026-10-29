/**
 * RyHarness 子代理：一个助理把活派给一个独立的子代理去干。
 *
 * 三个部分：
 * - **provider 契约**（{@link SubagentProvider}）：给一段任务描述 + 一份工具集，
 *   跑一次独立的任务，把最终结果回给父代理。
 * - **进程内 provider**（{@link createInProcessSubagentProvider}）：拿
 *   `@ryharness/agent` 的 AgentLoop 起一次上下文干净的运行。
 * - **服务与工具**（{@link SubagentService}）：派活、管生命周期、留记录；模型看得见
 *   的两件工具是 `subagent` 与 `subagent_list`。
 * @module @ryharness/subagent
 */

export type { InProcessSubagentProviderOptions } from './in-process.ts'
export { createInProcessSubagentProvider, DEFAULT_SUBAGENT_SYSTEM_PROMPT } from './in-process.ts'
export type { SubagentServiceOptions } from './service.ts'
export {
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DELEGATION_TOOL_NAMES,
  SubagentService,
} from './service.ts'
export type { SubagentToolHost } from './tools.ts'
export {
  createSubagentListTool,
  createSubagentTool,
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
} from './tools.ts'
export type {
  SubagentProgress,
  SubagentProvider,
  SubagentRequest,
  SubagentResult,
  SubagentRoute,
  SubagentRunFilter,
  SubagentRunInput,
  SubagentRunRecord,
  SubagentStatus,
} from './types.ts'
