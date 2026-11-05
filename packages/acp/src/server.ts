/**
 * ACP 服务端侧：**我们当 agent**，编辑器驱动我们。
 *
 * ## 为什么要有服务端侧
 *
 * {@link AcpClient} 是反过来的：编辑器当客户端、我们当 agent 端去连别的 agent。
 * 但 RyHarness 自己就是 agent——用户装的是 RyHarness，编辑器（VS Code / Zed /
 * 任何支持 ACP 的编辑器）要把它当 agent 用，就得由**我们**说 ACP 的话。
 *
 * 所以这一侧是镜像的四个方法：
 * - `initialize`：握手，报协议版本与能力；
 * - `session/new`：开一个会话（对应我们这边的一个会话）；
 * - `session/prompt`：发一条用户消息，跑一轮，把过程推成事件；
 * - `session/cancel`：取消当前这轮。
 *
 * ## 事件从哪来
 *
 * **不是**我们自己造一套：会话跑起来时事件由协调器推出来（`text-delta`、
 * `tool-call-start`、`tool-result`、`done`），这一层把它们翻译成 ACP 的事件形状。
 * 翻译规则写在 {@link AcpEventBridge} 里——只有一处。
 *
 * ## 与客户端侧的共用
 *
 * 线协议（JSON-RPC 2.0 + 按行分帧）、事件形状、方法名，都是**同一套**
 * （见 `protocol.ts` 与 `events.ts`）。服务端与客户端的区别只有「谁发起请求」。
 *
 * @module @ryharness/acp/server
 */

import { JsonRpcPeer, type RpcTransport } from '@ryharness/api'
import {
  ACP_EVENT_VERSION,
  type AcpEvent,
  type AcpStopReason,
  type AcpToolCallStatus,
  type AcpToolKind,
} from './events.ts'
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
} from './protocol.ts'

/** 服务端要驱动的那些能力（宿主实现）。 */
export interface AcpAgentHandlers {
  /**
   * 开一个会话。
   * @param cwd - 编辑器给的工作目录（可选）。
   * @returns 会话 id。
   */
  newSession(cwd?: string): Promise<string>
  /**
   * 发一条用户消息，跑一轮。
   * @param sessionId - 会话 id。
   * @param text - 消息正文。
   * @param signal - 取消信号（编辑器取消这一轮时 abort）。
   * @returns 这一轮为什么停。
   */
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<AcpStopReason>
  /**
   * 关一个会话。
   * @param sessionId - 会话 id。
   */
  closeSession(sessionId: string): Promise<void>
  /**
   * 取消当前这一轮。
   * @param sessionId - 会话 id。
   */
  cancel(sessionId: string): void
  /**
   * 一段文字增量（这一轮吐出来的）。
   * @param sessionId - 会话 id。
   * @param text - 增量文本。
   */
  onText(sessionId: string, text: string): void
  /**
   * 一次工具调用开始或状态变化。
   * @param sessionId - 会话 id。
   * @param callId - 工具调用 id。
   * @param title - 人看的标题。
   * @param status - 当前状态。
   * @param toolKind - 工具的种类（可选）。
   */
  onToolCall(sessionId: string, callId: string, title: string, status: AcpToolCallStatus, toolKind?: AcpToolKind): void
  /**
   * 一次工具调用的结果。
   * @param sessionId - 会话 id。
   * @param callId - 工具调用 id。
   * @param status - 成功还是失败。
   * @param content - 结果正文。
   */
  onToolResult(sessionId: string, callId: string, status: 'completed' | 'failed', content: string): void
  /**
   * 这一轮出错了。
   * @param sessionId - 会话 id。
   * @param code - 机器码。
   * @param message - 人看的说明。
   */
  onError(sessionId: string, code: string, message: string): void
}

/**
 * 联合类型上的 `Omit` 不对——它只作用于联合的公共字段。
 *
 * 这里要的是「去掉公共字段后，每个成员各自剩下的部分」，所以要分配一次
 * `Omit`（分布式版本）。
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

/** 服务端的构造选项。 */
export interface AcpAgentServerOptions {
  /** 连接。 */
  readonly transport: RpcTransport
  /** 能力实现。 */
  readonly handlers: AcpAgentHandlers
  /** 要谈的协议版本。缺省是本实现支持的版本。 */
  readonly protocolVersion?: number
}

/**
 * ACP 服务端。
 *
 * 一个实例服务一条连接：编辑器连上来，握手、开会话、发消息、取消。
 */
export class AcpAgentServer {
  private readonly peer: JsonRpcPeer
  private readonly handlers: AcpAgentHandlers
  private readonly protocolVersion: number
  /** 每个会话的事件序号（编辑器靠它判断有没有漏收）。 */
  private readonly seqs = new Map<string, number>()
  /** 每个会话当前这轮的中止器。 */
  private readonly aborts = new Map<string, AbortController>()
  /** 已开的会话。 */
  private readonly sessions = new Set<string>()

  constructor(options: AcpAgentServerOptions) {
    this.handlers = options.handlers
    this.protocolVersion = options.protocolVersion ?? ACP_PROTOCOL_VERSION
    this.peer = new JsonRpcPeer(options.transport, {
      onRequest: (request) => this.dispatch(request.method, request.params),
      onNotification: (notification) => {
        if (notification.method !== ACP_METHODS.cancel) return
        const sessionId = readString(notification.params, 'sessionId')
        if (sessionId !== undefined) this.handlers.cancel(sessionId)
      },
    })
  }

  /**
   * 断开连接。
   */
  close(): void {
    this.peer.close()
    this.sessions.clear()
    for (const controller of this.aborts.values()) controller.abort()
    this.aborts.clear()
  }

  /**
   * 处理一条请求。
   * @param method - 方法名。
   * @param params - 参数。
   * @returns 结果。
   */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case ACP_METHODS.initialize: {
        const result: AcpInitializeResult = {
          protocolVersion: this.protocolVersion,
          agentCapabilities: { streaming: true, tools: true },
        }
        return result
      }
      case ACP_METHODS.newSession: {
        const cwd = readString(params, 'cwd')
        const sessionId = await this.handlers.newSession(cwd)
        this.sessions.add(sessionId)
        this.seqs.set(sessionId, 0)
        const result: AcpNewSessionResult = { sessionId }
        return result
      }
      case ACP_METHODS.prompt: {
        const sessionId = readString(params, 'sessionId')
        if (sessionId === undefined) throw new Error('session/prompt 缺少 sessionId')
        const prompt = Reflect.get(params as object, 'prompt')
        const text = readString(prompt as object, 'text')
        if (text === undefined) throw new Error('session/prompt 缺少 prompt.text')
        const controller = new AbortController()
        this.aborts.set(sessionId, controller)
        try {
          const stopReason = await this.handlers.prompt(sessionId, text, controller.signal)
          this.push(sessionId, { kind: 'completed', stopReason })
          const result: AcpPromptResult = { stopReason }
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.push(sessionId, { kind: 'error', code: 'PROMPT_FAILED', message })
          const result: AcpPromptResult = { stopReason: 'error' }
          return result
        } finally {
          this.aborts.delete(sessionId)
        }
      }
      case ACP_METHODS.close: {
        const sessionId = readString(params, 'sessionId')
        if (sessionId === undefined) throw new Error('session/close 缺少 sessionId')
        await this.handlers.closeSession(sessionId)
        this.sessions.delete(sessionId)
        this.seqs.delete(sessionId)
        return null
      }
      default:
        throw new Error(`没有这个方法：${method}`)
    }
  }

  /**
   * 推一条事件。
   *
   * 序号在**每个会话内**递增：编辑器靠它判断有没有漏收。
   * @param sessionId - 会话 id。
   * @param event - 事件（不带公共字段）。
   */
  private push(sessionId: string, event: DistributiveOmit<AcpEvent, 'version' | 'sessionId' | 'seq'>): void {
    if (!this.sessions.has(sessionId)) return
    const seq = (this.seqs.get(sessionId) ?? 0) + 1
    this.seqs.set(sessionId, seq)
    this.peer.notify(ACP_METHODS.update, {
      version: ACP_EVENT_VERSION,
      sessionId,
      seq,
      ...event,
    })
  }

  /**
   * 一段文字增量。
   * @param sessionId - 会话 id。
   * @param text - 增量文本。
   */
  text(sessionId: string, text: string): void {
    this.push(sessionId, { kind: 'message_chunk', text })
  }

  /**
   * 一次工具调用。
   * @param sessionId - 会话 id。
   * @param callId - 工具调用 id。
   * @param title - 人看的标题。
   * @param status - 当前状态。
   * @param toolKind - 工具的种类（可选）。
   */
  toolCall(sessionId: string, callId: string, title: string, status: AcpToolCallStatus, toolKind?: AcpToolKind): void {
    this.push(sessionId, {
      kind: 'tool_call',
      callId,
      title,
      status,
      ...(toolKind === undefined ? {} : { toolKind }),
    })
  }

  /**
   * 一次工具结果。
   * @param sessionId - 会话 id。
   * @param callId - 工具调用 id。
   * @param status - 成功还是失败。
   * @param content - 结果正文。
   */
  toolResult(sessionId: string, callId: string, status: 'completed' | 'failed', content: string): void {
    this.push(sessionId, { kind: 'tool_result', callId, status, content })
  }

  /**
   * 这一轮出错了。
   * @param sessionId - 会话 id。
   * @param code - 机器码。
   * @param message - 人看的说明。
   */
  error(sessionId: string, code: string, message: string): void {
    this.push(sessionId, { kind: 'error', code, message })
  }

  /**
   * 取消当前这一轮。
   *
   * **中止器真的 abort**：协调器那边收到 abort 就把这一轮停掉，不只是「不理它了」。
   * @param sessionId - 会话 id。
   */
  cancel(sessionId: string): void {
    const controller = this.aborts.get(sessionId)
    if (controller === undefined) {
      this.handlers.cancel(sessionId)
      return
    }
    controller.abort()
    this.handlers.cancel(sessionId)
  }
}

/**
 * 读一个对象上的字符串字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}
