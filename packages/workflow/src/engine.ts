/**
 * 编排引擎：跑一段模型写的编排脚本，脚本把活派给子代理，最后带回一个值。
 *
 * 引擎只做四件事：
 * 1. **准备绑定**：脚本里能调的四个函数——派一个、派一批、等一个、等一批。
 * 2. **限流**：一次编排最多派几个子代理（默认 8）。模型一次派 100 个是常事，
 *    不限的话一屏就把机器吃满了。
 * 3. **兜住失败**：子代理挂了、超时了，脚本能接住就接住，接不住就变成这次编排的失败。
 * 4. **收摊**：编排结束（或超时）时，没被脚本收走的子代理一律收回来。
 *
 * 脚本本身跑在 PTC 的 Node 运行时里（{@link PtcRuntime}）——宿主换运行时，引擎不用改。
 * @module @ryharness/workflow/engine
 */

import { type PtcBinding, PtcBindingError, type PtcFilePolicy, type PtcRuntime } from '@ryharness/ptc'
import type {
  WorkflowAgentExecutor,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowAgentRun,
  WorkflowRequest,
  WorkflowResult,
} from './types.ts'

/** 一次编排的缺省时限（毫秒）。 */
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 60_000

/** 一次编排的缺省扇出上限。 */
export const DEFAULT_WORKFLOW_MAX_FAN_OUT = 8

/** 引擎的构造参数。 */
export interface WorkflowEngineOptions {
  /** 跑脚本的运行时（一般是 PTC 的 Node 后端）。 */
  runtime: PtcRuntime
  /** 子代理执行器：脚本派出去的活由它跑。 */
  executor: WorkflowAgentExecutor
  /** 缺省时限（毫秒）。 */
  defaultTimeoutMs?: number
  /** 缺省扇出上限。 */
  maxFanOut?: number
  /** 脚本能读写的路径（缺省用运行时的默认策略）。 */
  filePolicy?: PtcFilePolicy
}

/** 一次编排过程中的可变状态。 */
interface WorkflowRunState {
  /** 派出去的子代理（按派出顺序）。 */
  agents: WorkflowAgentRun[]
  /** 子代理 id → 它跑完的 promise。 */
  pending: Map<string, Promise<WorkflowAgentResult>>
  /** 已经派出去几个。 */
  spawned: number
  /** 这次编排的扇出上限。 */
  maxFanOut: number
}

/**
 * 编排引擎。
 *
 * 引擎自己不持有长生命周期的东西（脚本每次现跑），所以它可以被复用一个实例。
 */
export class WorkflowEngine {
  /** 引擎收摊之后不再接活。 */
  private closed = false

  constructor(private readonly options: WorkflowEngineOptions) {}

  /**
   * 跑一段编排脚本。
   * @param request - 脚本、时限、扇出上限、文件策略与调用上下文。
   * @returns 编排结果（失败也是结果）。
   */
  async run(request: WorkflowRequest): Promise<WorkflowResult> {
    const started = Date.now()
    if (this.closed) {
      return {
        ok: false,
        output: [],
        failure: { kind: 'runtime', message: '编排引擎已经关掉了。' },
        agents: [],
        durationMs: Date.now() - started,
      }
    }
    const script = typeof request.script === 'string' ? request.script : ''
    if (script.trim().length === 0) {
      return {
        ok: false,
        output: [],
        failure: { kind: 'syntax', message: '编排脚本是空的：没有脚本就没法编排。' },
        agents: [],
        durationMs: Date.now() - started,
      }
    }
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS
    const state: WorkflowRunState = {
      agents: [],
      pending: new Map(),
      spawned: 0,
      maxFanOut: request.maxFanOut ?? this.options.maxFanOut ?? DEFAULT_WORKFLOW_MAX_FAN_OUT,
    }
    const controller = new AbortController()
    try {
      const result = await this.options.runtime.run({
        program: script,
        mode: 'script',
        bindings: this.createBindings(state, request, controller.signal),
        filePolicy: request.filePolicy ?? this.options.filePolicy,
        timeoutMs,
        signal: controller.signal,
        persistence: 'none',
      })
      return {
        ok: result.ok,
        output: result.output,
        ...(result.value === undefined ? {} : { value: result.value }),
        ...(result.failure === undefined ? {} : { failure: result.failure }),
        agents: state.agents,
        durationMs: Date.now() - started,
      }
    } finally {
      // 编排收摊了：脚本没收回来的子代理别在后台继续烧 token。
      controller.abort()
    }
  }

  /** 引擎收摊：之后不再接活。 */
  async dispose(): Promise<void> {
    this.closed = true
  }

  /** 脚本里能调的四个绑定。 */
  private createBindings(state: WorkflowRunState, request: WorkflowRequest, signal: AbortSignal): PtcBinding[] {
    return [
      {
        name: 'spawnAgent',
        description: '派一个子代理去做一件事（子代理有自己的上下文），返回它的 id。要等结果就 awaitAgent(id)。',
        fn: (args) => {
          return this.spawn(state, args, request, signal)
        },
      },
      {
        name: 'spawnAgents',
        description: '一次派多个子代理（并行跑），传入任务数组，返回 id 数组，顺序与任务一致。',
        fn: (args) => {
          return this.spawnMany(state, args, request, signal)
        },
      },
      {
        name: 'awaitAgent',
        description: '等一个子代理跑完，返回它的结果文本（失败会抛错，脚本可以 try/catch 接住）。',
        fn: (args) => {
          return this.awaitAgent(state, args)
        },
      },
      {
        name: 'awaitAgents',
        description: '等一批子代理跑完，传入 id 数组，按传入顺序返回结果文本数组。',
        fn: (args) => {
          return this.awaitAgents(state, args)
        },
      },
    ]
  }

  /** 派一个子代理出去（立刻开跑，不等它）。 */
  private spawn(
    state: WorkflowRunState,
    args: readonly unknown[],
    request: WorkflowRequest,
    signal: AbortSignal,
  ): string {
    const task = readText(args[0], 'spawnAgent', '任务描述')
    const label = readOptionalText(args[1], 'spawnAgent')
    state.spawned += 1
    if (state.spawned > state.maxFanOut) {
      throw new PtcBindingError(
        `一次最多派 ${state.maxFanOut} 个子代理（已经派了 ${state.spawned - 1} 个）。可以把任务合并一下再派。`,
        'limit',
      )
    }
    const id = `wf-${state.spawned}`
    const record: WorkflowAgentRun = {
      id,
      task,
      status: 'running',
      durationMs: 0,
      ...(label === undefined ? {} : { label }),
    }
    state.agents.push(record)
    const startedAt = Date.now()
    const agentRequest: WorkflowAgentRequest = {
      id,
      task,
      signal,
      ...(label === undefined ? {} : { label }),
      ...(request.context === undefined ? {} : { context: request.context }),
    }
    const promise = this.options.executor.run(agentRequest).then(
      (result) => {
        record.status = result.status
        record.text = result.text
        if (result.error !== undefined) record.error = result.error
        record.durationMs = Date.now() - startedAt
        return result
      },
      (error: unknown) => {
        record.status = 'failed'
        record.error = messageOf(error)
        record.durationMs = Date.now() - startedAt
        throw error
      },
    )
    // 脚本没 await 的那次委派也可能失败：挂一个空处理器，别让它变成没人接住的拒绝。
    promise.catch(() => {})
    state.pending.set(id, promise)
    return id
  }

  /** 一次派多个（并行跑，id 按传入顺序）。 */
  private spawnMany(
    state: WorkflowRunState,
    args: readonly unknown[],
    request: WorkflowRequest,
    signal: AbortSignal,
  ): string[] {
    const tasks = args[0]
    if (!Array.isArray(tasks)) {
      throw new PtcBindingError('spawnAgents 第一个参数得是任务数组（字符串数组）。', 'runtime')
    }
    const ids: string[] = []
    for (const task of tasks) {
      if (typeof task !== 'string' || task.trim().length === 0) {
        throw new PtcBindingError('spawnAgents 的每个任务都得是非空的字符串。', 'runtime')
      }
      ids.push(this.spawn(state, [task], request, signal))
    }
    return ids
  }

  /** 等一个子代理跑完。 */
  private async awaitAgent(state: WorkflowRunState, args: readonly unknown[]): Promise<string> {
    const id = readText(args[0], 'awaitAgent', '子代理 id')
    const promise = state.pending.get(id)
    if (promise === undefined) {
      throw new PtcBindingError(`没有这个子代理：${id}（id 是 spawnAgent / spawnAgents 给的）。`, 'runtime')
    }
    const result = await promise
    if (result.status !== 'completed') {
      throw new PtcBindingError(result.error ?? `子代理 ${id} 没有跑完（${result.status}）。`, 'runtime')
    }
    return result.text
  }

  /** 等一批子代理跑完（结果按传入顺序）。 */
  private async awaitAgents(state: WorkflowRunState, args: readonly unknown[]): Promise<string[]> {
    const ids = args[0]
    if (!Array.isArray(ids)) {
      throw new PtcBindingError('awaitAgents 第一个参数得是 id 数组。', 'runtime')
    }
    const texts: string[] = []
    for (const id of ids) {
      if (typeof id !== 'string') {
        throw new PtcBindingError('awaitAgents 的每个 id 都得是字符串。', 'runtime')
      }
      texts.push(await this.awaitAgent(state, [id]))
    }
    return texts
  }
}

/** 取一个必填的字符串参数。 */
function readText(value: unknown, bindingName: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PtcBindingError(`${bindingName} 的${what}得是非空的字符串。`, 'runtime')
  }
  return value.trim()
}

/** 取一个可选的字符串参数。 */
function readOptionalText(value: unknown, bindingName: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new PtcBindingError(`${bindingName} 的标签得是字符串。`, 'runtime')
  }
  return value.trim().length === 0 ? undefined : value.trim()
}

/** 错误的一句话说明。 */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
