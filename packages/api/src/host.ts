/**
 * 宿主侧：把本地对象按类型图暴露出去。
 *
 * 「挂载」是这一步的动作：交一个本地对象进来，宿主把它登记成一张表，之后
 * 客户端就能照着表调它。挂载与冲突检查都在**装配时**做——两个 remote 抢同
 * 一个名字，当场报错，不等谁去调。
 * @module @ryharness/api/host
 */

import {
  type RemoteBinding,
  RemoteGatewayServer,
  type RemoteMethodAnnotation,
  RemoteRegistry,
  type RpcTransport,
  type TypeGraph,
} from '@ryharness/typert-gateway'

/** 一个待挂载的本地对象。 */
export interface RemoteMount {
  /** 线上的命名空间。不给就问本地对象的 `typertRemote`。 */
  readonly namespace?: string
  /** 本地对象实例（带 `@Remote` 方法的那个）。 */
  readonly service: object
  /** 本地对象的标识，写进类型图给人看。 */
  readonly serviceKey?: string
  /** 方法签名注解，键是类里的方法名。 */
  readonly methods?: Readonly<Record<string, RemoteMethodAnnotation>>
}

/** 宿主的构造选项。 */
export interface RemoteHostOptions {
  /** 默认超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 出错时的旁路（记日志用）。 */
  readonly onError?: (error: unknown) => void
}

/**
 * 一个远程宿主。
 *
 * 宿主本身不关心连接怎么来——`serve()` 交给它一条传输，它就开始应答；连接是
 * TCP 还是管道还是内存对，宿主不管。
 */
export class RemoteHost {
  private readonly options: RemoteHostOptions
  private readonly mounts: RemoteMount[] = []
  private readonly servers = new Set<RemoteGatewayServer>()
  private registry = new RemoteRegistry({ bindings: [] })

  /**
   * @param options - 构造选项。
   */
  constructor(options: RemoteHostOptions = {}) {
    this.options = options
  }

  /**
   * 挂一个本地对象。
   *
   * 挂完立刻重建登记表：类型图变了，已经连着的客户端下次调用就能用上（服务
   * 端每次请求都重新看一眼登记表）。
   * @param mount - 待挂载的本地对象。
   */
  mount(mount: RemoteMount): void {
    this.mounts.push(mount)
    this.registry = new RemoteRegistry({ bindings: this.bindings() })
  }

  /** 宿主现在暴露了什么。 */
  get graph(): TypeGraph {
    return this.registry.graph
  }

  /**
   * 接一条连接，开始应答。
   * @param transport - 连接。
   */
  serve(transport: RpcTransport): void {
    const server = new RemoteGatewayServer({
      registry: () => this.registry,
      timeoutMs: this.options.timeoutMs,
      onError: (error) => this.options.onError?.(error),
    })
    this.servers.add(server)
    server.attach(transport)
  }

  /**
   * 断开所有连接。
   */
  close(): void {
    for (const server of [...this.servers]) server.close()
    this.servers.clear()
  }

  /**
   * 把挂载项转成登记表要的挂载项。
   * @returns 挂载项列表。
   */
  private bindings(): readonly RemoteBinding[] {
    return this.mounts.map((mount) => ({
      ...(mount.namespace === undefined ? {} : { namespace: mount.namespace }),
      service: mount.service,
      ...(mount.serviceKey === undefined ? {} : { serviceKey: mount.serviceKey }),
      ...(mount.methods === undefined ? {} : { methods: mount.methods }),
    }))
  }
}
