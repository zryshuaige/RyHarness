/**
 * 三个模型可见的工具：`browser_open` / `browser_act` / `browser_read`。
 *
 * 工具这一层只做三件事：把模型给的参数读出来、调用会话服务、把结果与错误整成
 * `{ content, isError }` 的形状。所有边界判定都在服务那边，工具层不重复实现
 * 一遍——同一个地址在两条路上必须得到同一个答案。
 *
 * 工具的形状（name / description / parameters / execute）与 `@ryharness/agent` 的
 * `Tool` 结构兼容，宿主可以直接 `ctx.tools.register(tool)`；本包不引那个依赖，
 * 是为了能单独安装、单独测试。
 * @module @ryharness/browser-use/tools
 */

import { BrowserUseError } from './errors.ts'
import type {
  BrowserActionKind,
  BrowserOwner,
  BrowserTool,
  BrowserToolContext,
  BrowserToolResult,
  BrowserToolSession,
} from './types.ts'

/** 工具的构造参数。 */
export interface BrowserToolsOptions {
  /** 会话归属者取不到时的兜底归属者。默认 `'default'`。 */
  readonly defaultOwner?: string
  /** 截图超过这个字节数就不内联进工具结果（避免把模型上下文撑爆）。默认 2MB。 */
  readonly maxInlineScreenshotBytes?: number
}

/** 默认内联截图上限。 */
const DEFAULT_MAX_INLINE_SCREENSHOT_BYTES = 2 * 1024 * 1024

/** 读一个字符串参数；缺了或不是非空字符串就返回 undefined。 */
function readStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 这次调用归谁：上下文里的 owner 优先，否则用兜底值。 */
function ownerOf(ctx: BrowserToolContext | undefined, fallback: string): BrowserOwner {
  const owner = ctx?.owner
  return owner === undefined || owner.length === 0 ? fallback : owner
}

/**
 * 把异常整成给模型看的错误结果。
 *
 * 我们自己写的错误（{@link BrowserUseError}）消息就是中文，直接给模型；底下
 * 冒出来的意外异常只回一句中文摘要——模型不需要看到 socket hang up 这种东西。
 */
function toErrorResult(error: unknown): BrowserToolResult {
  if (error instanceof BrowserUseError) return { content: error.message, isError: true }
  return { content: 'browser-use: 操作失败：内部错误', isError: true }
}

/**
 * 造 `browser_open`：开一个会话并打开第一个标签页。
 * @param service - 会话服务。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createBrowserOpenTool(service: BrowserToolSession, options: BrowserToolsOptions = {}): BrowserTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'browser_open',
    description: '打开一个网页（http/https），返回会话 id 与当前页面地址。默认不访问本机与内网地址。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 http/https 链接。' },
      },
      required: ['url'],
    },
    execute: async (args, ctx) => {
      const url = readStringArg(args, 'url')
      if (url === undefined) return { content: 'url 是必填的，且必须是非空字符串。', isError: true }
      try {
        const session = await service.open(ownerOf(ctx, fallback), url)
        return { content: JSON.stringify({ sessionId: session.id, url, tabs: session.tabs }) }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `browser_act`：做一次动作（点、输入、提交表单、下载文件）。
 *
 * **提交表单与下载文件默认是关着的**，调用会明确告诉模型「这一步没放行」，
 * 而不是偷偷做掉。
 * @param service - 会话服务。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createBrowserActTool(service: BrowserToolSession, options: BrowserToolsOptions = {}): BrowserTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'browser_act',
    description:
      '在已打开的网页上做一件事：click（点元素）、type（输入文字）、submit（提交表单）、download（下载文件）。' +
      '提交表单与下载文件默认关闭，需要宿主放行。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'browser_open 返回的会话 id。' },
        action: {
          type: 'string',
          enum: ['click', 'type', 'submit', 'download'],
          description: '要做的事。',
        },
        selector: { type: 'string', description: '目标元素的 CSS 选择器（click/submit/download 要填）。' },
        text: { type: 'string', description: '要输入的文字（type 要填）。' },
      },
      required: ['sessionId', 'action'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) {
        return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      }
      const action = readStringArg(args, 'action')
      if (action === undefined || !isActionKind(action)) {
        return { content: 'action 必须是 click / type / submit / download 之一。', isError: true }
      }
      const selector = readStringArg(args, 'selector')
      const text = readStringArg(args, 'text')
      try {
        await service.act(ownerOf(ctx, fallback), sessionId, {
          kind: action,
          ...(selector === undefined ? {} : { selector }),
          ...(text === undefined ? {} : { text }),
        })
        return { content: JSON.stringify({ ok: true, action, sessionId }) }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `browser_read`：读当前页面正文，或截当前页面的图。
 *
 * 截图以 data URL 的形式回给模型（宿主也可以直接拿服务层的字节自己展示）。
 * 超过上限时不内联，只回一句说明——把几兆字节塞进上下文是帮倒忙。
 * @param service - 会话服务。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createBrowserReadTool(service: BrowserToolSession, options: BrowserToolsOptions = {}): BrowserTool {
  const fallback = options.defaultOwner ?? 'default'
  const maxInline = options.maxInlineScreenshotBytes ?? DEFAULT_MAX_INLINE_SCREENSHOT_BYTES
  return {
    name: 'browser_read',
    description: '读当前网页的正文文本，或截当前网页的图。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'browser_open 返回的会话 id。' },
        kind: {
          type: 'string',
          enum: ['text', 'screenshot'],
          description: '读正文（text）还是截图（screenshot）。默认 text。',
        },
      },
      required: ['sessionId'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) {
        return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      }
      const kind = readStringArg(args, 'kind') ?? 'text'
      if (kind !== 'text' && kind !== 'screenshot') {
        return { content: 'kind 必须是 text 或 screenshot。', isError: true }
      }
      try {
        const result = await service.read(ownerOf(ctx, fallback), sessionId, kind)
        if (result.kind === 'text') {
          return { content: JSON.stringify({ kind: 'text', text: result.text }) }
        }
        const bytes = result.bytes.byteLength
        if (bytes > maxInline) {
          return {
            content: JSON.stringify({
              kind: 'screenshot',
              mimeType: result.mimeType,
              bytes,
              inline: false,
              note: `截图有 ${bytes} 字节，超过内联上限 ${maxInline}，没有放进工具结果。`,
            }),
          }
        }
        const base64 = Buffer.from(result.bytes).toString('base64')
        return {
          content: JSON.stringify({
            kind: 'screenshot',
            mimeType: result.mimeType,
            bytes,
            inline: true,
            dataUrl: `data:${result.mimeType};base64,${base64}`,
          }),
        }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造齐三个工具。
 * @param service - 会话服务。
 * @param options - 工具选项。
 * @returns 工具数组。
 */
export function createBrowserTools(service: BrowserToolSession, options: BrowserToolsOptions = {}): BrowserTool[] {
  return [
    createBrowserOpenTool(service, options),
    createBrowserActTool(service, options),
    createBrowserReadTool(service, options),
  ]
}

/** 这个字符串是不是一个动作种类。 */
function isActionKind(value: string): value is BrowserActionKind {
  return value === 'click' || value === 'type' || value === 'submit' || value === 'download'
}
