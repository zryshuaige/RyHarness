/**
 * 客户端侧：连上宿主，照着类型图调方法。
 *
 * 客户端连上之后先要一张**类型图**——宿主暴露了什么、每个方法的参数与返回
 * 类型是什么。有了图，客户端才能在本地就拦住「调一个不存在的方法」。
 * @module @ryharness/api/client
 */

import { RemoteGatewayClient, type RemoteInvoker, type RpcTransport, type TypeGraph } from '@ryharness/typert-gateway'
import { connectRemoteSocket, type RemoteSocketConnectOptions } from './socket.ts'

/** 客户端的连接参数。 */
export interface RemoteConnectOptions extends RemoteSocketConnectOptions {
  /** 单次调用的默认超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 一次调用的附加选项。 */
export interface RemoteCallOptions {
  /** 这一次的超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 一个远程客户端。
 *
 * 客户端拿到的是**类型图 + 调用入口**两样东西：图给人看、给生成器看；调用
 * 入口是真正把请求发出去的那条路。
 */
export class RemoteClient {
  private readonly gateway: RemoteGatewayClient

  /** 宿主暴露的类型图。 */
  readonly graph: TypeGraph

  /**
   * @param gateway - 网关客户端。
   * @param graph - 宿主给回来的类型图。
   */
  private constructor(gateway: RemoteGatewayClient, graph: TypeGraph) {
    this.gateway = gateway
    this.graph = graph
  }

  /**
   * 连一个宿主。
   * @param options - 连接参数。
   * @returns 连好的客户端。
   */
  static async connect(options: RemoteConnectOptions): Promise<RemoteClient> {
    const { transport } = await connectRemoteSocket(options)
    const gateway = new RemoteGatewayClient({ transport, timeoutMs: options.timeoutMs })
    const graph = await gateway.loadGraph()
    return new RemoteClient(gateway, graph)
  }

  /**
   * 用一条现成的传输建客户端。
   *
   * 同进程的两端、测试替身、管道都用这个。
   * @param transport - 连接。
   * @param options - 可选项。
   * @returns 连好的客户端。
   */
  static async attach(transport: RpcTransport, options: { readonly timeoutMs?: number } = {}): Promise<RemoteClient> {
    const gateway = new RemoteGatewayClient({ transport, timeoutMs: options.timeoutMs })
    const graph = await gateway.loadGraph()
    return new RemoteClient(gateway, graph)
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
    options: RemoteCallOptions = {},
  ): Promise<unknown> {
    return this.gateway.call(namespace, method, args, options)
  }

  /**
   * 调用入口：给生成的客户端代理用。
   *
   * 生成的代码只认「命名空间 + 方法名 + 位置参数」这一个形状，换传输、换网关
   * 都不用改生成的代码。
   */
  get invoke(): RemoteInvoker {
    return (namespace, method, args) => this.gateway.call(namespace, method, args)
  }

  /**
   * 断开连接。
   */
  close(): void {
    this.gateway.close()
  }
}
