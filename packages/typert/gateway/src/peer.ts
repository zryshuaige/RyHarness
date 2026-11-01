/**
 * JSON-RPC 对端：把「发一条请求、等一条回包」这件事做完整。
 *
 * 它管的是**关联**——谁发的请求对应哪条回包——以及**三种坏情况**：
 * 超时、调用方取消、连接断开。三种都给出带机器码的失败，而不是让调用方
 * 永远等下去。
 *
 * 取消是**协作式**的：调用方放弃之后会发一条 `$/cancelRequest` 通知，对端收到
 * 才知道该收手。对端不理这条通知也不影响调用方——调用方早就拿到失败了。
 * @module @ryharness/typert-gateway/peer
 */

import { cancelled, disconnectedFailure, timeoutFailure } from './errors.ts'
import {
  decodeMessage,
  decodeRemoteError,
  encodeFailure,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC_ERROR_CODES,
  JsonRpcFrameDecoder,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc.ts'
import type { RpcTransport } from './transport.ts'

/** 取消通知的方法名。 */
export const CANCEL_REQUEST_METHOD = '$/cancelRequest'

/** 请求 id 的全局计数器：同一个进程里的多个对端不会撞号。 */
let nextRequestId = 0

/** 一次还没回来的请求。 */
interface PendingCall {
  /** 方法名（出错时写进日志）。 */
  readonly method: string
  /** 兑现结果。 */
  readonly resolve: (value: unknown) => void
  /** 兑现失败。 */
  readonly reject: (error: unknown) => void
  /** 超时计时器。 */
  timer: ReturnType<typeof setTimeout> | undefined
  /** 清掉计时器与取消监听。 */
  detach: () => void
}

/** 对端的可选项。 */
export interface JsonRpcPeerOptions {
  /** 默认超时（毫秒）。不给就是没有超时。 */
  readonly timeoutMs?: number
  /** 收到请求时怎么答。缺省就是一律「方法不存在」。 */
  readonly onRequest?: (request: JsonRpcRequest) => Promise<unknown> | unknown
  /** 收到通知时怎么办。 */
  readonly onNotification?: (notification: JsonRpcNotification) => void
  /** 连接断了。 */
  readonly onClose?: (reason: string) => void
  /** 收到看不懂的帧。 */
  readonly onError?: (error: unknown) => void
}

/** 一次请求的额外选项。 */
export interface JsonRpcRequestOptions {
  /** 这一次的超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 调用方的取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 一个 JSON-RPC 对端。
 *
 * 一条连接上跑一个：请求 id 从全局计数器取，所以同一条连接上的对端不会撞号。
 */
export class JsonRpcPeer {
  private readonly transport: RpcTransport
  private readonly options: JsonRpcPeerOptions
  private readonly decoder = new JsonRpcFrameDecoder()
  private readonly pending = new Map<string, PendingCall>()
  private closed = false

  /**
   * @param transport - 底层连接。
   * @param options - 可选项。
   */
  constructor(transport: RpcTransport, options: JsonRpcPeerOptions = {}) {
    this.transport = transport
    this.options = options
    transport.onData((chunk) => {
      this.receive(chunk)
    })
    transport.onClose((reason) => {
      this.handleClose(reason)
    })
  }

  /** 连接是不是已经断了。 */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 发一次请求并等回包。
   * @param method - 方法名。
   * @param params - 参数。
   * @param options - 超时与取消信号。
   * @returns 回包里的结果。
   */
  request(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(disconnectedFailure('连接已经断了'))
    nextRequestId += 1
    const id = `r${nextRequestId}`
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }
    return new Promise<unknown>((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted === true) {
        reject(cancelled('调用被取消'))
        return
      }
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(timeoutFailure(timeoutMs))
              this.sendCancel(id)
            }, timeoutMs)
      timer?.unref?.()
      const onAbort = (): void => {
        this.pending.delete(id)
        reject(cancelled('调用被取消'))
        this.sendCancel(id)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        detach: () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      })
      this.write(message)
    })
  }

  /**
   * 发一条通知（不回包）。
   * @param method - 方法名。
   * @param params - 参数。
   */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    }
    this.write(message)
  }

  /**
   * 断开连接，并把还没回来的请求全部判失败。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failPending(disconnectedFailure('本地已关闭连接'))
    this.transport.close()
  }

  /**
   * 把一条消息写出去。
   * @param message - 消息。
   */
  private write(message: JsonRpcMessage): void {
    try {
      this.transport.write(`${encodeMessage(message)}\n`)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  /**
   * 通知对端「这次不用做了」。
   * @param id - 请求 id。
   */
  private sendCancel(id: string): void {
    if (this.closed) return
    this.notify(CANCEL_REQUEST_METHOD, { id })
  }

  /**
   * 收到一段文本。
   * @param chunk - 文本。
   */
  private receive(chunk: string): void {
    for (const line of this.decoder.push(chunk)) {
      let message: JsonRpcMessage
      try {
        message = decodeMessage(line)
      } catch (error) {
        this.options.onError?.(error)
        continue
      }
      if (isRequest(message)) {
        void this.answer(message)
        continue
      }
      if (isNotification(message)) {
        this.options.onNotification?.(message)
        continue
      }
      if (isResponse(message)) {
        this.settle(message)
      }
    }
  }

  /**
   * 回一条请求。
   * @param request - 请求。
   */
  private async answer(request: JsonRpcRequest): Promise<void> {
    const handler = this.options.onRequest
    if (handler === undefined) {
      this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `没有这个方法：${request.method}` },
      })
      return
    }
    try {
      const result = await handler(request)
      if (this.closed) return
      this.write({ jsonrpc: '2.0', id: request.id, result: result === undefined ? null : result })
    } catch (error) {
      if (this.closed) return
      this.write({ jsonrpc: '2.0', id: request.id, error: encodeFailure(error) })
    }
  }

  /**
   * 处理一条回包。
   * @param response - 回包。
   */
  private settle(response: JsonRpcResponse): void {
    const id = String(response.id)
    const call = this.pending.get(id)
    if (call === undefined) return
    this.pending.delete(id)
    call.detach()
    if (response.error !== undefined) {
      call.reject(decodeRemoteError(response.error))
      return
    }
    call.resolve(response.result)
  }

  /**
   * 连接断了。
   * @param reason - 断开原因。
   */
  private handleClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.failPending(disconnectedFailure(reason))
    this.options.onClose?.(reason)
  }

  /**
   * 把还没回来的请求全部判失败。
   * @param error - 失败原因。
   */
  private failPending(error: unknown): void {
    for (const [id, call] of [...this.pending.entries()]) {
      this.pending.delete(id)
      call.detach()
      call.reject(error)
    }
  }
}
