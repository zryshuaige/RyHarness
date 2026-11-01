/**
 * computer-use 的错误类型。
 *
 * 错误带**稳定的机器可路由码**：宿主与上层逻辑按码分流，不去匹配错误文案
 * （文案会改，码不会）。这与本仓 terminal / browser-use 两族是同一套思路。
 * @module @ryharness/computer-use/errors
 */

/** 错误的稳定分类。 */
export type ComputerUseErrorCode =
  /** 没装桌面驱动：这个包不自带桌面自动化，宿主得自己接一个。 */
  | 'NO_DRIVER'
  /** 会话不存在，或者不属于这个 owner（两者对外是同一句，不泄露 id 是否存在）。 */
  | 'NO_SESSION'
  /** 会话已经关了。 */
  | 'SESSION_CLOSED'
  /** 这个 owner 的会话数超过上限。 */
  | 'SESSION_LIMIT'
  /** 单步操作超过时限。 */
  | 'TIMEOUT'
  /** 驱动内部出错（截图失败、坐标越界等）。 */
  | 'DRIVER_FAILED'
  /** 高危动作需要人点头，但没人点头（没接确认回调，或人拒绝了）。 */
  | 'APPROVAL_REQUIRED'
  /** 参数不对。 */
  | 'INVALID_ARGUMENT'
  /** 截图被策略挡住了。 */
  | 'SCREENSHOT_NOT_ALLOWED'
  /** 清理没成功：驱动可能还占着资源。 */
  | 'CLEANUP_FAILED'

/** computer-use 的错误。 */
export class ComputerUseError extends Error {
  /** 稳定的错误分类。 */
  readonly code: ComputerUseErrorCode

  constructor(code: ComputerUseErrorCode, message: string) {
    super(message)
    this.name = 'ComputerUseError'
    this.code = code
  }
}

/**
 * 是不是某个错误码的 computer-use 错误。
 * @param error - 待判定的错误。
 * @param code - 期望的错误码。
 * @returns 匹配则 true。
 */
export function isComputerUseError(error: unknown, code: ComputerUseErrorCode): boolean {
  return error instanceof ComputerUseError && error.code === code
}
