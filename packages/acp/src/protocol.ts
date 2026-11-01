/**
 * ACP 的线上约定。
 *
 * 方法名与参数形状都写死在这里——ACP 的价值就在于「编辑器与 agent 说同一种
 * 话」，所以这些名字不能随便改。
 * @module @ryharness/acp/protocol
 */

import type { AcpStopReason } from './events.ts'

/** 本实现支持的协议版本。 */
export const ACP_PROTOCOL_VERSION = 1

/** 线上方法名。 */
export const ACP_METHODS = {
  /** 握手：说清彼此的协议版本与能力。 */
  initialize: 'initialize',
  /** 新建一个会话。 */
  newSession: 'session/new',
  /** 发一条用户消息，等这一轮结束。 */
  prompt: 'session/prompt',
  /** 取消当前这轮（通知，不等回包）。 */
  cancel: 'session/cancel',
  /** 关闭会话。 */
  close: 'session/close',
  /** 会话有更新（通知）。 */
  update: 'session/update',
} as const

/** 握手的结果。 */
export interface AcpInitializeResult {
  /** 对端支持的协议版本。 */
  readonly protocolVersion: number
  /** 对端的能力。 */
  readonly agentCapabilities: AcpAgentCapabilities
}

/** agent 的能力。 */
export interface AcpAgentCapabilities {
  /** 会不会流式吐字。 */
  readonly streaming: boolean
  /** 会不会用工具。 */
  readonly tools: boolean
}

/** 一个要挂上的 MCP 服务器。 */
export interface AcpMcpServer {
  /** 服务器名字。 */
  readonly name: string
  /** 启动命令。 */
  readonly command: string
  /** 参数。 */
  readonly args?: readonly string[]
}

/** 新建会话的参数。 */
export interface AcpNewSessionParams {
  /** 会话的工作目录。 */
  readonly cwd?: string
  /** 要挂上的 MCP 服务器。 */
  readonly mcpServers?: readonly AcpMcpServer[]
}

/** 一条用户消息。 */
export interface AcpPrompt {
  /** 消息类型。现在只有文本。 */
  readonly type: 'text'
  /** 文本。 */
  readonly text: string
}

/** 发消息的参数。 */
export interface AcpPromptParams {
  /** 哪个会话。 */
  readonly sessionId: string
  /** 消息。 */
  readonly prompt: AcpPrompt
}

/** 发消息的结果。 */
export interface AcpPromptResult {
  /** 这一轮为什么停。 */
  readonly stopReason: AcpStopReason
}

/** 新建会话的结果。 */
export interface AcpNewSessionResult {
  /** 会话 id。 */
  readonly sessionId: string
}
