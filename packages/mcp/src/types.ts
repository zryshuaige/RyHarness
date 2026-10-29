/**
 * MCP（Model Context Protocol）协议里本包真正会读的那几组消息形状。
 *
 * 只声明碰得到的部分：协议里还有 sampling、roots、elicitation、logging 等一堆
 * 方向，本包一概不做，写进类型表只会让人以为支持了。声明得少，边界反而清楚。
 * @module @ryharness/mcp/types
 */

/** JSON-RPC 2.0 的请求（客户端 → 服务端）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 的通知（没有 id，服务端不回复）。 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

/** JSON-RPC 2.0 的错误对象。 */
export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC 2.0 的响应（服务端 → 客户端）。 */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: JsonRpcErrorBody
}

/** MCP 的工具声明（`tools/list` 的一项）。 */
export interface McpToolDescriptor {
  name: string
  title?: string
  description?: string
  /** 入参 JSON Schema；本包原样透传给模型，不改写。 */
  inputSchema?: Record<string, unknown>
}

/** MCP 的内容块：文本 / 图片 / 音频 / 内嵌资源。 */
export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  resource?: McpResourceContents
}

/** MCP 的工具调用结果（`tools/call` 的 result）。 */
export interface McpToolResult {
  content: McpContentBlock[]
  /** server 自己说这次调用失败了；内容照样有（常常是错误说明）。 */
  isError?: boolean
}

/** MCP 的资源声明（`resources/list` 的一项）。 */
export interface McpResourceDescriptor {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

/** MCP 的资源内容（`resources/read` 的一项）。 */
export interface McpResourceContents {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

/** MCP 的 prompt 参数声明。 */
export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

/** MCP 的 prompt 声明（`prompts/list` 的一项）。 */
export interface McpPromptDescriptor {
  name: string
  title?: string
  description?: string
  arguments?: McpPromptArgument[]
}

/** `initialize` 的结果：服务端身份、能力，以及它自述的使用说明。 */
export interface McpServerInfo {
  name: string
  version: string
  /** 协商后的协议版本。 */
  protocolVersion: string
  title?: string
  /** server 自己写的使用说明；宿主可以把它并进系统提示词。 */
  instructions?: string
  capabilities: Record<string, unknown>
}

/**
 * 一个 MCP server 的启动配置。
 *
 * 纯数据：怎么存、存哪儿由宿主决定，本包只负责照着它把进程拉起来。
 */
export interface McpServerConfig {
  /** 可执行文件（走 PATH 查找也可以）。 */
  command: string
  args?: string[]
  /** 追加给子进程的环境变量。 */
  env?: Record<string, string>
}

/** 一整组 MCP server 配置。 */
export interface McpConfig {
  servers: Record<string, McpServerConfig>
}
