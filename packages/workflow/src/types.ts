/**
 * 编排这一族的类型契约。
 *
 * 编排是 PTC 的用法之一：模型写一段**编排脚本**，脚本把活派给子代理，最后带回一个值。
 * 所以这里的类型只多两样东西：**子代理执行器**（宿主注入，引擎不关心它怎么跑）与
 * **一次编排的记录**（派了谁、跑成什么样）。
 *
 * 引擎本身不懂 agent、不懂会话、不懂模型路由——它只认 {@link WorkflowAgentExecutor}
 * 这一条契约。接一个别的后端（进程内、跨进程、远程），就是实现同一个 `run` 接口。
 * @module @ryharness/workflow/types
 */

import type { PtcFailure, PtcFilePolicy } from '@ryharness/ptc'

export type { PtcFailure, PtcFilePolicy }

/**
 * 工具上下文。
 *
 * 引擎不解释它，只原样递给子代理执行器——子代理要走哪条模型路由、要不要带上会话
 * 信息，是宿主那边的事。
 */
export interface WorkflowToolContext {
  /** 工作区根目录。 */
  workspaceRoot: string
  /** 当前轮所属会话。 */
  conversationId?: string
  /** 正在执行的 agent id。 */
  agentId?: string
  /** 调用方的取消信号。 */
  signal?: AbortSignal
}

/** 一次子代理委派的请求。 */
export interface WorkflowAgentRequest {
  /** 子代理 id（引擎给的，同一次编排内唯一）。 */
  id: string
  /** 任务描述：子代理唯一能看到的上文。 */
  task: string
  /** 这次委派的标签（脚本可以给，便于排查）。 */
  label?: string
  /** 宿主传下来的调用上下文；引擎不解释，原样递给执行器。 */
  context?: WorkflowToolContext
  /** 取消信号：编排收摊时它会 abort。 */
  signal?: AbortSignal
}

/**
 * 子代理的终态。
 *
 * 「取消」并进 `failed`：对编排脚本来说都是「这趟活没拿到结果」。
 */
export type WorkflowAgentStatus = 'running' | 'completed' | 'failed' | 'timeout'

/** 子代理跑完后的结果。 */
export interface WorkflowAgentResult {
  /** 子代理的最终文本。 */
  text: string
  /** 终态。 */
  status: WorkflowAgentStatus
  /** 失败或超时的原因（中文，可直接给模型看）。 */
  error?: string
}

/**
 * 子代理执行器：宿主注入，编排引擎只认这一条。
 *
 * 引擎不碰 agent 循环、不碰模型路由、不碰会话存储——它只管「派一个活出去，等它回来」。
 */
export interface WorkflowAgentExecutor {
  /**
   * 跑一个子代理。
   * @param request - 任务描述、id、标签与取消信号。
   * @returns 子代理的最终结果。
   */
  run(request: WorkflowAgentRequest): Promise<WorkflowAgentResult>
}

/** 一次编排请求。 */
export interface WorkflowRequest {
  /** 编排脚本源码。 */
  script: string
  /** 一句话说明这次编排要干什么（宿主用来记日志）。 */
  description?: string
  /** 这次编排的时限（毫秒）。 */
  timeoutMs?: number
  /** 这次编排最多派几个子代理。 */
  maxFanOut?: number
  /** 脚本能读写的路径。 */
  filePolicy?: PtcFilePolicy
  /** 调用上下文（转交给子代理执行器）。 */
  context?: WorkflowToolContext
}

/** 一次委派的记录（按派出的顺序排）。 */
export interface WorkflowAgentRun {
  /** 子代理 id。 */
  id: string
  /** 任务描述。 */
  task: string
  /** 标签。 */
  label?: string
  /** 终态。 */
  status: WorkflowAgentStatus
  /** 子代理的最终文本。 */
  text?: string
  /** 失败或超时的原因。 */
  error?: string
  /** 跑了多久（毫秒）。 */
  durationMs: number
}

/** 一次编排的结果。 */
export interface WorkflowResult {
  /** 编排跑成了没有。 */
  ok: boolean
  /** 脚本打印出来的内容。 */
  output: readonly string[]
  /** 脚本的返回值。 */
  value?: unknown
  /** 失败信息。 */
  failure?: PtcFailure
  /** 派出去的子代理（按派出的顺序）。 */
  agents: readonly WorkflowAgentRun[]
  /** 这次编排花了多久（毫秒）。 */
  durationMs: number
}
