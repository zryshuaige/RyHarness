/**
 * 远程操作的错误类型。
 *
 * 错误带**稳定的机器码**：宿主按码分流，不去匹配错误文案（文案会改，码不会）。
 *
 * 四种最要紧的失败分得清清楚楚，因为它们的处置方式完全不同：
 * - `CONNECT_FAILED`：连不上（网络、路由、DNS）。
 * - `AUTH_FAILED`：连上了但过不去认证（密钥不对、密码错、账号被禁）。
 * - `COMMAND_NOT_FOUND`：远端没有这个命令。
 * - `REMOTE_FAILED`：命令跑了，但退出码非零。
 *
 * 另有一个容易混淆、必须单独分开的：`CONNECTION_LOST`（连接中途断了）。断了的时候
 * 报「命令没输出」是误导——真相是**没跑完**，所以它有自己的码。
 * @module @ryharness/ssh/errors
 */

/** 错误的稳定分类。 */
export type SshErrorCode =
  /** 连不上：DNS、网络、端口不通。 */
  | 'CONNECT_FAILED'
  /** 认证没过。 */
  | 'AUTH_FAILED'
  /** 远端没有这个命令。 */
  | 'COMMAND_NOT_FOUND'
  /** 远端命令跑了但退出码非零。 */
  | 'REMOTE_FAILED'
  /** 远端路径不存在。 */
  | 'REMOTE_NOT_FOUND'
  /** 连接中途断了（远端把连接掐了、网络掉了、ssh 进程被杀了）。 */
  | 'CONNECTION_LOST'
  /** 这条连接已经关过了。 */
  | 'CONNECTION_CLOSED'
  /** 到了时限被收掉。 */
  | 'TIMEOUT'
  /** 被调用方取消。 */
  | 'CANCELLED'
  /** 路径越出了远端根目录。 */
  | 'PATH_OUTSIDE_ROOT'
  /** 主机名不合法（会被 ssh 当成选项注入的那种写法）。 */
  | 'INVALID_HOST'
  /** 参数不合法。 */
  | 'INVALID_ARGUMENT'
  /** 本机没有 ssh 可执行文件。 */
  | 'SSH_CLIENT_MISSING'
  /** 本地 IO 失败（写缓存、读文件之类）。 */
  | 'IO_FAILED'

/** 远程操作的错误。 */
export class SshError extends Error {
  /** 稳定的错误分类。 */
  readonly code: SshErrorCode
  /** 远端退出码（有的话）。 */
  readonly exitCode?: number
  /** 远端 stderr（有的话，便于排障）。 */
  readonly stderr?: string

  constructor(
    code: SshErrorCode,
    message: string,
    extra?: { readonly exitCode?: number; readonly stderr?: string; readonly cause?: unknown },
  ) {
    super(message, extra?.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'SshError'
    this.code = code
    if (extra?.exitCode !== undefined) this.exitCode = extra.exitCode
    if (extra?.stderr !== undefined) this.stderr = extra.stderr
  }
}

/**
 * 是不是某个错误码的 SSH 错误。
 *
 * 不给 `code` 就只判断「是不是 SSH 错误」。它是类型守卫，所以判完之后可以直接读
 * `error.code` 与 `error.stderr`。
 * @param error - 待判定的错误。
 * @param code - 期望的错误码；不给就只查类型。
 * @returns 匹配则 true。
 */
export function isSshError(error: unknown, code?: SshErrorCode): error is SshError {
  if (!(error instanceof SshError)) return false
  return code === undefined || error.code === code
}
