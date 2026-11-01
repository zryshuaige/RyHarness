/**
 * 后台任务与计划模式的类型契约。
 *
 * 两族东西放一个文件，是因为它们回答的是同一类问题：**一件要花时间的事，怎么跟人
 * 打交道**。后台任务是「做完了来告诉我」，计划模式是「先给我看计划、我点头你再动」。
 * 契约写在一处，是为了让人一眼看出「谁拥有它 / 它现在什么状态 / 谁负责通知」这三件
 * 事各自由谁说了算。
 * @module @ryharness/jobs/types
 */

import type { ToolContext } from '@ryharness/agent'

/**
 * 后台任务的状态。
 *
 * `queued` 单独占一档，是因为并发槽位满了的时候任务**真的在等**：等着的时候它既没
 * 失败也没成功，把它算成「运行中」会让人以为它已经在干活。
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * 任务时间线上的一段（一步）。
 *
 * 「每一步有耗时与结果摘要」是这一族的核心承诺：后台任务跑了十分钟，主人回来只想
 * 知道「哪一步慢、哪一步出了岔子」，而不是一段没法验收的「还在跑」。
 */
export interface JobPhase {
  /** 这一步在做什么（发起任务时写下的说明）。 */
  label: string
  /**
   * 这一步的状态。
   *
   * `skipped` 是「没轮到」：计划里有这一步，执行器却没单独报它——多半是执行器把整趟
   * 活一口气干完了。它跟 `failed` 必须分开：把没做的事说成失败了，主人会以为出了岔子。
   */
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'
  /** 这一步的起始时刻（毫秒时间戳）；还没开始时没有。 */
  startedAt?: number
  /** 这一步的结束时刻（毫秒时间戳）。 */
  finishedAt?: number
  /** 这一步花了多久（毫秒）。 */
  durationMs: number
  /** 这一步的结果摘要：一句人话，给模型与主人看。 */
  summary?: string
}

/**
 * 一次后台任务的快照。
 *
 * 快照是**只读副本**：调用方拿到的是一份拷贝，不会随着任务继续跑而变化——否则
 * 「列出任务」这件事在并发下根本没法安全地做。
 */
export interface JobSnapshot {
  /** 任务 id（服务内唯一）。 */
  id: string
  /** 任务类型：决定用哪个执行器。 */
  kind: string
  /** 这趟活要干什么（一句话）。 */
  task: string
  /** 当前状态。 */
  status: JobStatus
  /** 归属的 agent id：任务属于起它的那个 agent。 */
  ownerAgentId: string
  /** 归属的会话 id；通知写回哪儿由它决定。 */
  conversationId?: string
  /** 登记时刻（毫秒时间戳）。 */
  createdAt: number
  /** 开跑时刻（毫秒时间戳）；还在排队时没有。 */
  startedAt?: number
  /** 收尾时刻（毫秒时间戳）；还在跑时没有。 */
  finishedAt?: number
  /** 排队等了多久（毫秒）：并发槽位满时它会明显大于 0。 */
  queuedMs: number
  /** 总耗时（毫秒）：还在跑时是已经花掉的时间。 */
  durationMs: number
  /** 成功时的结果摘要。 */
  result?: string
  /** 失败或被取消时的原因。 */
  error?: string
  /** 时间线：每一步。 */
  phases: readonly JobPhase[]
}

/** 起一个后台任务的入参。 */
export interface JobStartInput {
  /** 任务类型：决定用哪个执行器；不填用服务上的默认类型。 */
  kind?: string
  /** 这趟活要干什么——写全，后台没有上下文可看。 */
  task: string
  /** 打算走的几步，每步一句说明；执行器会逐步回报结果。 */
  steps?: readonly string[]
}

/**
 * 一次查询或操作的范围。
 *
 * 归属规则是这一族最要紧的一条：**任务属于起它的那个 agent**。别的 agent 拿同一个
 * id 也调不动它——哪怕两者在同一个会话里。跨会话则一律不可见：同一个 agent 在两个
 * 会话里各起各的任务，互不干扰。
 */
export interface JobScope {
  /** 发起查询的 agent id；不填按「没有 agent 的上下文」处理。 */
  agentId?: string
  /** 会话 id；不填则不按会话过滤。 */
  conversationId?: string
}

/** 查询任务的条件。 */
export interface JobFilter extends JobScope {
  /** 只看这个状态的。 */
  status?: JobStatus
}

/**
 * 任务收尾时递给宿主的一条通知。
 *
 * 宿主拿到它之后要做的事只有一件：**把这条通知写进会话**，让起任务的 agent 在对话里
 * 看到「你派的那趟活跑完了」。不是轮询——模型不必主动去问。
 */
export interface JobCompletionNotice {
  /** 任务的最终快照。 */
  job: JobSnapshot
  /** 通知该写进哪个会话。 */
  conversationId?: string
  /** 通知该写给哪个 agent。 */
  ownerAgentId: string
}

/** 执行器拿到的上下文。 */
export interface JobExecutorContext {
  /** 任务的初始快照（id / kind / task 在这里）。 */
  readonly job: JobSnapshot
  /**
   * 工具执行上下文。
   *
   * 它**不是**发起那一轮的工具上下文：那里的 signal 属于「这一轮」，这一轮收尾就会
   * abort。后台任务要在这一轮结束之后继续跑，所以这里给的是一份重新造的上下文，
   * signal 只在任务被取消时才 abort。
   */
  readonly toolContext: ToolContext
  /** 开始一步：运行时记下这一步的起始时刻。 */
  beginStep(index: number): void
  /** 完成一步：记下耗时与结果摘要。 */
  completeStep(index: number, summary: string): void
  /** 某一步失败：整趟活按失败收尾。 */
  failStep(index: number, summary: string): void
}

/**
 * 执行器契约。
 *
 * 一个执行器只需要能回答一件事：**给一段任务描述，把活干完，交回一句结果摘要**。
 * 派子代理、跑一条长命令、扫一遍目录——都只是这条契约的不同实现。
 */
export interface JobExecutor {
  /** 执行器 id（任务按它选执行器）。 */
  readonly kind: string
  /**
   * 跑一趟活。
   *
   * 实现必须遵守 `ctx.toolContext.signal`：任务被取消时不许把活撂在那儿自己跑完。
   * @param ctx - 任务快照、工具上下文与逐步回报的方法。
   * @returns 结果摘要（成功后进任务快照与通知）。
   */
  run(ctx: JobExecutorContext): Promise<string>
}

/**
 * 计划的状态。
 *
 * `none` 是「还没有计划」；`proposed` 是**待批**——人还没点头，这时候不许动手。
 */
export type PlanStatus = 'none' | 'proposed' | 'approved' | 'rejected'

/** 计划里的一步。 */
export interface PlanStep {
  /** 这一步要做什么（一句话）。 */
  title: string
  /** 这一步的说明（怎么做、注意什么）；可省。 */
  detail?: string
}

/** 提交计划时的草稿。 */
export interface PlanDraft {
  /** 计划标题：一句话说清要做什么。 */
  title: string
  /** 步骤清单。 */
  steps: readonly PlanStep[]
}

/** 计划的快照。 */
export interface PlanSnapshot {
  /** 计划属于哪个会话。 */
  conversationId: string
  /** 交这份计划的助理 id：通知要写进会话并署名，得知道是谁交的。 */
  agentId?: string
  /**
   * 版本号：每提交一次 +1。
   *
   * 打回之后 agent 改一版重新交上来，版本号就会变——主人因此能分得清「这是改过的
   * 第二版」，而不是同一版又递了一次。
   */
  version: number
  /** 计划标题。 */
  title: string
  /** 步骤清单。 */
  steps: readonly PlanStep[]
  /** 当前状态（不含 `none`：没有计划时没有快照）。 */
  status: Exclude<PlanStatus, 'none'>
  /** 提交时刻（毫秒时间戳）。 */
  createdAt: number
  /** 人做决定（批或打回）的时刻（毫秒时间戳）。 */
  decidedAt?: number
  /** 打回时人给的反馈：agent 下一版要照着改。 */
  feedback?: string
}

/**
 * 「现在能不能动手」的判定结果。
 *
 * 计划模式只**引导**不**封锁**工具——工具清单由宿主另配。这里管的是「计划这件事
 * 批了没有」，宿主拿它决定要不要把这一轮继续跑下去。
 */
export interface PlanGate {
  /** 现在能不能执行计划。 */
  allowed: boolean
  /** 不能执行时的一句人话原因（给模型看）。 */
  reason?: string
}
