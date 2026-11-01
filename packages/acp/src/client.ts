/**
 * ACP 客户端：编辑器用它驱动一个 agent 会话。
 *
 * 一次完整的过程是：握手 → 新建会话 → 发一条用户消息 → 收一串事件 → 这一轮
 * 结束。中间还能取消。
 *
 * 事件是**推**过来的（通知），所以事件流是订阅式的：客户端挂一个回调，收到
 * 一条就回调一次。解析不出来的事件被丢掉——对端升级协议不该让会话垮掉。
 * @module @ryharness/acp/client
 */

import { JsonRpcPeer, type RpcTransport } from '@ryharness/api'
import { invalidResponseFailure, sessionUnknownFailure } from './errors.ts'
import { type AcpEvent, parseAcpEvent } from './events.ts'
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPromptResult,
} from './protocol.ts'

/** 客户端的构造选项。 */
export interface AcpClientOptions {
  /** 连接。 */
  readonly transport: RpcTransport
  /** 要谈的协议版本。缺省是本实现支持的版本。 */
  readonly protocolVersion?: number
}

/** 事件回调。 */
export type AcpEventHandler = (event: AcpEvent) => void

/**
 * 读一个对象上的字符串字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * 读一个对象上的布尔字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是布尔时是 undefined。
 */
function readBoolean(source: object, key: string): boolean | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 解析握手结果。
 * @param value - 线上的结果。
 * @returns 解析结果。
 */
function parseInitializeResult(value: unknown): AcpInitializeResult {
  if (typeof value !== 'object' || value === null) throw invalidResponseFailure(ACP_METHODS.initialize)
  const protocolVersion = Reflect.get(value, 'protocolVersion')
  if (typeof protocolVersion !== 'number') throw invalidResponseFailure(ACP_METHODS.initialize)
  const capabilities = Reflect.get(value, 'agentCapabilities')
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw invalidResponseFailure(ACP_METHODS.initialize)
  }
  return {
    protocolVersion,
    agentCapabilities: {
      streaming: readBoolean(capabilities, 'streaming') ?? false,
      tools: readBoolean(capabilities, 'tools') ?? false,
    },
  }
}

/**
 * 解析新建会话的结果。
 * @param value - 线上的结果。
 * @returns 解析结果。
 */
function parseNewSessionResult(value: unknown): AcpNewSessionResult {
  if (typeof value !== 'object' || value === null) throw invalidResponseFailure(ACP_METHODS.newSession)
  const sessionId = readString(value, 'sessionId')
  if (sessionId === undefined || sessionId.length === 0) {
    throw invalidResponseFailure(ACP_METHODS.newSession)
  }
  return { sessionId }
}

/**
 * 解析发消息的结果。
 * @param value - 线上的结果。
 * @returns 解析结果。
 */
function parsePromptResult(value: unknown): AcpPromptResult {
  if (typeof value !== 'object' || value === null) throw invalidResponseFailure(ACP_METHODS.prompt)
  const stopReason = readString(value, 'stopReason')
  if (stopReason !== 'end_turn' && stopReason !== 'cancelled' && stopReason !== 'error') {
    throw invalidResponseFailure(ACP_METHODS.prompt)
  }
  return { stopReason }
}

/**
 * 一个会话的句柄。
 *
 * 事件按会话分发：只有 `sessionId` 对得上的事件才会送到这个会话的回调。
 */
export class AcpSession {
  private readonly peer: JsonRpcPeer
  private readonly handlers = new Set<AcpEventHandler>()
  private closed = false

  /**
   * @param peer - JSON-RPC 对端。
   * @param sessionId - 会话 id。
   */
  constructor(
    peer: JsonRpcPeer,
    readonly sessionId: string,
  ) {
    this.peer = peer
  }

  /** 会话是不是已经关了。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 订阅这个会话的事件。
   * @param handler - 回调。
   * @returns 取消订阅的函数。
   */
  onEvent(handler: AcpEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /**
   * 发一条用户消息，等这一轮结束。
   * @param text - 消息正文。
   * @returns 这一轮为什么停。
   */
  async send(text: string): Promise<AcpPromptResult['stopReason']> {
    if (this.closed) throw sessionUnknownFailure(this.sessionId)
    const result = await this.peer.request(ACP_METHODS.prompt, {
      sessionId: this.sessionId,
      prompt: { type: 'text', text },
    })
    return parsePromptResult(result).stopReason
  }

  /**
   * 取消当前这一轮。
   *
   * 取消是**通知**：不等回包。对端收到之后自己收手，这一轮最后会以
   * `stopReason: 'cancelled'` 结束。
   */
  cancel(): void {
    if (this.closed) return
    this.peer.notify(ACP_METHODS.cancel, { sessionId: this.sessionId })
  }

  /**
   * 关闭会话。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.peer.request(ACP_METHODS.close, { sessionId: this.sessionId })
  }

  /**
   * 把一条事件送给这个会话的回调。
   * @param event - 事件。
   */
  deliver(event: AcpEvent): void {
    if (event.sessionId !== this.sessionId) return
    for (const handler of [...this.handlers]) handler(event)
  }
}

/**
 * ACP 客户端。
 */
export class AcpClient {
  private readonly peer: JsonRpcPeer
  private readonly protocolVersion: number
  private readonly sessions = new Map<string, AcpSession>()
  private readonly handlers = new Set<AcpEventHandler>()

  /**
   * @param options - 构造选项。
   */
  constructor(options: AcpClientOptions) {
    this.protocolVersion = options.protocolVersion ?? ACP_PROTOCOL_VERSION
    this.peer = new JsonRpcPeer(options.transport, {
      onNotification: (notification) => {
        if (notification.method !== ACP_METHODS.update) return
        const event = parseAcpEvent(notification.params)
        if (event === undefined) return
        for (const handler of [...this.handlers]) handler(event)
        this.sessions.get(event.sessionId)?.deliver(event)
      },
    })
  }

  /**
   * 握手。
   * @returns 对端的协议版本与能力。
   */
  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.peer.request(ACP_METHODS.initialize, { protocolVersion: this.protocolVersion })
    return parseInitializeResult(result)
  }

  /**
   * 新建一个会话。
   * @param params - 参数（工作目录、要挂的 MCP 服务器）。
   * @returns 会话句柄。
   */
  async newSession(params: AcpNewSessionParams = {}): Promise<AcpSession> {
    const result = await this.peer.request(ACP_METHODS.newSession, {
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.mcpServers === undefined ? {} : { mcpServers: params.mcpServers }),
    })
    const { sessionId } = parseNewSessionResult(result)
    const session = new AcpSession(this.peer, sessionId)
    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * 订阅全部会话的事件。
   * @param handler - 回调。
   * @returns 取消订阅的函数。
   */
  onEvent(handler: AcpEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /**
   * 断开连接。
   */
  close(): void {
    this.peer.close()
    this.sessions.clear()
  }
}
