/**
 * 内置插件：文档转换（Office → PDF）。
 *
 * 一件工具 `document_convert`：把一份 Office 文件转成 PDF，落盘后给出路径。
 *
 * **引擎按本机有什么自动挑**（见 `@ryharness/document` 的
 * `createDocumentConverter`）：Windows 上装了 Office 就用 Word COM，装了
 * LibreOffice 就用 soffice，两个都没有时报「没装引擎」并说清该装什么——不是一句
 * 「转换失败」。
 *
 * **授权是硬边界**：工具的调用方必须显式说「这份文件有权转」。这个插件的
 * 工具**永远传 authorized: true**，因为它只接受**工作区内的路径**——路径本身
 * 就是授权（用户把文件放进工作区，或者明确让助理读它）。工作区外的路径会被
 * `resolveInWorkspace` 挡掉。
 *
 * PDF 落在 `<dataDir>/documents/`，不在系统临时目录里——临时目录会被清掉，
 * PDF 放那儿等于没放。
 * @module @ryharness/server/plugins/document
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import {
  createDocumentConverter,
  DocumentConversionService,
  type DocumentEngineInfo,
  type DocumentPolicy,
  detectDocumentEngine,
} from '@ryharness/document'
import { resolveInWorkspace } from '@ryharness/tools'
import { json } from '../router.ts'
import type { PluginEntry } from './host.ts'

export const DOCUMENT_PLUGIN_ID = 'document'

/** 文档插件的依赖。 */
export interface DocumentPluginDeps {
  /** 数据目录：PDF 落在 `<dataDir>/documents/`。 */
  readonly dataDir: string
  /** 工作区根：只能转工作区里的文件。 */
  readonly workspaceRoot: string
}

/** 配置文件里能放的东西。 */
export interface DocumentConfigFile {
  /** 输入字节上限。 */
  readonly maxInputBytes?: number
  /** 页数上限。 */
  readonly maxPages?: number
  /** 转换时限（毫秒）。 */
  readonly timeoutMs?: number
}

/**
 * 读文档配置。
 *
 * 读不出来就是「没配」：用包的默认边界。
 * @param dataDir - 数据目录。
 * @returns 文档配置。
 */
export function readDocumentConfig(dataDir: string): DocumentConfigFile {
  const path = join(dataDir, 'config', 'document.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as DocumentConfigFile
  } catch {
    return {}
  }
}

/** 读参数：字符串字段。 */
function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 造 `document_convert` 工具。
 *
 * 服务是**按需取**的（`getService`）：插件装载时不建服务、不探引擎——探测要起
 * 一个 PowerShell 进程，而宿主每起一个实例探一次就是几十次。
 * @param getService - 取转换服务的函数（第一次调用时才真正建）。
 * @param workspaceRoot - 工作区根。
 * @returns 工具。
 */
export function createDocumentConvertTool(getService: () => DocumentConversionService, workspaceRoot: string): Tool {
  return {
    name: 'document_convert',
    description:
      '把工作区里的一份 Office 文件（docx / xlsx / pptx / odt / rtf 等）转成 PDF，转完给出 PDF 的路径。需要本机装了 Microsoft Word 或 LibreOffice。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的文件路径（相对工作区根或工作区内的绝对路径）。' },
      },
      required: ['path'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const path = stringArg(args, 'path')
      if (path === undefined) {
        return { content: 'document_convert：缺少 path 参数。', isError: true }
      }
      let absolute: string
      try {
        absolute = resolveInWorkspace(workspaceRoot, path)
      } catch {
        return { content: `document_convert：这个路径在工作区外（${path}），不转。`, isError: true }
      }
      if (!existsSync(absolute)) {
        return { content: `document_convert：工作区里没有这个文件（${path}）。`, isError: true }
      }
      try {
        const bytes = await readFile(absolute)
        const outcome = await getService().convert({
          source: { bytes, mediaType: 'application/octet-stream', name: absolute },
          // 路径在工作区内 = 用户授权：工具不接受工作区外的任何路径。
          authorized: true,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
        return {
          content: JSON.stringify({
            ok: true,
            pdfPath: outcome.path,
            pages: outcome.pages,
            fromCache: outcome.fromCache,
            bytes: outcome.pdf.byteLength,
          }),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: `document_convert 失败：${message}`, isError: true }
      }
    },
  }
}

/** 文档插件入口：一件工具，随插件 fiber 装卸。 */
export function documentPlugin(deps: DocumentPluginDeps): PluginEntry {
  return {
    id: DOCUMENT_PLUGIN_ID,
    name: '文档转换',
    description:
      '让助理把 Office 文件转成 PDF。用本机的 Microsoft Word 或 LibreOffice；两个都没装时工具会直说该装什么。',
    group: 'feature',
    capabilities: {
      tools: ['document_convert'],
      routes: ['GET /api/document/engines'],
    },
    impact: '关闭后助理不能再转文档；已转好的 PDF 留在磁盘上，不会被删掉。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      const config = readDocumentConfig(deps.dataDir)
      const policy: Partial<DocumentPolicy> = {
        ...(config.maxInputBytes === undefined ? {} : { maxInputBytes: config.maxInputBytes }),
        ...(config.maxPages === undefined ? {} : { maxPages: config.maxPages }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      }
      /**
       * 转换器**惰性创建**。
       *
       * 探测引擎要起一个 PowerShell 进程，插件装载时探一次看起来不多——但宿主
       * 每起一个实例就探一次，一轮测试几十个实例就是几十次探测。更糟的是早先
       * 那版探测会真的启一个 Word 进程，于是一轮测试能漏几十个 Word，用户的
       * 桌面上开出一堆 Word 窗口。
       *
       * 所以这里**不在装载时探**：真正要转文档时才探（探一次之后有缓存），
       * 界面那条路由被调时才探。
       */
      let service: DocumentConversionService | undefined
      const getService = (): DocumentConversionService => {
        if (service === undefined) {
          service = new DocumentConversionService({
            converter: createDocumentConverter(),
            outputDir: join(deps.dataDir, 'documents'),
            policy,
          })
        }
        return service
      }
      ctx.tools.register(createDocumentConvertTool(() => getService(), deps.workspaceRoot))
      // 引擎状态：界面上要能告诉用户「现在能不能转」，而不是让人装好之后
      // 才发现工具还是报错。这条路由被调时才探（探测结果有缓存）。
      ctx.routes.register('GET', '/api/document/engines', async (_req, res) => {
        const engine: DocumentEngineInfo = detectDocumentEngine()
        json(res, 200, { engine })
      })
    },
  }
}
