/**
 * 网关的服务端：接一条连接，按类型图把请求分发到本地方法。
 *
 * 一个服务端可以接多条连接（每条连接一个 JSON-RPC 对端），登记表是共用的。
 * @module @ryharness/typert-gateway/server
 */

import { badRequest, cancelled } from './errors.ts'
import { CANCEL_REQUEST_METHOD, JsonRpcPeer } from './peer.ts'
import { REMOTE_CALL_METHOD, REMOTE_GRAPH_METHOD, type RemoteCallParams } from './protocol.ts'
import type { RemoteRegistry } from './registry.ts'
import type { RpcTransport } from './transport.ts'

/** 服务端的构造选项。 */
export interface RemoteGatewayServerOptions {
  /**
   * 登记表：类型图与本地实现都在这里。
   *
   * 可以给一个**取登记表的函数**——挂载会变时（宿主随时加服务），每次请求都
   * 重新看一眼，连接不用重开。
   */
  readonly registry: RemoteRegistry | (() => RemoteRegistry)
  /** 默认超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 出错时的旁路（记日志用）。 */
  readonly onError?: (error: unknown) => void
}

/**
 * 读出一个对象上的字符串字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * 解析一次调用的线上参数。
 * @param params - 线上参数。
 * @returns 解析结果。
 */
function readCallParams(params: unknown): RemoteCallParams {
  if (typeof params !== 'object' || params === null) throw badRequest('调用参数不对')
  const namespace = readString(params, 'namespace')
  const method = readString(params, 'method')
  if (namespace === undefined || method === undefined) throw badRequest('调用参数不对')
  const args = Reflect.get(params, 'args')
  return { namespace, method, args: Array.isArray(args) ? args : [] }
}

/**
 * 网关服务端。
 */
export class RemoteGatewayServer {
  private readonly options: RemoteGatewayServerOptions
  private readonly peers = new Set<JsonRpcPeer>()
  private readonly inflight = new Map<string, AbortController>()

  /**
   * @param options - 构造选项。
   */
  constructor(options: RemoteGatewayServerOptions) {
    this.options = options
  }

  /** 当前的登记表。 */
  private get registry(): RemoteRegistry {
    const source = this.options.registry
    return typeof source === 'function' ? source() : source
  }

  /**
   * 接一条连接。
   * @param transport - 连接。
   */
  attach(transport: RpcTransport): void {
    const peer = new JsonRpcPeer(transport, {
      timeoutMs: this.options.timeoutMs,
      onRequest: (request) => this.dispatch(String(request.id), request.method, request.params),
      onNotification: (notification) => this.onNotification(notification.method, notification.params),
      onError: (error) => this.options.onError?.(error),
    })
    this.peers.add(peer)
    transport.onClose(() => {
      this.peers.delete(peer)
    })
  }

  /**
   * 断开所有连接。
   */
  close(): void {
    for (const peer of [...this.peers]) peer.close()
    this.peers.clear()
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }

  /**
   * 分发一次调用。
   * @param requestId - 线上请求 id（取消时要用它对上号）。
   * @param method - 线上方法名。
   * @param params - 线上参数。
   * @returns 方法的返回值。
   */
  private async dispatch(requestId: string, method: string, params: unknown): Promise<unknown> {
    if (method === REMOTE_GRAPH_METHOD) {
      return this.registry.graph
    }
    if (method !== REMOTE_CALL_METHOD) {
      throw badRequest(`没有这个网关方法：${method}`)
    }
    const call = readCallParams(params)
    const controller = new AbortController()
    this.inflight.set(requestId, controller)
    try {
      const result = await this.registry.invoke(call.namespace, call.method, call.args, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) throw cancelled('宿主已经取消这次调用')
      return result
    } finally {
      this.inflight.delete(requestId)
    }
  }

  /**
   * 处理一条通知。
   *
   * 目前只认取消：客户端放弃一次调用之后会发 `$/cancelRequest`，服务端据此把
   * 那次调用掐掉。
   * @param method - 线上方法名。
   * @param params - 线上参数。
   */
  private onNotification(method: string, params: unknown): void {
    if (method !== CANCEL_REQUEST_METHOD) return
    if (typeof params !== 'object' || params === null) return
    const id = readString(params, 'id')
    if (id === undefined) return
    const controller = this.inflight.get(id)
    controller?.abort()
  }
}
