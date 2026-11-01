/**
 * RyHarness 目标：一个会话跨重启要完成的那一件事。
 *
 * 三块，分工明确：
 * - **服务**（{@link GoalService}）：一个会话至多一个目标，建、改、暂停、恢复、完成、
 *   卡住、清除都归它；每次改动留一笔历史。
 * - **存储**（{@link GoalStore}）：目标要跨重启还在，所以它必须能被存下来再读回来；
 *   包内给文件后端（{@link FileGoalStore}）与内存后端（{@link MemoryGoalStore}）。
 * - **两个面**：模型看得见的三件工具（`get_goal` / `create_goal` / `update_goal`），
 *   以及人直接用的 `/goal` 命令（{@link createGoalCommand}，不花模型一轮）。
 *
 * 目标是**完成状态**，不是排程：这一族不负责「什么时候提醒」，那是 `schedule` 的事。
 * @module @ryharness/goal
 */

export type {
  GoalCommandArgs,
  GoalCommandDefinition,
  GoalCommandOptions,
  GoalCommandResult,
} from './command.ts'
export { createGoalCommand, GOAL_COMMAND_NAME } from './command.ts'
export type { GoalServiceOptions } from './service.ts'
export {
  ALLOWED_TRANSITIONS,
  GOAL_STATUS_LABELS,
  GoalService,
} from './service.ts'
export type { FileGoalStoreOptions } from './storage.ts'
export { FileGoalStore, MemoryGoalStore } from './storage.ts'
export type {
  GoalTool,
  GoalToolContext,
  GoalToolHost,
  GoalToolResult,
} from './tools.ts'
export {
  createGoalCreateTool,
  createGoalGetTool,
  createGoalTools,
  createGoalUpdateTool,
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_TOOL_NAMES,
  GOAL_UPDATE_TOOL_NAME,
  renderGoal,
} from './tools.ts'
export type {
  Goal,
  GoalAction,
  GoalChange,
  GoalErrorCode,
  GoalRecord,
  GoalStatus,
  GoalStore,
} from './types.ts'
export { GoalError } from './types.ts'
