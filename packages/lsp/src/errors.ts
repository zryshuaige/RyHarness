/**
 * 语言服务器导航的失败原因。
 *
 * 为什么单开一个错误类型：语言服务器这一层的失败全是「英文异常 + 一个说不清的
 * 后果」——`spawn ENOENT`、`Request timed out`、`Invalid content length`。这些
 * 文本原样回给模型，只会换来一句看不懂的抱怨。模型能读懂的是三段：**哪种失败**
 * （机器可读的 code）、**一句话原因**（中文）、**必要时补一点上下文**（details）。
 *
 * code 的分法按「该怎么处理」来，不是按「谁报的错」来：
 * - `no-provider`：这个文件类型压根没配语言服务器，重试没用，得改配置。
 * - `command-not-found`：配置里的命令不在 PATH 上——去装它。
 * - `server-unavailable`：服务器没起来或中途没了，可以重试（会自动重启）。
 * - `unsupported-operation`：这个服务器不提供这个操作，换个服务器或别用这个操作。
 * - `timeout`：它没在时限内回包，重试可能有用。
 * - `protocol-error`：它说的话不是协议说得清的话，重试没用。
 * - `file-not-in-workspace` / `file-not-found`：文件本身的问题，重试没用。
 * - `request-failed`：它明确回了一个错误（内容原样带在 message 里）。
 * - `cancelled`：调用方把这一轮取消了。
 * @module @ryharness/lsp/errors
 */

/**
 * 失败类别（机器可读）。
 *
 * 这一串是**公开契约**：调用方可以按 code 分支处理，文案随便改。
 */
export type LspErrorCode =
  | 'no-provider'
  | 'command-not-found'
  | 'server-unavailable'
  | 'unsupported-operation'
  | 'timeout'
  | 'protocol-error'
  | 'file-not-in-workspace'
  | 'file-not-found'
  | 'request-failed'
  | 'cancelled'

/**
 * 语言服务器相关的失败一律走这一个错误类型。
 *
 * `code` 给调用方分类用，`message` 直接给人看——它会原样进模型上下文。
 */
export class LspError extends Error {
  override name = 'LspError'

  constructor(
    readonly code: LspErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/**
 * 把任意抛出的东西翻成一句能读的文本。
 *
 * 故意不把 `LspError` 之外的异常改写成本包的失败类别：那些异常多半是**我们自己的
 * bug**（空指针、类型错），改写成一句中文只会把 bug 藏起来。这里只保证「能读」。
 * @param error - 抛出来的东西。
 * @returns 一句能给人看的说明。
 */
export function describeLspFailure(error: unknown): string {
  if (error instanceof LspError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
