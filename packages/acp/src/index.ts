/**
 * Agent Client Protocol。
 *
 * 编辑器之类的**客户端**用它驱动一个 agent 会话：握手、开一个会话、发一条
 * 用户消息、收流式事件、取消、关掉。
 *
 * 事件形状是这一层对外的承诺：字段固定、带版本号（见 `events.ts`）。
 *
 * 线协议是 JSON-RPC 2.0，与 Remote 层、进程外 SDK **同一套**（从
 * `@ryharness/api` 转出），不另写一份。
 * @module @ryharness/acp
 */

export type { RpcTransport } from '@ryharness/api'
/** 线协议：ACP 用的就是 Remote 层那一套。 */
export { JSON_RPC_VERSION, JsonRpcPeer } from '@ryharness/api'
export type { AcpClientOptions, AcpEventHandler } from './client.ts'
export { AcpClient, AcpSession } from './client.ts'
export { invalidResponseFailure, sessionUnknownFailure } from './errors.ts'
export type {
  AcpCompletedEvent,
  AcpErrorEvent,
  AcpEvent,
  AcpEventBase,
  AcpMessageChunkEvent,
  AcpStopReason,
  AcpToolCallEvent,
  AcpToolCallStatus,
  AcpToolKind,
  AcpToolResultEvent,
} from './events.ts'
export {
  ACP_EVENT_VERSION,
  isCompleted,
  isError,
  isMessageChunk,
  isToolCall,
  isToolResult,
  parseAcpEvent,
} from './events.ts'
export type {
  AcpAgentCapabilities,
  AcpInitializeResult,
  AcpMcpServer,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPrompt,
  AcpPromptParams,
  AcpPromptResult,
} from './protocol.ts'
export { ACP_METHODS, ACP_PROTOCOL_VERSION } from './protocol.ts'
export type { AcpAgentHandlers, AcpAgentServerOptions } from './server.ts'
export { AcpAgentServer } from './server.ts'
