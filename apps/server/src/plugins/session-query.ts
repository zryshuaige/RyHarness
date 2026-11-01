/**
 * 内置插件：会话历史查询。
 *
 * 助理能翻自己的历史：搜关键词、按 id 读一条消息、追一条消息前后有什么关系。
 * 底座是 `@ryharness/session-query` 的查询服务——历史内容一律从
 * `@ryharness/session` 的会话库读，所以「搜出来的」与「模型看到的历史」是同一份。
 *
 * 服务由组合根创建并持有：查询服务持有搜索索引（内存倒排或 SQLite FTS5），
 * 索引要在进程里活着，插件每次装载都 new 一份会把索引清空——那不是插件该管的事。
 * @module @ryharness/server/plugins/session-query
 */

import { createSessionQueryTools, SESSION_QUERY_TOOL_NAMES, type SessionQueryService } from '@ryharness/session-query'
import type { PluginEntry } from './host.ts'

export const SESSION_QUERY_PLUGIN_ID = 'session-query'

/** 会话查询插件的依赖。 */
export interface SessionQueryPluginOptions {
  /**
   * 查询服务：由组合根创建并持有。
   *
   * 不在插件里 new 的原因同上：服务里有一份搜索索引，插件装载一次就重建一次索引，
   * 白白把已经建好的索引扔掉。
   */
  service: SessionQueryService
}

/** 会话查询插件入口：把三件工具注册进工具表。 */
export function sessionQueryPlugin(options: SessionQueryPluginOptions): PluginEntry {
  return {
    id: SESSION_QUERY_PLUGIN_ID,
    name: '会话历史查询',
    description: '让助理能查自己的历史：搜关键词、按 id 读一条消息、追一条消息前后有什么关系。',
    group: 'feature',
    capabilities: { tools: [...SESSION_QUERY_TOOL_NAMES] },
    impact: '关闭后助理不再能查会话历史（历史本身一条不少，重新打开就能接着查）。',
    inject: ['tools'],
    apply: (ctx) => {
      for (const tool of createSessionQueryTools(options.service)) ctx.tools.register(tool)
    },
  }
}
