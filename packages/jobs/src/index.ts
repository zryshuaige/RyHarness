/**
 * RyHarness 后台任务与计划模式。
 *
 * 两族东西放在一个包里，因为它们是同一件事的两头：**一件要花时间的事，怎么跟人
 * 打交道**。
 *
 * - **后台任务**（{@link JobService}）：一件长活交给后台跑，agent 不被卡住；跑完了
 *   通过宿主回调通知，写进会话——不是让模型轮询。任务属于起它的那个 agent。
 * - **计划模式**（{@link PlanModeService}）：开着的时候 agent 先探索设计，交一份
 *   计划上去**等人批**，批了才执行；打回就改一版再交。模式按会话生效。
 *
 * 通知怎么回到会话里是宿主的事：包里只负责把「发生了什么」交出去
 * （{@link renderJobNotice} / {@link renderPlanNotice}），由上层落进对话。
 * @module @ryharness/jobs
 */

export { duration, renderJob, renderJobNotice, renderPhase, renderPlanNotice } from './format.ts'
export type { JobServiceOptions } from './job-service.ts'
export { DEFAULT_JOB_CONCURRENCY, JOB_TOOL_NAMES, JobService } from './job-service.ts'
export type { JobToolHost } from './job-tools.ts'
export {
  createJobCancelTool,
  createJobListTool,
  createJobResultTool,
  createJobStartTool,
  JOB_CANCEL_TOOL_NAME,
  JOB_LIST_TOOL_NAME,
  JOB_RESULT_TOOL_NAME,
  JOB_START_TOOL_NAME,
} from './job-tools.ts'
export type { PlanModeServiceOptions } from './plan-service.ts'
export { PLAN_TOOL_NAMES, PlanModeService } from './plan-service.ts'
export type { PlanToolHost } from './plan-tools.ts'
export {
  createPlanProposeTool,
  createPlanReadTool,
  PLAN_PROPOSE_TOOL_NAME,
  PLAN_READ_TOOL_NAME,
} from './plan-tools.ts'
export type { SubagentDelegate } from './subagent-executor.ts'
export { createSubagentJobExecutor } from './subagent-executor.ts'
export type {
  JobCompletionNotice,
  JobExecutor,
  JobExecutorContext,
  JobFilter,
  JobPhase,
  JobScope,
  JobSnapshot,
  JobStartInput,
  JobStatus,
  PlanDraft,
  PlanGate,
  PlanSnapshot,
  PlanStatus,
  PlanStep,
} from './types.ts'
