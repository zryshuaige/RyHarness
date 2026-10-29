/**
 * MCP 失败的中文说法。
 *
 * 为什么要自己写一套：spawn 失败、协议违规、工具自己报的错，原始文本都是英文
 * （"spawn ENOENT"、"Request timed out"），原样回给模型只会换来一句看不懂的
 * 抱怨。模型能读懂的是三段：哪个 server、哪一步、为什么。
 * @module @ryharness/mcp/errors
 */

/**
 * 失败类别。
 *
 * 分开是因为处理方式不同：`timeout` 与 `cancelled` 值得重试，`startup` 与
 * `protocol` 重试也没用（配置或对端就有问题），`tool` 是被调工具自己的失败。
 */
export type McpErrorKind = 'startup' | 'timeout' | 'protocol' | 'request' | 'cancelled' | 'closed' | 'tool'

/**
 * MCP 相关的失败一律走这一个错误类型。
 *
 * `kind` 给调用方分类用，`message` 直接给人看——它会原样进模型上下文。
 */
export class McpError extends Error {
  override name = 'McpError'

  constructor(
    readonly kind: McpErrorKind,
    readonly serverName: string,
    message: string,
  ) {
    super(message)
  }
}

/** 把任意抛出的东西翻成一句能读的文本。 */
export function describeFailure(error: unknown): string {
  if (error instanceof McpError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
