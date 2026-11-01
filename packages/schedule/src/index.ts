/**
 * RyHarness 提醒：到点在原会话里说一句。
 *
 * 四块，分工明确：
 * - **服务**（{@link ScheduleService}）：建提醒、算下一次响、到点投递、停用与删除；
 * - **触发方式**（{@link ScheduleTrigger}）：一次性 / 固定间隔 / 每日 / 每周 / cron；
 * - **cron 解析器**（{@link parseCron}）：自己写的五段解析器，不引外部依赖；
 * - **模型看得见的四件工具**：`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。
 *
 * 提醒跨 Host 重启存活，投递方式由宿主给（本包不碰会话存储）；删除要确认。
 * @module @ryharness/schedule
 */

export type { CronSpec } from './cron.ts'
export { cronHasFuture, nextCronTime, parseCron } from './cron.ts'
export type {
  ScheduleCreateInput,
  ScheduleServiceOptions,
  ScheduleTickResult,
  ScheduleUpdateInput,
} from './service.ts'
export { ScheduleService } from './service.ts'
export type { FileScheduleStoreOptions } from './storage.ts'
export { FileScheduleStore, MemoryScheduleStore } from './storage.ts'
export type { TimeOfDay } from './timing.ts'
export {
  computeNextRun,
  describeCron,
  describeTrigger,
  formatTimeOfDay,
  nextDailyTime,
  nextIntervalTime,
  nextWeeklyTime,
  parseTimeOfDay,
  weekdayName,
} from './timing.ts'
export type {
  ScheduleTool,
  ScheduleToolContext,
  ScheduleToolHost,
  ScheduleToolResult,
} from './tools.ts'
export {
  createScheduleCreateTool,
  createScheduleDeleteTool,
  createScheduleListTool,
  createScheduleTools,
  createScheduleUpdateTool,
  parseTrigger,
  renderTask,
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_DELETE_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_TOOL_NAMES,
  SCHEDULE_UPDATE_TOOL_NAME,
} from './tools.ts'
export type {
  MissedPolicy,
  ScheduleErrorCode,
  ScheduleStatus,
  ScheduleStore,
  ScheduleTask,
  ScheduleTrigger,
} from './types.ts'
export { ScheduleError } from './types.ts'
