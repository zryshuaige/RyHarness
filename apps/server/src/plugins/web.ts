/**
 * 内置插件：搜索与抓网页。
 *
 * 两件工具：
 * - `web_search`：让助理能「查一下」。需要一个搜索后端——后端没配时工具仍然在，
 *   但调用会明确告诉人「还没配后端、去哪儿配」，而不是假装搜过了。
 * - `web_fetch`：抓一个 URL 转成可读文字。边界与 `read_url` 同一口径（只允许
 *   http/https、拦本机与内网、逐跳重定向重新校验、连接钉在已校验的地址上）。
 *
 * 配置读 `<dataDir>/config/web.json`（形状见 `@ryharness/web` 的 `WebConfig`）。
 * @module @ryharness/server/plugins/web
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import { type WebConfig, createWebFetchTool, createWebSearchTool } from '@ryharness/web'
import type { PluginEntry } from './host.ts'

export const WEB_PLUGIN_ID = 'web'

/** web 插件的依赖。 */
export interface WebPluginDeps {
  /** 数据目录：配置文件在 `<dataDir>/config/web.json`。 */
  dataDir: string
}

/**
 * 读 web 配置。
 *
 * 配置文件不存在或坏掉都**不抛**：搜索后端是可选增强，配置坏了不该让整个服务端
 * 起不来。读不出来就用空配置（抓网页照常能用，只是搜索会说「还没配后端」）。
 * @param dataDir - 数据目录。
 * @returns web 配置（读不出来时是空对象）。
 */
export function readWebConfig(dataDir: string): WebConfig {
  const path = join(dataDir, 'config', 'web.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as WebConfig
  } catch {
    return {}
  }
}

/** web 插件入口：两件工具，随插件 fiber 装卸。 */
export function webPlugin(deps: WebPluginDeps): PluginEntry {
  return {
    id: WEB_PLUGIN_ID,
    name: '搜索与抓网页',
    description:
      '让助理能上网查资料、把网页抓成正文；搜索需要一个后端（在 config/web.json 里配），抓网页不需要额外配置。',
    group: 'feature',
    capabilities: {
      tools: ['web_search', 'web_fetch'],
    },
    impact: '关闭后助理既不能搜索也不能读网页；已配置的搜索后端保留在文件里，重新打开即可用。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      const config = readWebConfig(deps.dataDir)
      ctx.tools.register(createWebSearchTool(config))
      ctx.tools.register(createWebFetchTool(config))
    },
  }
}
