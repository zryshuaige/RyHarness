/**
 * 后台任务与计划模式用例共用的替身与脚手架。
 *
 * 单独放一个文件是因为几份用例要共用同一套替身：复制一遍既长，又会在重复代码门禁
 * 上被记一笔。
 */

import type { ToolContext } from '@ryharness/agent'
import type { JobExecutor, JobExecutorContext } from '../src/index.ts'

/** 一个由测试掌控节奏的 promise。 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** 造一个由测试掌控节奏的 promise。 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 等一个 promise，但取消信号一来就立刻退出。
 *
 * 执行器必须理会取消信号——不然任务取消了它还在跑，关机也得等它。
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('任务被取消了'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 一个由测试放行的执行器。
 *
 * 跑起来之后就在那儿等着，直到用例放行——这样「还在跑」这件事是可控的，不靠 sleep
 * 去赌时序。取消信号一来它就退出（执行器该有的样子）。
 */
export class GatedExecutor implements JobExecutor {
  readonly kind: string
  /** 每次开跑记下的上下文：用例靠它查 signal 有没有被 abort。 */
  readonly contexts: JobExecutorContext[] = []
  /** 每次开跑记下的放行闸。 */
  readonly gates: Deferred<void>[] = []

  constructor(kind = 'gated') {
    this.kind = kind
  }

  async run(ctx: JobExecutorContext): Promise<string> {
    this.contexts.push(ctx)
    ctx.beginStep(0)
    const gate = deferred<void>()
    this.gates.push(gate)
    await untilAborted(gate.promise, ctx.toolContext.signal)
    ctx.completeStep(0, '放行了')
    return '放行了'
  }

  /** 放行第 n 次开跑。 */
  release(index = 0): void {
    const gate = this.gates[index]
    if (gate === undefined) throw new Error('这个执行器还没开跑过')
    gate.resolve()
  }
}

/** 一个跑完就返回固定文字的执行器。 */
export function fixedExecutor(kind: string, text: string): JobExecutor {
  return {
    kind,
    async run(ctx: JobExecutorContext): Promise<string> {
      ctx.beginStep(0)
      ctx.completeStep(0, text)
      return text
    },
  }
}

/** 一个跑起来就抛错的执行器。 */
export function failingExecutor(kind: string, reason: string): JobExecutor {
  return {
    kind,
    async run(ctx: JobExecutorContext): Promise<string> {
      ctx.beginStep(0)
      ctx.failStep(0, reason)
      throw new Error(reason)
    },
  }
}

/** 一份工具上下文。 */
export function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: 'F:/workspace', ...overrides }
}

/** 等一个条件成立：断言得等它真的发生，不能靠 sleep 赌时序。 */
export async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error('等待条件超时')
}
