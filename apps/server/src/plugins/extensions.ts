/**
 * 内置插件：运行时能力目录。
 *
 * 助理能查这个运行时到底有什么：可用的工具、HTTP 接口与后台服务。查的是**活的事实**
 * ——目录在每次调用时现查，不是启动时拍一张快照（那样插件后来装上的能力就查不到）。
 *
 * 这件工具**只读**：它不提供「让模型自己挂插件」的口子（那等于把宿主的能力面交给
 * 模型，而模型判断力不足以承担这个风险）。
 * @module @ryharness/server/plugins/extensions
 */

import type { Context } from '@ryharness/cordis'
import { buildCatalog, type CatalogRoute, type CatalogTool, createRuntimeCatalogTool } from '@ryharness/extensions'
import type { PluginEntry } from './host.ts'

export const EXTENSIONS_PLUGIN_ID = 'extensions'

/** 能力目录插件的依赖。 */
export interface ExtensionsPluginOptions {
  /** 后台服务清单（宿主给：这条进程里长期存在的能力）。 */
  readonly services?: ReadonlyArray<{ name: string; description: string }>
}

/**
 * 能力目录插件入口：一件 `runtime_catalog` 工具。
 *
 * 目录在调用时现查：插件的装卸是运行时的，快照会过期。
 */
export function extensionsPlugin(options: ExtensionsPluginOptions = {}): PluginEntry {
  return {
    id: EXTENSIONS_PLUGIN_ID,
    name: '运行时能力目录',
    description: '让助理能查这个运行时有哪些能力：工具、接口与服务；不知道工具叫什么时先查它。',
    group: 'feature',
    capabilities: {
      tools: ['runtime_catalog'],
    },
    impact: '关闭后助理不能再查运行时有哪些能力；工具清单本身一条不少，只是它得靠猜。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      ctx.tools.register(
        createRuntimeCatalogTool(() => {
          // 现查：插件的装卸是运行时的，目录是启动时拍一张就会过期。
          return buildCatalog({
            tools: ctx.tools.list().map((tool): CatalogTool => {
              return { name: tool.name, description: tool.description }
            }),
            routes: ctx.routes.list().map((route): CatalogRoute => {
              return { method: route.method, pattern: route.pattern }
            }),
            services: options.services ?? [],
          })
        }),
      )
    },
  }
}
