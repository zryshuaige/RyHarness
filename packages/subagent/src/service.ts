/**
 * 子代理服务：派活、管生命周期、留记录。
 *
 * 服务是这一族里唯一有状态的部分，三件事归它管：
 *
 * 1. **派活**：模型路由、工具集、步数与时长上限都由它决定，模型只能提要求。
 * 2. **生命周期**：这一轮结束时，没跑完的子代理必须被回收——否则父对话已经收了尾，
 *    后台还在烧 token，而且没人知道它跑完了没有。
 * 3. **可观测**：每次委派留一条记录（跑了多久、用了哪些工具、什么状态），
 *    `subagent_list` 与宿主接口读的是同一份。
 * @module @ryharness/subagent/service
 */

import type { Tool, ToolContext, ToolSource } from '@ryharness/agent'
import { listTools } from '@ryharness/agent'
import type { LlmRuntime } from '@ryharness/llm'
import { messageOf, summary } from './format.ts'
import { createInProcessSubagentProvider } from './in-process.ts'
import { createSubagentListTool, createSubagentTool, SUBAGENT_LIST_TOOL_NAME, SUBAGENT_TOOL_NAME } from './tools.ts'
import type {
  SubagentProvider,
  SubagentRequest,
  SubagentResult,
  SubagentRoute,
  SubagentRunFilter,
  SubagentRunRecord,
} from './types.ts'

/**
 * 委派工具的名字。
 *
 * 这两个名字永远不进子代理的工具集：子代理再起子代理，层数就没有尽头了，
 * 每一层都自带一份上下文与一套工具，几层就能把机器跑满。
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = Object.freeze([SUBAGENT_TOOL_NAME, SUBAGENT_LIST_TOOL_NAME])

/** 子代理步数上限的默认值。 */
export const DEFAULT_SUBAGENT_MAX_STEPS = 12

/** 子代理时长上限的默认值（毫秒）。 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000

/** 子代理服务的构造参数。 */
export interface SubagentServiceOptions {
  /** LLM 运行时：子代理的模型调用走它。 */
  llm: LlmRuntime
  /** 父代理的模型路由（`model` 参数缺省时用它）。 */
  route: SubagentRoute
  /** 按上下文解析父代理路由：宿主一行会话里跑多个 agent 时用。 */
  resolveRoute?: (ctx: ToolContext) => SubagentRoute
  /** 子代理可用的工具集；缺省用父代理同一份（宿主通常传工具注册表）。 */
  tools?: ToolSource
  /** 子代理工具名白名单；缺省 = 工具集里除委派工具以外的全部。 */
  childTools?: readonly string[]
  /** provider 列表；缺省 = 进程内 provider。 */
  providers?: readonly SubagentProvider[]
  /** 子代理步数上限。 */
  maxSteps?: number
  /** 子代理时长上限（毫秒）。 */
  timeoutMs?: number
  /** 子代理的系统提示词。 */
  systemPrompt?: string
}

/** 服务内部的可变记录。 */
interface MutableRun extends SubagentRunRecord {
  /** 已经结算过就不再改：超时之后 provider 可能还会晚一步返回结果。 */
  settled: boolean
}

/** 一次正在跑的委派。 */
interface RunningEntry {
  controller: AbortController
  promise: Promise<SubagentResult>
}

/**
 * 子代理服务。
 *
 * 一个实例服务一段宿主运行时：模型看得见的两件工具从这里取，委派记录也在这里。
 */
export class SubagentService {
  private readonly providers = new Map<string, SubagentProvider>()
  private readonly runs = new Map<string, MutableRun>()
  private readonly running = new Map<string, RunningEntry>()
  /** 会话 → 当前轮次号。轮次是「父对话这一轮」的编号，宿主收尾时推进。 */
  private readonly rounds = new Map<string, number>()
  /** 子代理可用的工具集；宿主挂载工具注册表晚于服务构造时用 setTools 换掉。 */
  private childSource: ToolSource | undefined
  /** 子代理工具名白名单。 */
  private childWhitelist: readonly string[] | undefined
  private sequence = 0

  /** 模型看得见的两件工具：`subagent` 与 `subagent_list`。 */
  readonly modelTools: readonly Tool[]

  constructor(private readonly options: SubagentServiceOptions) {
    const providers = options.providers ?? [
      createInProcessSubagentProvider({
        llm: options.llm,
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      }),
    ]
    for (const provider of providers) this.providers.set(provider.id, provider)
    this.childSource = options.tools
    this.childWhitelist = options.childTools
    this.modelTools = [createSubagentTool(this), createSubagentListTool(this)]
  }

  /**
   * 换掉子代理可用的工具集。
   *
   * 宿主常常先建服务、后挂工具注册表；这时子代理的工具集得跟着换一次，否则子代理
   * 手里一把工具都没有，只能干瞪眼。
   * @param source - 新的工具集。
   * @param whitelist - 新的工具名白名单；不填则沿用原来的。
   */
  setTools(source: ToolSource, whitelist?: readonly string[]): void {
    this.childSource = source
    if (whitelist !== undefined) this.childWhitelist = whitelist
  }

  /**
   * 注册一个 provider。
   *
   * 同名覆盖是允许的：宿主重载插件时拿到的是新实例，旧的那份不该继续被选中。
   * @param provider - provider 实现。
   */
  registerProvider(provider: SubagentProvider): void {
    this.providers.set(provider.id, provider)
  }

  /** 已注册的 provider。 */
  listProviders(): readonly SubagentProvider[] {
    return [...this.providers.values()]
  }

  /**
   * 派一次活。
   *
   * @param request - 任务描述与可选的模型/provider 覆盖。
   * @param ctx - 工具执行上下文（工作区、会话、取消信号）。
   * @returns 子代理的最终结果；失败与超时也在这里以可读的中文说明返回。
   */
  async delegate(request: SubagentRequest, ctx: ToolContext): Promise<SubagentResult> {
    const task = request.task.trim()
    if (task.length === 0) {
      return {
        id: '',
        text: '',
        tools: [],
        steps: 0,
        status: 'failed',
        error: '任务描述是空的：子代理拿不到要做的事。',
      }
    }
    const provider = this.pickProvider(request.provider)
    if (provider === undefined) {
      const wanted = request.provider ?? '（默认）'
      return {
        id: '',
        text: '',
        tools: [],
        steps: 0,
        status: 'failed',
        error: `没有可用的子代理 provider「${wanted}」。`,
      }
    }

    const route = this.resolveRouteOf(ctx)
    const childRoute: SubagentRoute = { provider: route.provider, model: request.model ?? route.model }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS
    const maxSteps = this.options.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS
    const id = this.nextId()
    const run: MutableRun = {
      id,
      task,
      route: childRoute,
      status: 'running',
      steps: 0,
      tools: [],
      startedAt: Date.now(),
      durationMs: 0,
      text: '',
      ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
      ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
      round: this.currentRound(ctx.conversationId),
      settled: false,
    }
    this.runs.set(id, run)

    const controller = new AbortController()
    // 父对话的取消与本轮的超时合成一个信号：两条路任一条触发，子代理都该停。
    const signal = ctx.signal === undefined ? controller.signal : AbortSignal.any([ctx.signal, controller.signal])
    let timedOut = false
    // 一个计时器管两件事：到点 abort 子代理，同时把 race 判成超时。分成两个计时器
    // 就会出现「已经判超时、信号还没发」的窗口，子代理会多跑一会儿。
    let timer: ReturnType<typeof setTimeout> | undefined

    const promise = Promise.resolve().then(() => {
      return provider.run({
        id,
        task,
        route: childRoute,
        tools: this.childSource ?? [],
        toolNames: this.childToolNames(),
        maxSteps,
        timeoutMs,
        signal,
        context: ctx,
        ...(this.options.systemPrompt === undefined ? {} : { systemPrompt: this.options.systemPrompt }),
        onProgress: (progress) => {
          // 结算之后不再改：超时先到、provider 后到的顺序很常见。
          if (run.settled) return
          run.steps = progress.steps
          run.tools = [...progress.tools]
        },
      })
    })
    // 两个 promise 都挂一个空处理器：race 已经走了之后，它们自己的拒绝不该变成
    // 未处理拒绝把进程带下去。
    promise.catch(() => {})
    // provider 晚一步回来时也走一遍结算：记录已经结算过，这一步就是空转——
    // 超时之后迟到的结果不该把「超时」改写成「成功」。
    promise.then(
      (result) => {
        this.finish(run, result)
      },
      () => {},
    )
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error(`subagent timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    timeoutPromise.catch(() => {})
    // 登记成「正在跑」：本轮收尾时要靠这张表把它们收回来。
    this.running.set(id, { controller, promise })

    let result: SubagentResult
    try {
      result = await Promise.race([promise, timeoutPromise])
    } catch (error) {
      result = timedOut
        ? {
            id,
            text: run.text,
            tools: run.tools,
            steps: run.steps,
            status: 'timeout',
            error: `子代理超时（${timeoutMs} 毫秒）：任务「${summary(task, 40)}」。可以把任务拆小一点再派一次。`,
          }
        : {
            id,
            text: run.text,
            tools: run.tools,
            steps: run.steps,
            status: 'failed',
            error: `子代理失败：${messageOf(error)}`,
          }
    }
    if (timer !== undefined) clearTimeout(timer)
    this.finish(run, result)
    return result
  }

  /**
   * 查委派记录。
   * @param filter - 会话、轮次与状态的条件。
   * @returns 记录的快照（按开始顺序）。
   */
  listRuns(filter: SubagentRunFilter = {}): readonly SubagentRunRecord[] {
    const current = filter.round === 'current' ? this.currentRound(filter.conversationId) : undefined
    const rows: MutableRun[] = []
    for (const run of this.runs.values()) {
      if (filter.conversationId !== undefined && run.conversationId !== filter.conversationId) continue
      if (current !== undefined && run.round !== current) continue
      if (filter.status !== undefined && run.status !== filter.status) continue
      rows.push(run)
    }
    return rows.map((run) => this.snapshot(run))
  }

  /**
   * 按 id 查一条委派记录。
   * @param id - 子代理 id。
   * @returns 记录的快照；没有则 undefined。
   */
  getRun(id: string): SubagentRunRecord | undefined {
    const run = this.runs.get(id)
    return run === undefined ? undefined : this.snapshot(run)
  }

  /**
   * 父对话这一轮结束：回收没跑完的子代理，并把轮次推进到下一轮。
   *
   * 宿主在每轮收尾时调它。回收是必须的：这一轮都结束了，后台还在跑的子代理既没人
   * 等它的结果，也没人知道它什么时候停。
   * @param conversationId - 会话 id；不填则回收所有会话的。
   */
  async endRound(conversationId?: string): Promise<void> {
    const pending = [...this.running.entries()].filter(([id]) => {
      const run = this.runs.get(id)
      if (run === undefined) return false
      if (conversationId === undefined) return true
      return run.conversationId === conversationId
    })
    for (const [, entry] of pending) entry.controller.abort()
    await Promise.allSettled(pending.map(([, entry]) => entry.promise))
    const key = this.roundKey(conversationId)
    this.rounds.set(key, this.currentRound(conversationId) + 1)
  }

  /**
   * 全部回收：服务下线时用。
   */
  async dispose(): Promise<void> {
    await this.endRound()
  }

  /** 子代理的工具名白名单：工具集去掉委派工具。 */
  private childToolNames(): readonly string[] {
    const names =
      this.childWhitelist ??
      (this.childSource === undefined ? [] : listTools(this.childSource).map((tool) => tool.name))
    return names.filter((name) => !DELEGATION_TOOL_NAMES.includes(name))
  }

  /** 按 id 或默认取 provider。 */
  private pickProvider(wanted: string | undefined): SubagentProvider | undefined {
    if (wanted !== undefined) return this.providers.get(wanted)
    return this.providers.values().next().value
  }

  /** 父代理的模型路由。 */
  private resolveRouteOf(ctx: ToolContext): SubagentRoute {
    return this.options.resolveRoute?.(ctx) ?? this.options.route
  }

  /** 当前轮次号；第一次用到时开第 1 轮。 */
  private currentRound(conversationId: string | undefined): number {
    const key = this.roundKey(conversationId)
    const current = this.rounds.get(key)
    if (current !== undefined) return current
    this.rounds.set(key, 1)
    return 1
  }

  /** 会话的轮次键：没有会话 id 的算同一组。 */
  private roundKey(conversationId: string | undefined): string {
    return conversationId ?? ''
  }

  /** 下一个子代理 id。 */
  private nextId(): string {
    this.sequence += 1
    return `sub-${this.sequence}`
  }

  /** 把结果落到记录上；只结算一次。 */
  private finish(run: MutableRun, result: SubagentResult): void {
    if (run.settled) return
    run.settled = true
    run.status = result.status
    run.steps = result.steps
    run.tools = [...result.tools]
    run.text = result.text
    if (result.error !== undefined) run.error = result.error
    run.finishedAt = Date.now()
    run.durationMs = run.finishedAt - run.startedAt
    this.running.delete(run.id)
  }

  /** 记录的快照：调用方拿到的是副本，不会跟着内部状态变。 */
  private snapshot(run: MutableRun): SubagentRunRecord {
    return {
      id: run.id,
      task: run.task,
      route: { ...run.route },
      status: run.status,
      steps: run.steps,
      tools: [...run.tools],
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      durationMs: run.durationMs,
      text: run.text,
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
      round: run.round,
    }
  }
}
