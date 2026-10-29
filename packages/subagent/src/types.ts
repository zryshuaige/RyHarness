/**
 * 子代理能力家族的类型契约。
 *
 * 三个角色分得很清：**provider** 负责「怎么把一段活跑完」，**service** 负责
 * 「谁来派、谁在跑、跑完记什么」，**工具** 是模型看得见的那两件东西。契约放在
 * 这里而不是各自分散，是为了让人一眼看出「模型路由 / 工具集 / 时长 / 结果」
 * 这四件事各自由谁说了算。
 * @module @ryharness/subagent/types
 */

import type { ToolContext, ToolSource } from '@ryharness/agent'

/**
 * 子代理的四种状态。
 *
 * 「取消」没有单列一档：父对话被打断与子代理自己跑挂，对父代理来说是同一件事——
 * 这趟活没拿到结果。把它并进 failed，父代理只需要处理一种坏结果。
 */
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'timeout'

/** 模型路由：provider 路由 id + 模型 id。 */
export interface SubagentRoute {
  /** provider 路由 id（`ctx.llm` 注册过的那个）。 */
  provider: string
  /** 模型 id。 */
  model: string
}

/** 运行中的进度快照。 */
export interface SubagentProgress {
  /** 已经跑了几步（模型调用次数）。 */
  steps: number
  /** 已经用过的工具名（按首次出现顺序去重）。 */
  tools: readonly string[]
}

/** 一次子代理任务的输入。 */
export interface SubagentRunInput {
  /** 本次运行的 id（服务分配，同一服务内唯一）。 */
  id: string
  /** 任务描述：子代理唯一能看到的上文，父对话历史不进它的上下文。 */
  task: string
  /** 模型路由。 */
  route: SubagentRoute
  /** 子代理可用的工具集（按名解析；不含委派工具）。 */
  tools: ToolSource
  /** 子代理的工具名白名单。 */
  toolNames: readonly string[]
  /** 步数上限（模型调用次数）。 */
  maxSteps: number
  /** 时长上限（毫秒）。 */
  timeoutMs: number
  /** 取消信号：父对话被打断、或本轮结束回收子代理时 abort。 */
  signal?: AbortSignal
  /** 工具执行上下文（工作区根目录、会话 id 等）——子代理与父代理共用同一份。 */
  context: ToolContext
  /** 子代理的系统提示词；缺省用包内那段。 */
  systemPrompt?: string
  /**
   * 进度回调。
   *
   * 有了它，「还在跑」的子代理才不是一条只有 id 的空记录：父代理在 `subagent_list`
   * 里能看见它跑到第几步、用过哪些工具。
   */
  onProgress?: (progress: SubagentProgress) => void
}

/** 子代理跑完后的结果。 */
export interface SubagentResult {
  /** 子代理 id。 */
  id: string
  /** 最后一条 assistant 文本——父代理拿到的就是它。 */
  text: string
  /** 子代理用过的工具名（按首次出现顺序去重）。 */
  tools: readonly string[]
  /** 跑了几步（模型调用次数）。 */
  steps: number
  /** 终态。 */
  status: SubagentStatus
  /** 失败或超时的原因（中文，可直接给模型看）。 */
  error?: string
}

/**
 * 子代理 provider 契约。
 *
 * 一个 provider 只需要能回答一件事：**给一段任务描述 + 一份工具集，跑一次独立的
 * 任务，把最终结果回给父代理**。进程内、跨进程、ACP 后端都只是这条契约的不同实现。
 */
export interface SubagentProvider {
  /** provider id（如 `in-process`）。 */
  readonly id: string
  /**
   * 跑一次任务。
   *
   * 实现必须遵守 `input.signal`：父对话被打断时不许把子代理撂在那儿自己跑。
   * @param input - 任务、模型路由、工具集、步数与时长上限。
   * @returns 子代理的最终结果。
   */
  run(input: SubagentRunInput): Promise<SubagentResult>
}

/** 一次委派的请求（程序化调用与模型工具共用同一份）。 */
export interface SubagentRequest {
  /** 任务描述。 */
  task: string
  /** 模型 id；缺省用父代理的路由。 */
  model?: string
  /** provider id；缺省用服务默认的 provider。 */
  provider?: string
}

/** 一次委派的记录：可观测性的唯一来源。 */
export interface SubagentRunRecord {
  /** 子代理 id。 */
  id: string
  /** 任务描述。 */
  task: string
  /** 实际用的模型路由。 */
  route: SubagentRoute
  /** 终态。 */
  status: SubagentStatus
  /** 跑了几步。 */
  steps: number
  /** 用过的工具名。 */
  tools: readonly string[]
  /** 开始时刻（毫秒时间戳）。 */
  startedAt: number
  /** 结束时刻（毫秒时间戳）；还在跑时没有。 */
  finishedAt?: number
  /** 耗时（毫秒）。 */
  durationMs: number
  /** 最后一条 assistant 文本。 */
  text: string
  /** 失败或超时的原因。 */
  error?: string
  /** 所属会话。 */
  conversationId?: string
  /** 发起委派的 agent id。 */
  agentId?: string
  /** 所属轮次（同一会话内从 1 开始递增）。 */
  round: number
}

/** 查询记录的条件。 */
export interface SubagentRunFilter {
  /** 只看这个会话的记录；不填则不按会话过滤。 */
  conversationId?: string
  /** `current` 只看当前轮；`all` 看全部轮。 */
  round?: 'current' | 'all'
  /** 只看这个状态的记录。 */
  status?: SubagentStatus
}
