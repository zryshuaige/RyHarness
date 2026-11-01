/**
 * 后台任务服务：登记、排队、跑起来、收尾通知。
 *
 * 这里是「任务属于起它的那个 agent」这条规则的落点。所有查询与操作都要带
 * {@link JobScope}，服务按 agent id（必要时再按会话 id）核对归属；对不上就是查不到、
 * 动不了。跨会话可见性因此是默认**关**的：同一个 agent 在两个会话里各起各的任务，
 * 互不干扰，通知也各回各家。
 *
 * 任务与这一轮对话是**解耦**的：发起任务用的工具上下文里那个 signal 属于「这一轮」，
 * 这一轮收尾就会 abort；后台任务要在收尾之后继续跑，所以它另拿一个只在「被取消」
 * 时才 abort 的信号。
 * @module @ryharness/jobs/job-service
 */

import type { Tool, ToolContext } from '@ryharness/agent'
import { messageOf } from './format.ts'
import {
  createJobCancelTool,
  createJobListTool,
  createJobResultTool,
  createJobStartTool,
  JOB_CANCEL_TOOL_NAME,
  JOB_LIST_TOOL_NAME,
  JOB_RESULT_TOOL_NAME,
  JOB_START_TOOL_NAME,
  type JobToolHost,
} from './job-tools.ts'
import type {
  JobCompletionNotice,
  JobExecutor,
  JobExecutorContext,
  JobFilter,
  JobPhase,
  JobScope,
  JobSnapshot,
  JobStartInput,
} from './types.ts'

/** 同时跑几个后台任务；其余的排队等槽位。 */
export const DEFAULT_JOB_CONCURRENCY = 2

/** 服务内部的可变任务记录。 */
interface MutableJob {
  id: string
  kind: string
  task: string
  status: JobSnapshot['status']
  ownerAgentId: string
  conversationId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  queuedMs: number
  durationMs: number
  result?: string
  error?: string
  phases: JobPhase[]
  /** 收过尾就不再改：取消之后迟到的结果不该把「已取消」改写成「成功」。 */
  settled: boolean
  controller: AbortController
  /** 工作区根目录：执行器要跑工具时需要它。 */
  workspaceRoot: string
  /** 跑这趟活的执行器：起任务时就定下，免得排队期间换了执行器。 */
  executor: JobExecutor
}

/** 后台任务服务的构造参数。 */
export interface JobServiceOptions {
  /** 执行器列表；任务按 kind 选执行器。 */
  executors?: readonly JobExecutor[]
  /** 任务没指定 kind 时用哪个。 */
  defaultKind?: string
  /** 同时跑几个任务；其余排队。 */
  maxConcurrency?: number
  /**
   * 任务收尾时的宿主回调。
   *
   * 上层拿到通知后要做的事只有一件：把通知写进会话，让起任务的 agent 在对话里看到
   * 「你派的那趟活跑完了」。模型不必轮询。
   */
  onComplete?: (notice: JobCompletionNotice) => void | Promise<void>
}

/**
 * 后台任务服务。
 *
 * 一个实例服务一段宿主运行时：模型看得见的四件工具从这里取，任务记录也在这里。
 */
export class JobService implements JobToolHost {
  private readonly executors = new Map<string, JobExecutor>()
  private readonly jobs = new Map<string, MutableJob>()
  /** 等着跑的任务 id（先进先出）。 */
  private readonly queue: string[] = []
  /** 正在跑的任务 id → 它那趟活的 promise。 */
  private readonly running = new Map<string, Promise<void>>()
  private readonly maxConcurrency: number
  private sequence = 0
  /** 宿主回调最近一次出的错：通知没送到时宿主可以查。 */
  private callbackError: string | undefined

  /** 模型看得见的四件工具：`job_start` / `job_list` / `job_result` / `job_cancel`。 */
  readonly modelTools: readonly Tool[]

  constructor(private readonly options: JobServiceOptions = {}) {
    for (const executor of options.executors ?? []) this.executors.set(executor.kind, executor)
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_JOB_CONCURRENCY)
    this.modelTools = [
      createJobStartTool(this),
      createJobListTool(this),
      createJobResultTool(this),
      createJobCancelTool(this),
    ]
  }

  /**
   * 注册一个执行器。
   *
   * 同名覆盖是允许的：宿主重载插件时拿到的是新实例，旧的那份不该继续被选中。
   * @param executor - 执行器实现。
   */
  registerExecutor(executor: JobExecutor): void {
    this.executors.set(executor.kind, executor)
  }

  /** 已注册的执行器。 */
  listExecutors(): readonly JobExecutor[] {
    return [...this.executors.values()]
  }

  /** 宿主回调最近一次出的错；没有则 undefined。 */
  get lastCallbackError(): string | undefined {
    return this.callbackError
  }

  /**
   * 起一个后台任务。
   *
   * 它**不等**这趟活跑完：登记完就返回，agent 该干嘛干嘛。跑完了宿主会收到通知。
   * @param input - 任务类型、任务描述与打算走的几步。
   * @param ctx - 发起这一下的工具上下文（会话与 agent 归属从它来）。
   * @returns 任务的初始快照。
   */
  start(input: JobStartInput, ctx: ToolContext): JobSnapshot {
    const task = input.task.trim()
    if (task.length === 0) throw new Error('任务描述是空的：后台没有上下文可看，说清要干什么。')
    const kind = this.resolveKind(input.kind)
    if (kind.length === 0) throw new Error('没指定任务类型：这台机器上还没有注册任何任务执行器。')
    const executor = this.executors.get(kind)
    if (executor === undefined) {
      const known = [...this.executors.keys()].join('、')
      throw new Error(`没有可用的任务执行器「${kind}」${known.length === 0 ? '' : `（现在有：${known}）`}`)
    }
    this.sequence += 1
    const id = `job-${this.sequence}`
    const declared = (input.steps ?? []).map((label) => label.trim()).filter((label) => label.length > 0)
    const job: MutableJob = {
      id,
      kind,
      task,
      status: 'queued',
      ownerAgentId: ctx.agentId ?? '',
      ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
      createdAt: Date.now(),
      queuedMs: 0,
      durationMs: 0,
      // 没写步骤也要留一段：时间线上至少要看得见「它跑了多久、结果是什么」。
      phases: (declared.length === 0 ? ['执行任务'] : declared).map((label) => {
        return { label, status: 'pending', durationMs: 0 }
      }),
      settled: false,
      controller: new AbortController(),
      workspaceRoot: ctx.workspaceRoot,
      executor,
    }
    this.jobs.set(id, job)
    this.queue.push(id)
    this.pump()
    return this.snapshot(job)
  }

  /**
   * 查任务列表。
   *
   * 过滤条件全空时返回全部任务——那是**宿主**用的口径（界面要列全部）；模型走的
   * `job_list` 永远带着 agent 与会话两个条件。
   * @param filter - agent、会话与状态的条件。
   * @returns 任务的快照（按登记顺序）。
   */
  list(filter: JobFilter = {}): readonly JobSnapshot[] {
    const rows: MutableJob[] = []
    for (const job of this.jobs.values()) {
      if (!this.matches(job, filter)) continue
      rows.push(job)
    }
    return rows.map((job) => this.snapshot(job))
  }

  /**
   * 按 id 查一个任务。
   *
   * 归属对不上就是查不到：别的 agent 拿着 id 也看不到别人的活。
   * @param id - 任务 id。
   * @param scope - 查询者的 agent 与会话。
   * @returns 任务的快照；查不到时 undefined。
   */
  get(id: string, scope: JobScope): JobSnapshot | undefined {
    const job = this.jobs.get(id)
    if (job === undefined) return undefined
    if (!this.owns(job, scope)) return undefined
    return this.snapshot(job)
  }

  /**
   * 取消一个任务。
   *
   * 排队中的直接出队；跑着的 abort 掉它那趟活。已经收过尾的任务取消不动。
   * @param id - 任务 id。
   * @param scope - 操作者的 agent 与会话。
   * @returns 取消后的快照；查不到或已收尾时 undefined。
   */
  cancel(id: string, scope: JobScope): JobSnapshot | undefined {
    const job = this.jobs.get(id)
    if (job === undefined) return undefined
    if (!this.owns(job, scope)) return undefined
    if (job.settled) return undefined
    job.settled = true
    job.status = 'cancelled'
    job.finishedAt = Date.now()
    job.durationMs = job.finishedAt - job.createdAt
    job.error = '被取消了。'
    this.closePendingPhases(job, 'cancelled')
    job.controller.abort()
    const index = this.queue.indexOf(job.id)
    if (index >= 0) this.queue.splice(index, 1)
    this.notify(job)
    return this.snapshot(job)
  }

  /**
   * 全部停掉：服务下线时用。
   *
   * 逐个取消并等在跑的那些收尾——但只等一小会儿：执行器不理会 abort 也不该把关机
   * 拖死（真的不收尾的活已经被 abort 掉了，进程退出后它也就没了）。
   */
  async dispose(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (job.settled) continue
      this.cancel(job.id, {
        agentId: job.ownerAgentId,
        ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
      })
    }
    const pending = [...this.running.values()]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1000)
    })
    await Promise.race([Promise.allSettled(pending), guard])
    if (timer !== undefined) clearTimeout(timer)
  }

  /** 有槽位就把队首的任务跑起来。 */
  private pump(): void {
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift()
      if (id === undefined) return
      const job = this.jobs.get(id)
      if (job === undefined || job.status !== 'queued') continue
      this.running.set(job.id, this.execute(job, job.executor))
    }
  }

  /** 跑一趟活，收尾后让出槽位。 */
  private async execute(job: MutableJob, executor: JobExecutor): Promise<void> {
    job.status = 'running'
    job.startedAt = Date.now()
    job.queuedMs = job.startedAt - job.createdAt
    try {
      const result = await executor.run(this.executorContext(job))
      this.settle(job, 'succeeded', result)
    } catch (error) {
      this.settle(job, 'failed', messageOf(error))
    } finally {
      this.running.delete(job.id)
      this.pump()
    }
  }

  /** 收尾：定终态、结账、通知宿主。只结算一次。 */
  private settle(job: MutableJob, status: 'succeeded' | 'failed', summaryText: string): void {
    if (job.settled) return
    job.settled = true
    job.status = status
    job.finishedAt = Date.now()
    job.durationMs = job.finishedAt - job.createdAt
    if (status === 'succeeded') job.result = summaryText
    else job.error = summaryText
    this.closePendingPhases(job, status)
    this.notify(job)
  }

  /**
   * 把没走完的步骤收掉，免得时间线上留着「还在跑」的步骤。
   *
   * 还没开始的算 `skipped`（没轮到，不是出了岔子）；正在跑的按任务结局算——整趟活
   * 挂了，多半就是它挂在那儿。
   */
  private closePendingPhases(job: MutableJob, terminal: 'succeeded' | 'failed' | 'cancelled'): void {
    const now = Date.now()
    for (const phase of job.phases) {
      if (phase.status !== 'pending' && phase.status !== 'running') continue
      const wasRunning = phase.status === 'running'
      const broken = wasRunning && terminal !== 'succeeded'
      phase.status = broken ? terminal : 'skipped'
      phase.startedAt = phase.startedAt ?? job.createdAt
      phase.finishedAt = now
      phase.durationMs = now - phase.startedAt
      phase.summary = phase.summary ?? (broken ? '这一步没跑完' : '没走到这一步')
    }
  }

  /** 执行器拿到的上下文。 */
  private executorContext(job: MutableJob): JobExecutorContext {
    const toolContext: ToolContext = {
      workspaceRoot: job.workspaceRoot,
      ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
      ...(job.ownerAgentId === '' ? {} : { agentId: job.ownerAgentId }),
      // 只在任务被取消时 abort：这一轮对话收尾不该把后台任务带走。
      signal: job.controller.signal,
    }
    return {
      job: this.snapshot(job),
      toolContext,
      beginStep: (index: number): void => {
        const phase = job.phases[index]
        if (phase === undefined) return
        if (phase.status !== 'pending') return
        phase.status = 'running'
        phase.startedAt = Date.now()
      },
      completeStep: (index: number, text: string): void => {
        const phase = job.phases[index]
        if (phase === undefined) return
        const now = Date.now()
        phase.status = 'succeeded'
        phase.startedAt = phase.startedAt ?? now
        phase.finishedAt = now
        phase.durationMs = now - phase.startedAt
        phase.summary = text
      },
      failStep: (index: number, text: string): void => {
        const phase = job.phases[index]
        if (phase === undefined) return
        const now = Date.now()
        phase.status = 'failed'
        phase.startedAt = phase.startedAt ?? now
        phase.finishedAt = now
        phase.durationMs = now - phase.startedAt
        phase.summary = text
      },
    }
  }

  /** 通知宿主：任务收尾了。 */
  private notify(job: MutableJob): void {
    const handler = this.options.onComplete
    if (handler === undefined) return
    const notice: JobCompletionNotice = {
      job: this.snapshot(job),
      ownerAgentId: job.ownerAgentId,
      ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
    }
    try {
      // 宿主回调可能返回 promise：它自己的失败与任务无关，接住就行——通知没送到只是
      // 主人少看一条提醒，不该把任务的状态改写掉。
      void Promise.resolve(handler(notice)).catch((error: unknown) => {
        this.callbackError = messageOf(error)
      })
    } catch (error) {
      this.callbackError = messageOf(error)
    }
  }

  /**
   * 任务类型怎么定：显式指定 → 宿主配的默认类型 → 已注册的第一个执行器。
   *
   * 最后一个兜底是给「只有一种活要干」的宿主省事：模型不写类型也能起任务。
   */
  private resolveKind(wanted: string | undefined): string {
    const explicit = wanted?.trim() ?? ''
    if (explicit.length > 0) return explicit
    const fallback = this.options.defaultKind ?? ''
    if (fallback.length > 0) return fallback
    return this.executors.keys().next().value ?? ''
  }

  /** 归属核对：agent id 必须对上，会话 id 给了也得对上。 */
  private owns(job: MutableJob, scope: JobScope): boolean {
    if (job.ownerAgentId !== (scope.agentId ?? '')) return false
    if (scope.conversationId !== undefined && job.conversationId !== scope.conversationId) return false
    return true
  }

  /** 列表过滤。 */
  private matches(job: MutableJob, filter: JobFilter): boolean {
    if (filter.agentId !== undefined && job.ownerAgentId !== filter.agentId) return false
    if (filter.conversationId !== undefined && job.conversationId !== filter.conversationId) return false
    if (filter.status !== undefined && job.status !== filter.status) return false
    return true
  }

  /** 快照：调用方拿到的是副本，不会跟着内部状态变。 */
  private snapshot(job: MutableJob): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      task: job.task,
      status: job.status,
      ownerAgentId: job.ownerAgentId,
      ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      queuedMs: job.queuedMs,
      durationMs: job.durationMs,
      ...(job.result === undefined ? {} : { result: job.result }),
      ...(job.error === undefined ? {} : { error: job.error }),
      phases: job.phases.map((phase) => {
        return {
          label: phase.label,
          status: phase.status,
          ...(phase.startedAt === undefined ? {} : { startedAt: phase.startedAt }),
          ...(phase.finishedAt === undefined ? {} : { finishedAt: phase.finishedAt }),
          durationMs: phase.durationMs,
          ...(phase.summary === undefined ? {} : { summary: phase.summary }),
        }
      }),
    }
  }
}

/** 模型看得见的四件工具的名字。 */
export const JOB_TOOL_NAMES: readonly string[] = Object.freeze([
  JOB_START_TOOL_NAME,
  JOB_LIST_TOOL_NAME,
  JOB_RESULT_TOOL_NAME,
  JOB_CANCEL_TOOL_NAME,
])
