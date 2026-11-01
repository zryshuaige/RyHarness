/**
 * Node 后端：在**独立子进程**里跑模型写的程序。
 *
 * 为什么不 eval：宿主进程里装着助理的会话、密钥、记忆与别的会话的状态。模型写的代码
 * 没有理由碰到它们，`eval` 一次就等于把这些东西全都递过去了。所以这里起一个干净的
 * 子进程，程序在那里面跑，跑完只把「打印、返回值、失败原因」送回来。
 *
 * 子进程里跑的是本包自带的宿主脚本（`child.mjs`）：它按模式执行源码，程序跑在
 * `node:vm` 造出来的上下文里，那个上下文里**只有**宿主显式放进去的东西——绑定与
 * console。没有 `process`、没有 `require`、没有 `fs`。
 *
 * 绑定**不跨进程传函数句柄**：传过去的只有名字与说明，程序真的调用时，子进程回头问
 * 宿主，宿主执行完再把结果送回去。文件策略就在这条回路上执行——程序想读工作区外的
 * 文件，宿主那边直接拒掉。
 * @module @ryharness/ptc/node
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileBindings } from './bindings.ts'
import { resolveFilePolicy } from './policy.ts'
import { type ChildOutcome, PtcSession } from './session.ts'
import {
  isPtcMode,
  type PtcBinding,
  type PtcFailureKind,
  type PtcFilePolicy,
  type PtcMode,
  type PtcRequest,
  type PtcResult,
  type PtcRuntime,
} from './types.ts'

/** 缺省超时（毫秒）：程序跑超过这么久就被终止。 */
export const DEFAULT_PTC_TIMEOUT_MS = 30_000

/**
 * 子进程脚本的位置。
 *
 * 放在包根目录（不在 `src/` 里）：源码态下它在 `packages/ptc/child.mjs`，构建产物
 * 在 `packages/ptc/lib/index.js`——两处都差一层，`../child.mjs` 一次写对。
 *
 * **现算而不是模块加载时就算**：vitest 的 jsdom 环境里 `import.meta.url` 是 http://
 * 而不是 file://，模块一被 import 就会炸——而那个环境里没人要跑模型写的程序。
 * 真要跑的时候再算，炸也只炸在真跑的那一刻。
 */
let childScriptPath: string | undefined

/** 子进程脚本的绝对路径（首次用到时算，之后复用）。 */
function childScript(): string {
  if (childScriptPath !== undefined) return childScriptPath
  const dir = import.meta.dirname
  childScriptPath =
    typeof dir === 'string' && dir.length > 0
      ? resolve(dir, '..', 'child.mjs')
      : fileURLToPath(new URL('../child.mjs', import.meta.url))
  return childScriptPath
}

/** 子进程继承的环境变量：只留跑 node 需要的，不把宿主的密钥递过去。 */
const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']

/** Node 后端的构造参数。 */
export interface NodePtcRuntimeOptions {
  /** 缺省超时（毫秒）。 */
  defaultTimeoutMs?: number
  /** 缺省文件策略：请求没给时用它。 */
  filePolicy?: PtcFilePolicy
  /** node 可执行文件路径（测试与特殊部署用）。 */
  nodePath?: string
}

/**
 * Node 版 PTC 运行时。
 *
 * 一次 {@link run} 就是一个请求：程序跑完回来一份结果，**失败也是结果**——语法错、
 * 运行时抛错、超时都变成 `failure` 字段里的信息，宿主拿着它去跟模型解释。
 */
export class NodePtcRuntime implements PtcRuntime {
  /** owner → 保留状态的会话。 */
  private readonly sessions = new Map<string, PtcSession>()

  /** 执行 id 自增序号。 */
  private sequence = 0

  constructor(private readonly options: NodePtcRuntimeOptions = {}) {}

  /**
   * 跑一段程序。
   * @param request - 程序、模式、绑定、文件策略与时限。
   * @returns 执行结果（失败也在结果里）。
   */
  async run(request: PtcRequest): Promise<PtcResult> {
    const started = Date.now()
    if (!isPtcMode(request.mode)) {
      return failureResult('runtime', `未知的执行模式：${String(request.mode)}`, started)
    }
    const program = typeof request.program === 'string' ? request.program : ''
    if (program.trim().length === 0) {
      return failureResult('syntax', '程序是空的：没有可执行的内容。', started)
    }
    const policy = resolveFilePolicy(request.filePolicy ?? this.options.filePolicy, process.cwd())
    const bindings = [...(request.bindings ?? []), ...createFileBindings(policy)]
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_PTC_TIMEOUT_MS
    const persistence = request.persistence ?? (request.mode === 'repl' ? 'repl' : 'none')
    const owner = request.owner ?? 'default'

    if (persistence === 'none') {
      const session = this.spawn(request.mode)
      try {
        return await this.execute(session, request, bindings, timeoutMs, started)
      } finally {
        session.close()
      }
    }
    const session = this.sessionFor(owner, request.mode)
    return this.execute(session, request, bindings, timeoutMs, started)
  }

  /**
   * 释放某个 owner 的保留进程（它留下的状态一并没了）。
   * @param owner - 状态归属者。
   */
  async release(owner: string): Promise<void> {
    const session = this.sessions.get(owner)
    if (session === undefined) return
    this.sessions.delete(owner)
    session.close()
  }

  /** 结束所有保留进程。 */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
  }

  /** 起一个子进程会话。 */
  private spawn(mode: PtcMode): PtcSession {
    const child = spawn(this.options.nodePath ?? process.execPath, [childScript()], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: scrubbedEnv(),
      windowsHide: true,
    })
    return new PtcSession(child, mode, (session) => {
      this.forget(session)
    })
  }

  /** 拿到（或建起）某个 owner 的保留会话。 */
  private sessionFor(owner: string, mode: PtcMode): PtcSession {
    const existing = this.sessions.get(owner)
    // 会话已经结束（超时、被释放、子进程自己退了）就换一个：往死掉的进程发请求，
    // 只会换来一句「子进程提前退出」。
    if (existing !== undefined && !existing.closed && existing.mode === mode) return existing
    if (existing !== undefined) {
      this.sessions.delete(owner)
      existing.close()
    }
    const session = this.spawn(mode)
    this.sessions.set(owner, session)
    return session
  }

  /** 会话死了：从表里摘掉。 */
  private forget(session: PtcSession): void {
    for (const [owner, value] of this.sessions) {
      if (value === session) this.sessions.delete(owner)
    }
  }

  /** 在会话上跑一次程序，并把结果与失败整理成一份结果。 */
  private async execute(
    session: PtcSession,
    request: PtcRequest,
    bindings: readonly PtcBinding[],
    timeoutMs: number,
    started: number,
  ): Promise<PtcResult> {
    return session.enqueue(async () => {
      session.bindings = new Map(
        bindings.map((binding) => {
          return [binding.name, binding]
        }),
      )
      this.sequence += 1
      const id = `run-${this.sequence}`
      const message = await new Promise<ChildOutcome>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: ChildOutcome): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          session.forget(id)
          request.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const onAbort = (): void => {
          finish({ type: 'failure', id, output: [], kind: 'aborted', message: '这次执行被取消了。' })
          session.close()
        }
        timer = setTimeout(() => {
          finish({
            type: 'failure',
            id,
            output: [],
            kind: 'timeout',
            message: `程序跑超时了（${timeoutMs} 毫秒），子进程已经被终止。`,
          })
          session.close()
        }, timeoutMs)
        session.expect(id, finish)
        if (request.signal?.aborted === true) {
          onAbort()
          return
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        session.start(id, request.mode, request.program, bindings)
      })
      return toResult(message, Date.now() - started)
    })
  }
}

/** 把子进程的消息整理成一份结果。 */
function toResult(message: ChildOutcome, durationMs: number): PtcResult {
  if (message.type === 'result') {
    return {
      ok: true,
      output: message.output,
      ...(message.value === undefined ? {} : { value: message.value }),
      durationMs,
    }
  }
  return {
    ok: false,
    output: message.output,
    failure: {
      kind: message.kind,
      message: message.message,
      ...(message.detail === undefined ? {} : { detail: message.detail }),
    },
    durationMs,
  }
}

/** 一个失败结果。 */
function failureResult(kind: PtcFailureKind, message: string, started: number): PtcResult {
  return { ok: false, output: [], failure: { kind, message }, durationMs: Date.now() - started }
}

/** 子进程只继承跑 node 需要的那几个环境变量，别把宿主的密钥递过去。 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
