/**
 * RyHarness 编排：让模型写一段编排脚本，把活派给子代理并行去做，最后拿回一个值。
 *
 * 三块：
 * - **引擎**（{@link WorkflowEngine}）：跑编排脚本，管扇出上限、时限与收尾。
 * - **执行器契约**（{@link WorkflowAgentExecutor}）：「派一个活出去、等它回来」这一条
 *   接口。宿主注入什么，编排就派给谁——本仓的子代理、别的后端、测试里的假实现都算。
 * - **模型工具**（{@link createWorkflowTool}）：模型看得见的那件 `workflow` 工具。
 *
 * 脚本跑在 PTC 的运行时里（`@ryharness/ptc`），所以「模型写程序、宿主提供能力」这套
 * 语义是共用的，编排只是给它套了一层「派子代理」的能力。
 * @module @ryharness/workflow
 */

export type { WorkflowEngineOptions } from './engine.ts'
export { DEFAULT_WORKFLOW_MAX_FAN_OUT, DEFAULT_WORKFLOW_TIMEOUT_MS, WorkflowEngine } from './engine.ts'
export type { InMemoryWorkflowExecutorOptions } from './executor.ts'
export { createInMemoryWorkflowExecutor } from './executor.ts'
export type { WorkflowToolOptions } from './tool.ts'
export { createWorkflowTool, renderWorkflowResult, WORKFLOW_TOOL_NAME } from './tool.ts'
export type {
  PtcFailure,
  PtcFilePolicy,
  WorkflowAgentExecutor,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowAgentRun,
  WorkflowAgentStatus,
  WorkflowRequest,
  WorkflowResult,
  WorkflowToolContext,
} from './types.ts'
