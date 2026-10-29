/**
 * MCP 客户端：把外部 MCP server 的工具接进 RyHarness 的工具体系。
 *
 * 三块东西：一是一条 stdio 连接（{@link McpStdioClient}），二是把一批配置变成
 * 一批工具的登记处（{@link McpClientRegistry}），三是工具名的生成规则
 * （{@link mcpToolName}）。装配（配置从哪儿来、工具注册到哪儿）不在本包里。
 * @module @ryharness/mcp
 */

export type { McpClientOptions } from './client.ts'
export { buildChildEnv, McpStdioClient } from './client.ts'
export type { McpErrorKind } from './errors.ts'
export { describeFailure, McpError } from './errors.ts'
export type { McpToolRef } from './naming.ts'
export { assignMcpToolNames, mcpToolName, mcpToolRefKey, sanitizeNameSegment } from './naming.ts'
export type {
  McpConnectFailure,
  McpConnectReport,
  McpRegistryOptions,
  McpResourceEntry,
} from './registry.ts'
export { McpClientRegistry } from './registry.ts'
export type { McpToolInvoker, McpToolOptions } from './tools.ts'
export { createMcpTool, renderMcpContent } from './tools.ts'
export type {
  McpConfig,
  McpContentBlock,
  McpPromptArgument,
  McpPromptDescriptor,
  McpResourceContents,
  McpResourceDescriptor,
  McpServerConfig,
  McpServerInfo,
  McpToolDescriptor,
  McpToolResult,
} from './types.ts'
