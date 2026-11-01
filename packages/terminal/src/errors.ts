/**
 * 终端会话的错误类型。
 *
 * 错误带**稳定的机器可路由码**：宿主与上层逻辑按码分流，不去匹配错误文案（文案会
 * 改，码不会）。这与上游 dsh 的 `NO_BACKEND` / `NO_SESSION` / `FOREIGN_SESSION` 一族
 * 是同一套思路。
 * @module @ryharness/terminal/errors
 */

/** 错误的稳定分类。 */
export type TerminalErrorCode =
  /** 要用的后端类型没注册。 */
  | 'NO_BACKEND'
  /** 会话 id 不存在。 */
  | 'NO_SESSION'
  /** 会话存在，但不属于这个 owner。 */
  | 'FOREIGN_SESSION'
  /** 会话已经关了。 */
  | 'SESSION_CLOSED'
  /** 同一个会话上已经有一次发送在进行。 */
  | 'SEND_ACTIVE'
  /** 等超过了时限。 */
  | 'TIMEOUT'
  /** 后端起会话失败（就绪探测没过等）。 */
  | 'BACKEND_FAILED'
  /** 清理没成功：进程可能还活着。 */
  | 'CLEANUP_FAILED'

/** 终端会话的错误。 */
export class TerminalError extends Error {
  /** 稳定的错误分类。 */
  readonly code: TerminalErrorCode

  constructor(code: TerminalErrorCode, message: string) {
    super(message)
    this.name = 'TerminalError'
    this.code = code
  }
}

/**
 * 是不是某个错误码的终端错误。
 * @param error - 待判定的错误。
 * @param code - 期望的错误码。
 * @returns 匹配则 true。
 */
export function isTerminalError(error: unknown, code: TerminalErrorCode): boolean {
  return error instanceof TerminalError && error.code === code
}
