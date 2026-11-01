/**
 * 两个模型可见的工具：`web_search` 与 `web_fetch`。
 *
 * 工具这一层只做三件事：把模型给的参数读出来、调用上面那些纯函数、把结果与错误
 * 整成 `{ content, isError }` 的形状。所有边界判定都在纯函数那边，工具层不重复
 * 实现一遍——同一个 URL 在两条路上必须得到同一个答案。
 *
 * 工具的形状（name / description / parameters / execute）与 `@ryharness/agent` 的
 * `Tool` 结构兼容，宿主可以直接 `ctx.tools.register(tool)`；本包不引那个依赖，
 * 是为了能单独安装、单独测试。
 * @module @ryharness/web/tools
 */

import { webFetch } from './fetch.ts'
import type { HostResolver } from './guard.ts'
import type { PinnedFetch } from './http.ts'
import { isRecord } from './parse.ts'
import { webSearch } from './search.ts'
import { type WebConfig, WebError, type WebToolResult } from './types.ts'

/** 工具执行上下文。 */
export interface WebToolContext {
  /** 调用方的取消信号。 */
  signal?: AbortSignal
}

/** 一个 web 工具。 */
export interface WebTool {
  /** 工具名：模型按这个名字调用。 */
  name: string
  /** 给模型看的说明。 */
  description: string
  /** 入参的 JSON Schema。 */
  parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: WebToolContext): Promise<WebToolResult>
}

/** 宿主可以注入的东西：取回器与解析器（测试用替身，生产用默认值）。 */
export interface WebDeps {
  /** 取回器。 */
  fetchImpl?: PinnedFetch
  /** 主机名解析器。 */
  resolveHost?: HostResolver
}

/** 读一个字符串参数；缺了或不是非空字符串就返回 undefined。 */
function readStringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) return undefined
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 把异常整成给模型看的错误结果。
 *
 * 我们自己写的错误（{@link WebError}）消息就是中文，直接给模型；底下冒出来的意外
 * 异常只回一句中文摘要，原始异常留在 cause 里给宿主记日志——模型不需要看到
 * socket hang up 这种东西，也省得它把报错当成网页内容继续推理。
 */
function toErrorResult(error: unknown): WebToolResult {
  if (error instanceof WebError) return { content: error.message, isError: true }
  return { content: '请求失败：网络异常或内部错误', isError: true }
}

/**
 * 造出 `web_search` 工具。
 * @param config - web 配置；里面的 search 段决定用哪个后端。
 * @param deps - 可注入的取回器与解析器。
 * @returns 工具。
 */
export function createWebSearchTool(config: WebConfig, deps: WebDeps = {}): WebTool {
  return {
    name: 'web_search',
    description:
      '在互联网上搜索，返回若干条结果（标题、链接、摘要）。要查资料、找新闻、确认一个事实或找官方文档时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，用一句话说清要找什么。' },
      },
      required: ['query'],
    },
    execute: async (args, ctx) => {
      const query = readStringArg(args, 'query')
      if (query === undefined) return { content: 'query 是必填的，且必须是非空字符串。', isError: true }
      const search = config.search
      if (search === undefined) return { content: '没有配置搜索后端，搜索不可用。', isError: true }
      try {
        const results = await webSearch(search, query, { ...deps, signal: ctx?.signal })
        return { content: JSON.stringify({ query, results }) }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造出 `web_fetch` 工具。
 * @param config - web 配置；里面的 fetch 段是超时与限额。
 * @param deps - 可注入的取回器与解析器。
 * @returns 工具。
 */
export function createWebFetchTool(config: WebConfig, deps: WebDeps = {}): WebTool {
  return {
    name: 'web_fetch',
    description:
      '读取一个网页并返回正文文本（自动去掉脚本、样式与导航）。只支持 http/https，拒绝本机与内网地址；内容过长会截断。需要看网页上的具体内容时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的完整 http/https 链接。' },
      },
      required: ['url'],
    },
    execute: async (args, ctx) => {
      const url = readStringArg(args, 'url')
      if (url === undefined) return { content: 'url 是必填的，且必须是非空字符串。', isError: true }
      try {
        const page = await webFetch(url, { ...deps, ...config.fetch, signal: ctx?.signal })
        return { content: JSON.stringify(page) }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}
