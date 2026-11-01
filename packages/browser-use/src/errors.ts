/**
 * browser-use 的错误类型。
 *
 * 错误带**稳定的机器可路由码**：宿主与上层逻辑按码分流，不去匹配错误文案（文案会
 * 改，码不会）。这与本仓 terminal 一族的 `NO_BACKEND` / `NO_SESSION` /
 * `FOREIGN_SESSION` 是同一套思路。
 * @module @ryharness/browser-use/errors
 */

/** 错误的稳定分类。 */
export type BrowserUseErrorCode =
  /** 没装浏览器驱动：这个包不自带浏览器，宿主得自己接一个。 */
  | 'NO_DRIVER'
  /** 会话不存在，或者不属于这个 owner（两者对外是同一句，不泄露 id 是否存在）。 */
  | 'NO_SESSION'
  /** 会话已经关了。 */
  | 'SESSION_CLOSED'
  /** 标签页数超过上限。 */
  | 'TAB_LIMIT'
  /** 这个 owner 的会话数超过上限。 */
  | 'SESSION_LIMIT'
  /** 单步操作超过时限。 */
  | 'TIMEOUT'
  /** 驱动内部出错（页面打不开、元素找不到等）。 */
  | 'DRIVER_FAILED'
  /** 地址不合法或协议不被允许。 */
  | 'UNSAFE_URL'
  /** 地址指向本机或内网。 */
  | 'PRIVATE_ADDRESS'
  /** 这个动作是危险动作，当前策略没有放行。 */
  | 'ACTION_NOT_ALLOWED'
  /** 驱动不支持这个动作（比如它不会提交表单）。 */
  | 'UNSUPPORTED_ACTION'
  /** 参数不对。 */
  | 'INVALID_ARGUMENT'
  /** 清理没成功：标签页可能还开着。 */
  | 'CLEANUP_FAILED'

/** browser-use 的错误。 */
export class BrowserUseError extends Error {
  /** 稳定的错误分类。 */
  readonly code: BrowserUseErrorCode

  constructor(code: BrowserUseErrorCode, message: string) {
    super(message)
    this.name = 'BrowserUseError'
    this.code = code
  }
}

/**
 * 是不是某个错误码的 browser-use 错误。
 * @param error - 待判定的错误。
 * @param code - 期望的错误码。
 * @returns 匹配则 true。
 */
export function isBrowserUseError(error: unknown, code: BrowserUseErrorCode): boolean {
  return error instanceof BrowserUseError && error.code === code
}
