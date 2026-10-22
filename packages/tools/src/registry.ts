/**
 * 工具注册表：cordis 服务 `ctx.tools`，注册即 effect。
 *
 * 为什么要有它：工具此前是组合根里的一个常量数组，装完就无法增删。注册表把
 * 「有哪些工具」变成运行时事实——插件 apply 里 `ctx.tools.register(tool)`，插件
 * 卸载时 cordis 自动执行这里返回的 disposer，同名工具的归属也由注册表统一裁判。
 * @module @ryharness/tools/registry
 */

import type { Tool } from '@ryharness/agent'
import { type Context, Service } from '@ryharness/cordis'

declare module '@ryharness/cordis' {
  interface Context {
    /** 工具注册表（挂载方式：`await ctx.plugin(ToolRegistry)`）。 */
    tools: ToolRegistry
  }
}

/** cordis 服务名：装配层用 `ctx.tools` 取它。 */
const SERVICE_NAME = 'tools'

/**
 * 按名注册的工具表。
 *
 * 服务实例自身随插件 fiber 卸载而注销；每个工具的 disposer 也挂在注册表的
 * fiber 上，所以「卸插件 → 工具消失」是 cordis 的生命周期，不靠调用方记得清理。
 */
export class ToolRegistry extends Service {
  private readonly byName = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME)
  }

  /**
   * 注册一个工具，返回精确的注销函数。
   *
   * 重复同名直接抛错：后注册的静默覆盖会让模型调用到与 agent 白名单无关的实现，
   * 而错误信息里带上已有工具的来源提示，排查时不必猜是谁先占了这个名字。
   * @param tool - 实现 Tool 契约的工具（name 必须非空）。
   * @returns 只注销这一次注册的 disposer；重复调用是幂等的。
   */
  register(tool: Tool): () => void {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error('@ryharness/tools: a tool must have a non-empty name')
    }
    if (this.byName.has(tool.name)) {
      throw new Error(
        `@ryharness/tools: tool "${tool.name}" is already registered; ` +
          'unregister the previous one with the disposer returned by register() first',
      )
    }
    // 注册即 effect：disposer 归注册表所在的 fiber，插件卸载时 cordis 会逆序执行。
    const dispose = this.ctx.effect(() => {
      this.byName.set(tool.name, tool)
      return () => {
        // 只在仍是自己时删除：上一份同名注册的 disposer 若晚到，不能把新实例抹掉。
        if (this.byName.get(tool.name) === tool) this.byName.delete(tool.name)
      }
    }, `tools.register(${tool.name})`)
    return () => {
      // cordis 的 disposer 返回 Promise，注册表的契约是同步句柄；它本身幂等，
      // 这里丢弃已决议的 Promise 不会吞掉任何错误路径。
      void dispose()
    }
  }

  /** 当前注册的工具，按注册顺序（Map 插入序）。 */
  list(): readonly Tool[] {
    return [...this.byName.values()]
  }

  /** 按名取工具；未注册返回 undefined。 */
  get(name: string): Tool | undefined {
    return this.byName.get(name)
  }
}
