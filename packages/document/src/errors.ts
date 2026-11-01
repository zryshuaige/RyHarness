/**
 * 文档转换的错误类型。
 *
 * 错误带**稳定的机器码**：宿主按码分流（比如 `ENGINE_UNAVAILABLE` 该提示装引擎，
 * `NOT_AUTHORIZED` 该提示补授权，而不是都显示成「转换失败」）。
 *
 * 最要紧的两个：
 * - `ENGINE_UNAVAILABLE`：本机没装转换引擎。文案要说清**装什么**。
 * - `NOT_AUTHORIZED`：调用方没显式授权。这一步不做任何转换——没授权的文件连碰都不碰。
 * @module @ryharness/document/errors
 */

/** 错误的稳定分类。 */
export type DocumentErrorCode =
  /** 类型不在白名单里。 */
  | 'UNSUPPORTED_TYPE'
  /** 调用方没有显式授权。 */
  | 'NOT_AUTHORIZED'
  /** 输入太大。 */
  | 'INPUT_TOO_LARGE'
  /** 页数超上限。 */
  | 'PAGE_LIMIT_EXCEEDED'
  /** 本机没装转换引擎。 */
  | 'ENGINE_UNAVAILABLE'
  /** 转换超时。 */
  | 'TIMEOUT'
  /** 被取消。 */
  | 'CANCELLED'
  /** 产物目录不可用（在临时目录里，或压根没给）。 */
  | 'OUTPUT_DIR_INVALID'
  /** 转换失败（转换器自己报的错，或返回的不是 PDF）。 */
  | 'CONVERSION_FAILED'
  /** 缓存写入/读取失败。 */
  | 'CACHE_FAILED'
  /** 入参不合法（空内容之类）。 */
  | 'INVALID_INPUT'

/** 文档转换的错误。 */
export class DocumentError extends Error {
  /** 稳定的错误分类。 */
  readonly code: DocumentErrorCode

  constructor(code: DocumentErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocumentError'
    this.code = code
  }
}

/**
 * 是不是某个错误码的文档错误。
 *
 * 它是类型守卫：判完之后可以直接读 `error.code`。
 * @param error - 待判定的错误。
 * @param code - 期望的错误码；不给就只查类型。
 * @returns 匹配则 true。
 */
export function isDocumentError(error: unknown, code?: DocumentErrorCode): error is DocumentError {
  if (!(error instanceof DocumentError)) return false
  return code === undefined || error.code === code
}
