/**
 * 模型看得见的那件工具：查这个运行时有什么。
 *
 * 只有「查」，没有「装」——装插件是人的动作。
 * @module @ryharness/extensions/tools
 */

import type { Tool } from '@ryharness/agent'
import { searchCatalog } from './catalog.ts'
import type { RuntimeCatalog } from './types.ts'

/** 工具名（宿主注册它时要与 `capabilities.tools` 逐字一致）。 */
export const RUNTIME_CATALOG_TOOL_NAME = 'runtime_catalog'

/**
 * 造 `runtime_catalog` 工具。
 *
 * 目录可以是**一份快照**，也可以是**一个取法**（每次调用现查）。运行时里插件的装卸
 * 是动态的，快照会过期——要现查就传函数。
 * @param catalog - 目录，或一个每次调用现取目录的函数。
 * @returns 工具。
 */
export function createRuntimeCatalogTool(catalog: RuntimeCatalog | (() => RuntimeCatalog)): Tool {
  const current = (): RuntimeCatalog => {
    return typeof catalog === 'function' ? catalog() : catalog
  }
  return {
    name: RUNTIME_CATALOG_TOOL_NAME,
    description:
      '查这个运行时有哪些能力：可用的工具、HTTP 接口与后台服务。不给关键词就给全部；带关键词只给命中的那些。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（按名字与说明匹配）。不给就是全部。' },
      },
    },
    async execute(args): Promise<{ content: string; isError?: boolean }> {
      const query =
        typeof args === 'object' && args !== null && typeof (args as { query?: unknown }).query === 'string'
          ? (args as { query: string }).query
          : ''
      const hits = searchCatalog(current(), query)
      const total = hits.tools.length + hits.routes.length + hits.services.length
      if (total === 0) {
        return { content: '没有匹配的能力。换个关键词，或者不给关键词看全部。' }
      }
      const lines: string[] = []
      if (hits.tools.length > 0) {
        lines.push(`工具（${hits.tools.length}）：`)
        for (const tool of hits.tools) lines.push(`- ${tool.name}：${tool.description}`)
      }
      if (hits.routes.length > 0) {
        lines.push(`接口（${hits.routes.length}）：`)
        for (const route of hits.routes) lines.push(`- ${route.method} ${route.pattern}`)
      }
      if (hits.services.length > 0) {
        lines.push(`服务（${hits.services.length}）：`)
        for (const service of hits.services) lines.push(`- ${service.name}：${service.description}`)
      }
      return { content: lines.join('\n') }
    },
  }
}
