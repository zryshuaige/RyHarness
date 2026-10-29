/**
 * 内置插件：MCP 外部工具。
 *
 * 连接外部 MCP server，把它们的工具接进助理的工具箱——这是 dsh 那边的 `mcp-client`：
 * 配置里写几行（哪个可执行文件、什么参数），server 提供的工具就出现在这里。
 *
 * 连接失败**不挂掉整个插件**：一个 server 起不来（可执行文件没装、参数写错）不该
 * 让其余 server 的工具也用不了，失败原因记进日志并在插件页上看得见。
 * @module @ryharness/server/plugins/mcp
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import { McpClientRegistry, type McpConfig } from '@ryharness/mcp'
import type { PluginEntry } from './host.ts'

export const MCP_PLUGIN_ID = 'mcp'

/** MCP 配置文件的落点（用户可手改）。 */
export const MCP_CONFIG_FILE = join('config', 'mcp-servers.json')

/**
 * 读 MCP 配置。
 *
 * 文件不存在是常态（用户还没配），返回空配置而不是报错。坏文件也按空配置处理：
 * 一个手写坏了的 JSON 不该让整个应用起不来。
 * @param dataDir - 数据目录。
 * @returns 配置（永远有值）。
 */
export function readMcpConfig(dataDir: string): McpConfig {
  try {
    const raw = readFileSync(join(dataDir, MCP_CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { servers?: unknown }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.servers !== 'object' ||
      parsed.servers === null
    ) {
      return { servers: {} }
    }
    return { servers: parsed.servers as McpConfig['servers'] }
  } catch {
    return { servers: {} }
  }
}

/** MCP 插件的依赖。 */
export interface McpPluginOptions {
  /** 数据目录（配置文件在这儿）。 */
  dataDir: string
  /** server 子进程的工作目录；缺省用工作区。 */
  cwd?: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
}

/** MCP 插件入口：把外部 server 的工具注册进工具表。 */
export function mcpPlugin(options: McpPluginOptions): PluginEntry {
  return {
    id: MCP_PLUGIN_ID,
    name: 'MCP 外部工具',
    description: '连接外部 MCP server，把它们提供的工具接进助理的工具箱。',
    group: 'tool',
    impact: '关闭后这些外部工具会消失，其余能力不受影响；配置与已连上的 server 不受影响。',
    inject: ['tools'],
    apply: async (ctx: Context) => {
      const config = readMcpConfig(options.dataDir)
      const serverNames = Object.keys(config.servers)
      if (serverNames.length === 0) return
      const registry = new McpClientRegistry({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      registry.registerAll(config)
      const report = await registry.connectAll()
      for (const failure of report.failed) {
        console.warn(`@ryharness/server: MCP server「${failure.server}」连不上：${failure.reason}`)
      }
      for (const tool of registry.tools()) ctx.tools.register(tool)
      // 子进程要收干净：工具注册随 fiber 消失，进程不会自己消失。
      ctx.effect(() => {
        return () => {
          void registry.close()
        }
      }, 'mcp.registry')
    },
  }
}
