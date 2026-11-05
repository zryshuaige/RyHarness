/**
 * 内置插件：浏览器自动化。
 *
 * 三件工具：
 * - `browser_open`：开一个网页，返回会话 id；
 * - `browser_act`：在已打开的网页上点、输入、提交表单、下载文件；
 * - `browser_read`：读当前页面的正文，或截当前页面的图。
 *
 * **驱动是本机已装的 Edge / Chrome**（走 CDP，不下载浏览器二进制）。没装浏览器时
 * 工具照样在，调用会得到一句「本机没找到 Edge 或 Chrome」的结构化错误，而不是
 * 假装操作成功。
 *
 * **边界（与 `@ryharness/browser-use` 的包内口径一致）**：只允许 http/https；
 * 默认不去本机与内网地址；默认不自动提交表单、不自动下载文件——这三条要宿主
 * 显式放行，配置在 `<dataDir>/config/browser.json`。
 *
 * 会话按助理 id 归属：另一个助理拿同一个会话 id 也碰不到它。
 * @module @ryharness/server/plugins/browser
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import {
  BrowserSessionService,
  type BrowserTool,
  type BrowserToolSession,
  createBrowserTools,
  createCdpDriverFactory,
  findBrowserExecutable,
} from '@ryharness/browser-use'
import type { Context } from '@ryharness/cordis'
import { json } from '../router.ts'
import type { PluginEntry } from './host.ts'

export const BROWSER_PLUGIN_ID = 'browser'

/** 浏览器插件的依赖。 */
export interface BrowserPluginDeps {
  /** 数据目录：配置文件在 `<dataDir>/config/browser.json`。 */
  readonly dataDir: string
}

/** 配置文件里能放的东西。 */
export interface BrowserConfigFile {
  /** 浏览器可执行文件路径；缺省按平台找，也认 `RYHARNESS_BROWSER_PATH`。 */
  readonly executablePath?: string
  /** 要不要开无头窗口。默认 true。 */
  readonly headless?: boolean
  /** 允许访问本机与内网地址。默认 false。 */
  readonly allowPrivateNetwork?: boolean
  /** 允许自动提交表单。默认 false。 */
  readonly allowFormSubmit?: boolean
  /** 允许自动下载文件。默认 false。 */
  readonly allowDownload?: boolean
}

/**
 * 读浏览器配置。
 *
 * 读不出来就是「没配」：插件照样装上（工具在），调用时给一句清楚的话。
 * @param dataDir - 数据目录。
 * @returns 浏览器配置。
 */
export function readBrowserConfig(dataDir: string): BrowserConfigFile {
  const path = join(dataDir, 'config', 'browser.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as BrowserConfigFile
  } catch {
    return {}
  }
}

/**
 * 这个会话归谁。
 *
 * 按助理 id 分：另一个助理拿同一个会话 id 也碰不到它。
 * @param ctx - 工具上下文。
 * @returns owner。
 */
function ownerOf(ctx: ToolContext): string {
  return ctx.agentId ?? ctx.conversationId ?? 'local'
}

/**
 * 把 browser-use 的工具形状套成 agent 的工具形状。
 *
 * 两边本来就兼容（name / description / parameters / execute），差的是**上下文**：
 * agent 的 `ToolContext` 里没有 `owner`，而 browser 的工具靠它做会话隔离。所以
 * 这里把 owner 从 agent 的上下文里取出来塞进去。
 * @param tool - browser-use 的工具。
 * @returns agent 的工具。
 */
function adaptTool(tool: BrowserTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(args, { owner: ownerOf(ctx), signal: ctx.signal })
      return { content: result.content, ...(result.isError === undefined ? {} : { isError: result.isError }) }
    },
  }
}

/** 浏览器插件入口：三件工具，随插件 fiber 装卸。 */
export function browserPlugin(deps: BrowserPluginDeps): PluginEntry {
  return {
    id: BROWSER_PLUGIN_ID,
    name: '浏览器自动化',
    description:
      '让助理开网页、点按钮、读页面内容。用本机已装的 Edge / Chrome（不下载浏览器）；默认不去本机与内网地址，也不自动提交表单或下载文件。',
    group: 'feature',
    capabilities: {
      tools: ['browser_open', 'browser_act', 'browser_read'],
      routes: ['GET /api/browser/sessions'],
    },
    impact: '关闭后助理不能再开网页、点东西；已开的浏览器会话与浏览器进程会立刻被收掉。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      const config = readBrowserConfig(deps.dataDir)
      const factory = createCdpDriverFactory({
        ...(config.executablePath === undefined ? {} : { executablePath: config.executablePath }),
        ...(config.headless === undefined ? {} : { headless: config.headless }),
      })
      const service = new BrowserSessionService({
        driverFactory: factory.driverFactory,
        policy: {
          allowPrivateNetwork: config.allowPrivateNetwork ?? false,
          allowFormSubmit: config.allowFormSubmit ?? false,
          allowDownload: config.allowDownload ?? false,
        },
      })
      const session: BrowserToolSession = service
      for (const tool of createBrowserTools(session)) {
        ctx.tools.register(adaptTool(tool))
      }
      // 会话视图：让界面能看见「现在开着哪些页」，也能手动关掉。
      ctx.routes.register('GET', '/api/browser/sessions', async (req, res) => {
        const owner = req.query.get('owner')
        const sessions = owner === null ? [] : service.list(owner)
        json(res, 200, { sessions })
      })
      // 浏览器进程是活的：插件关掉时必须收干净，不然用户机器上会留一堆 headless 浏览器。
      ctx.effect(() => {
        return async () => {
          try {
            await service.disposeAll()
          } catch {
            // 关不干净的会话由服务记下原因；卸载不能因为它失败。
          }
          await factory.close()
        }
      }, 'browser.service')
    },
  }
}

/**
 * 本机有没有能用的浏览器。
 *
 * 给设置页用：界面上要能告诉用户「现在能不能开网页」，而不是让人装好之后
 * 才发现工具还是报错。
 * @returns 找到的浏览器路径；没找到是 undefined。
 */
export function detectBrowserExecutable(): string | undefined {
  return findBrowserExecutable()
}
