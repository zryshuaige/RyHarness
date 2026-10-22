/**
 * 插件路由注册表：cordis 服务 `ctx.routes`，注册即 effect。
 *
 * 路由此前只能在组合根里写死，插件无法自己提供 HTTP 面。这里把「有哪些插件路由」
 * 变成运行时事实：插件 apply 里 `ctx.routes.register(method, pattern, handler)`，
 * 卸载时 cordis 执行 effect 的清理函数，路由从所有已挂载的 Router 上一起撤掉。
 * 组合根先装核心路由、再 {@link RouteRegistry.attach} 本注册表，因此核心路径同样
 * 参与冲突判定——后注册的一方必须显式报错，不能静默覆盖。
 * @module @ryharness/server/plugins/routes
 */

import { type Context, Service } from '@ryharness/cordis'
import { duplicateRouteError, type Handler, type Router, routeTarget } from '../router.ts'

declare module '@ryharness/cordis' {
  interface Context {
    /** 插件路由注册表（挂载方式：`await ctx.plugin(RouteRegistry)`）。 */
    routes: RouteRegistry
  }
}

/** cordis 服务名。 */
const SERVICE_NAME = 'routes'

/** `list()` 暴露的一条路由（不暴露内部注销句柄）。 */
export interface RegisteredRoute {
  readonly method: string
  readonly pattern: string
  readonly handler: Handler
}

interface RouteRecord extends RegisteredRoute {
  readonly key: string
  /** 已经装上这条路由的 Router 及各自的注销函数。 */
  readonly removers: Map<Router, () => void>
}

/**
 * 插件路由注册表。
 *
 * 路由的 effect 归属**调用方插件**的 fiber（`ctx.routes.register` 经 cordis 的
 * traceable 代理转调，`this.ctx` 就是调用方上下文），所以插件卸载时清理函数会
 * 自动执行；注册表只负责把「当前有哪些 Route」与各个 Router 的增删对齐。
 */
export class RouteRegistry extends Service {
  private readonly records = new Map<string, RouteRecord>()
  private readonly routers = new Set<Router>()

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME)
    // 注册表自身被卸载时（停机、替换实现）也要把已经装到 Router 上的路由带走，
    // 否则那些 handler 会留在一个已经没有对应插件的进程里。
    this.ctx.effect(() => {
      return () => {
        for (const record of this.records.values()) {
          for (const remove of record.removers.values()) remove()
          record.removers.clear()
        }
        this.records.clear()
        this.routers.clear()
      }
    }, 'routes.registry')
  }

  /**
   * 注册一条插件路由，返回精确的注销函数。
   *
   * 同 method + pattern 在注册表内、或与核心/已挂载路由撞车时立刻抛错：静默覆盖
   * 会让「设置页关掉插件后 404」变成不可预测的一边赢，排查时也看不出是谁占了路径。
   * @param method - HTTP 方法（大小写不敏感）。
   * @param pattern - 路径模式。
   * @param handler - 处理函数。
   * @returns 只注销这一次注册的函数；重复调用幂等。
   */
  register(method: string, pattern: string, handler: Handler): () => void {
    const target = routeTarget(method, pattern)
    if (this.records.has(target.key)) throw duplicateRouteError(target.method, target.pattern)
    for (const router of this.routers) {
      if (router.has(target.method, target.pattern)) throw duplicateRouteError(target.method, target.pattern)
    }
    const dispose = this.ctx.effect(() => {
      const record: RouteRecord = {
        method: target.method,
        pattern: target.pattern,
        handler,
        key: target.key,
        removers: new Map(),
      }
      // 先对所有已接 Router 做完整冲突检查，再统一落表：第二个 Router 撞车时
      // 不能让第一个已经挂上、留下半套路由。
      for (const router of this.routers) {
        if (router.has(target.method, target.pattern)) {
          throw duplicateRouteError(target.method, target.pattern)
        }
      }
      this.records.set(target.key, record)
      for (const router of this.routers) {
        record.removers.set(router, router.add(target.method, target.pattern, handler))
      }
      return () => {
        // 只在仍是自己时删除：同名路由若被新一次注册接替，旧清理不能把新的抹掉。
        if (this.records.get(target.key) === record) this.records.delete(target.key)
        for (const remove of record.removers.values()) remove()
        record.removers.clear()
      }
    }, `routes.register(${target.method} ${target.pattern})`)
    return () => {
      void dispose()
    }
  }

  /** 当前注册的插件路由，按注册顺序。 */
  list(): readonly RegisteredRoute[] {
    return [...this.records.values()].map((record) => {
      return { method: record.method, pattern: record.pattern, handler: record.handler }
    })
  }

  /**
   * 把注册表接到一个已装好核心路由的 Router 上。
   *
   * 先对全部既有路由做冲突检查再落表：中途失败不会留下半套路由。之后的新注册
   * 由 {@link register} 同步到每个已接的 Router；Router 生命周期与进程一致，
   * 因此这里不返回解绑函数。
   * @param router - 已经注册完核心路由的实例。
   */
  attach(router: Router): void {
    for (const record of this.records.values()) {
      if (router.has(record.method, record.pattern)) {
        throw duplicateRouteError(record.method, record.pattern)
      }
    }
    const added: (() => void)[] = []
    try {
      for (const record of this.records.values()) {
        const remove = router.add(record.method, record.pattern, record.handler)
        record.removers.set(router, remove)
        added.push(remove)
      }
    } catch (error) {
      for (const remove of added) remove()
      throw error
    }
    this.routers.add(router)
  }
}
