/**
 * 进程外 SDK 的机器码。
 *
 * SDK 这一层最需要说清楚的是「进程没了」——它和「请求超时」「请求被取消」是
 * 三件不同的事，调用方要区别对待：进程没了得重新起一个，超时可以重试，取消
 * 就不用管了。
 * @module @ryharness/sdk/errors
 */

import { RemoteError } from '@ryharness/typert-protocol'

declare module '@ryharness/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 子进程退出了（正常退出或崩了），请求没能完成。 */
    'sdk/process-exit': { readonly code: number | null; readonly signal: string | null }
    /** 子进程根本没起来。 */
    'sdk/spawn-failed': { readonly command: string }
  }
}

/**
 * 子进程退出的失败。
 * @param code - 退出码；被信号打死时是 null。
 * @param signal - 结束它的信号；正常退出时是 null。
 * @returns 带机器码的失败。
 */
export function processExitFailure(code: number | null, signal: string | null): RemoteError<'sdk/process-exit'> {
  const how = signal === null ? `退出码 ${code ?? '未知'}` : `被 ${signal} 结束`
  return new RemoteError('sdk/process-exit', `子进程已经${how}`, { code, signal })
}

/**
 * 子进程没起来的失败。
 * @param command - 启动命令。
 * @param cause - 原始异常。
 * @returns 带机器码的失败。
 */
export function spawnFailedFailure(command: string, cause?: unknown): RemoteError<'sdk/spawn-failed'> {
  return new RemoteError('sdk/spawn-failed', `子进程起不来：${command}`, { command }, { cause })
}
