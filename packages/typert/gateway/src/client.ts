/**
 * 网关的客户端：按类型图把一次调用发出去，等回包。
 *
 * 客户端**先看图再发**：图里没有的方法立刻抛错，不会把「未知方法」发出去
 * 等对端回一句「没有这个方法」。
 *
 * 类型图可以由调用方给（两端都拿到了同一张图），也可以**向宿主要**——后者是
 * 常见形态：客户端连上去先要一张图，再照着图调。
 * @module @ryharness/typert-gateway/client
 */

import { badRequest } from './errors.ts'
import { findEntry, isTypeGraph } from './graph.ts'
import { JsonRpcPeer } from './peer.ts'
import { REMOTE_CALL_METHOD, REMOTE_GRAPH_METHOD } from './protocol.ts'
import type { RpcTransport } from './transport.ts'
import type { TypeGraph } from './types.ts'

/** 客户端的构造选项。 */
export interface RemoteGatewayClientOptions {
  /** 连接。 */
  readonly transport: RpcTransport
  /** 类型图：客户端按它校验方法存不存在。不给就在第一次调用前去宿主要。 */
  readonly graph?: TypeGraph
  /** 默认超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 一次调用的附加选项。 */
export interface RemoteGatewayCallOptions {
  /** 这一次的超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 网关客户端。
 */
export class RemoteGatewayClient {
  private readonly peer: JsonRpcPeer
  private readonly timeoutMs: number | undefined
  private loadedGraph: TypeGraph | undefined
  private loading: Promise<TypeGraph> | undefined

  /**
   * @param options - 构造选项。
   */
  constructor(options: RemoteGatewayClientOptions) {
    this.loadedGraph = options.graph
    this.timeoutMs = options.timeoutMs
    this.peer = new JsonRpcPeer(options.transport, { timeoutMs: options.timeoutMs })
  }

  /** 已经拿到的类型图；还没要过就是 undefined。 */
  get graph(): TypeGraph | undefined {
    return this.loadedGraph
  }

  /**
   * 向宿主要一张类型图。
   *
   * 已经在手上就直接返回；并发的多次要图只会真的问一次。
   * @returns 类型图。
   */
  async loadGraph(): Promise<TypeGraph> {
    if (this.loadedGraph !== undefined) return this.loadedGraph
    if (this.loading !== undefined) return this.loading
    this.loading = this.peer
      .request(REMOTE_GRAPH_METHOD)
      .then((payload) => {
        if (!isTypeGraph(payload)) {
          throw badRequest('宿主给回来的类型图不认识')
        }
        this.loadedGraph = payload
        return payload
      })
      .finally(() => {
        this.loading = undefined
      })
    return this.loading
  }

  /**
   * 调一个远端方法。
   * @param namespace - 命名空间。
   * @param method - 线上的方法名。
   * @param args - 位置参数。
   * @param options - 超时与取消信号。
   * @returns 方法的返回值。
   */
  async call(
    namespace: string,
    method: string,
    args: readonly unknown[] = [],
    options: RemoteGatewayCallOptions = {},
  ): Promise<unknown> {
    const graph = this.loadedGraph ?? (await this.loadGraph())
    if (findEntry(graph, namespace, method) === undefined) {
      throw badRequest(`类型图里没有这个方法：${namespace}.${method}`)
    }
    return this.peer.request(
      REMOTE_CALL_METHOD,
      { namespace, method, args },
      { timeoutMs: options.timeoutMs ?? this.timeoutMs, signal: options.signal },
    )
  }

  /**
   * 断开连接。
   */
  close(): void {
    this.peer.close()
  }
}
