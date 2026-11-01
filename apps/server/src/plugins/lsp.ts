/**
 * 内置插件：代码导航（语言服务器）。
 *
 * 一件工具 `lsp`：跳定义、找引用、找实现、读 hover。
 *
 * 语言服务器**不随应用分发**——用户自己装（`typescript-language-server` 之类），
 * 插件按 `<dataDir>/config/lsp.json` 的配置把它们拉起来。没配就如实说「这个文件
 * 类型没有配语言服务器」，不用 grep 顶替：顶替的结果看着像答案，其实不是。
 * @module @ryharness/server/plugins/lsp
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import { LspService, type LspLocation, StdioLspProvider, type StdioLspProviderConfig } from '@ryharness/lsp'
import type { PluginEntry } from './host.ts'

export const LSP_PLUGIN_ID = 'lsp'

/** lsp 插件的依赖。 */
export interface LspPluginDeps {
  /** 数据目录：配置文件在 `<dataDir>/config/lsp.json`。 */
  dataDir: string
  /** 工作区根：语言服务器的工作目录与文件定位都以它为准。 */
  workspaceRoot: string
}

/** 配置文件里的一条语言服务器。 */
interface LspConfigFile {
  servers?: StdioLspProviderConfig[]
}

/**
 * 读语言服务器配置。
 *
 * 读不出来就是「没配」：插件照样装上（工具在），调用时给一句清楚的话。
 * @param dataDir - 数据目录。
 * @returns 语言服务器配置清单。
 */
export function readLspConfig(dataDir: string): StdioLspProviderConfig[] {
  const path = join(dataDir, 'config', 'lsp.json')
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const servers = (parsed as LspConfigFile).servers
    return Array.isArray(servers) ? servers : []
  } catch {
    return []
  }
}

/** 位置渲染成人看的「文件:行:列」（行列从 1 起，符合编辑器习惯）。 */
function renderLocation(location: LspLocation): string {
  return `${location.uri}:${location.line + 1}:${location.character + 1}`
}

/** 读参数：字符串字段。 */
function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 读参数：整数（行列从 0 起，模型传 1 起也行，这里减 1）。 */
function positionArg(args: unknown, key: string): number {
  if (typeof args !== 'object' || args === null) return 0
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value) - 1)
}

/**
 * 造 `lsp` 工具。
 * @param service - 语言服务器服务。
 * @returns 工具。
 */
export function createLspTool(service: LspService): Tool {
  return {
    name: 'lsp',
    description:
      '用语言服务器在代码里导航：跳定义、找引用、找实现、读 hover 文档。需要精确知道某个符号在哪、被谁用了时使用；只是找文件或搜文本用 fs_glob / fs_grep 更快。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['definition', 'references', 'implementations', 'hover'],
          description: 'definition 跳定义；references 找引用；implementations 找实现；hover 读文档。',
        },
        path: { type: 'string', description: '工作区内的源文件路径。' },
        line: { type: 'number', description: '行号（从 1 起）。' },
        character: { type: 'number', description: '列号（从 1 起）。' },
      },
      required: ['operation', 'path'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const operation = stringArg(args, 'operation')
      if (operation === undefined) {
        return { content: 'lsp：缺少 operation 参数。', isError: true }
      }
      const path = stringArg(args, 'path')
      if (path === undefined) {
        return { content: 'lsp：缺少 path 参数。', isError: true }
      }
      const position = { line: positionArg(args, 'line'), character: positionArg(args, 'character') }
      try {
        if (operation === 'definition') {
          const locations = await service.definition(path, position)
          return { content: renderLocations('定义', locations) }
        }
        if (operation === 'references') {
          const locations = await service.references(path, position)
          return { content: renderLocations('引用', locations) }
        }
        if (operation === 'implementations') {
          const locations = await service.implementations(path, position)
          return { content: renderLocations('实现', locations) }
        }
        if (operation === 'hover') {
          const hover = await service.hover(path, position)
          if (hover === undefined) return { content: '这个位置没有 hover 文档。' }
          return { content: hover.contents }
        }
        return { content: 'lsp：operation 只能是 definition / references / implementations / hover。', isError: true }
      } catch (error) {
        // 语言服务器的失败多半是「没装」「没配」这类环境问题：说清楚是什么问题，
        // 模型才知道该换个做法，而不是把它当成代码里没有这个东西。
        const message = error instanceof Error ? error.message : String(error)
        return { content: `lsp 失败：${message}`, isError: true }
      }
    },
  }
}

/** 位置清单的渲染。 */
function renderLocations(label: string, locations: readonly LspLocation[]): string {
  if (locations.length === 0) return `没有找到${label}。`
  return `${label}（${locations.length} 处）：\n${locations.map((location) => `- ${renderLocation(location)}`).join('\n')}`
}

/** lsp 插件入口：一件工具，随插件 fiber 装卸。 */
export function lspPlugin(deps: LspPluginDeps): PluginEntry {
  return {
    id: LSP_PLUGIN_ID,
    name: '代码导航',
    description:
      '让助理用语言服务器跳定义、找引用、读 hover；语言服务器要自己装并在 config/lsp.json 里配，没配时工具会直说。',
    group: 'feature',
    capabilities: {
      tools: ['lsp'],
    },
    impact: '关闭后助理不能再跳定义、找引用；已起的语言服务器进程会随插件一起收掉。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      const service = new LspService()
      for (const config of readLspConfig(deps.dataDir)) {
        service.register(
          new StdioLspProvider(config, {
            id: config.command,
            cwd: deps.workspaceRoot,
          }),
        )
      }
      ctx.tools.register(createLspTool(service))
      // 语言服务器是子进程：插件关掉时要把它们收干净。
      ctx.effect(() => {
        return () => {
          void service.dispose()
        }
      }, 'lsp.service')
    },
  }
}
