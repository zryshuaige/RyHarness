/**
 * 运行期取消的错误类型。
 *
 * 调用方通过 {@link AgentRunOptions.signal}（或 ToolContext.signal）取消一轮
 * 运行时，循环不再发起新的模型调用、不再执行后续工具，并以本错误结束，
 * 让上层（server 的取消接口 / 群聊调度器）能把"被取消"与"模型报错"区分开。
 * @module @ryagent/agent/aborted
 */

import { HarnessError } from '@ryagent/llm'

/** 取消的稳定错误码（与 LLM 侧 aborted finish 的 code 对齐）。 */
export const ABORTED_CODE = 'ABORTED'

/** 一轮运行被调用方取消。code 恒为 {@link ABORTED_CODE}。 */
export class AbortedError extends HarnessError {
  constructor(message = 'agent run aborted', options?: ErrorOptions) {
    super(message, ABORTED_CODE, options)
  }
}

/** 把某个 signal 的取消原因包装为 {@link AbortedError}。 */
export function abortedErrorOf(signal: AbortSignal): AbortedError {
  const reason: unknown = signal.reason
  return new AbortedError('agent run aborted', reason === undefined ? undefined : { cause: reason })
}

/** 取消即抛出，供循环在每个可中断边界调用。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw abortedErrorOf(signal)
  }
}

/** 任意 thrown value 是否为 {@link AbortedError}。 */
export function isAbortedError(value: unknown): value is AbortedError {
  return value instanceof AbortedError
}
