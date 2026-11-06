/**
 * 五个模型可见的工具：`computer_screenshot` / `computer_click` / `computer_type` /
 * `computer_key` / `computer_scroll`。
 *
 * 与 browser-use 的工具层是同一套骨架：把模型给的参数读出来、调会话服务、把
 * 结果与错误整成 `{ content, isError }` 的形状。**所有边界判定都在服务那边**
 * （高危动作要人点头、截图要不要允许），工具层不重复实现一遍——同一个动作在
 * 两条路上必须得到同一个答案。
 *
 * 形状（name / description / parameters / execute）与 `@ryharness/agent` 的 `Tool`
 * 兼容，宿主可以直接注册进自己的工具表；本包不引那个依赖，是为了能单独安装、
 * 单独测试。
 *
 * @module @ryharness/computer-use/tools
 */

import { ComputerUseError } from './errors.ts'
import type {
  ComputerOwner,
  ComputerScreenshot,
  ComputerTool,
  ComputerToolContext,
  ComputerToolResult,
  ComputerToolSession,
} from './types.ts'

/** 工具的构造参数。 */
export interface ComputerToolsOptions {
  /** 会话归属者取不到时的兜底归属者。默认 `'default'`。 */
  readonly defaultOwner?: string
  /** 截图超过这个字节数就不内联进工具结果。默认 2MB。 */
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

/** 读一个数字参数；缺了或不是有限数就返回 undefined。 */
function readNumberArg(args: unknown, key: string): number | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/** 这次调用归谁：上下文里的 owner 优先，否则用兜底值。 */
function ownerOf(ctx: ComputerToolContext | undefined, fallback: ComputerOwner): ComputerOwner {
  const owner = ctx?.owner
  return owner === undefined || owner.length === 0 ? fallback : owner
}

/** 把异常整成给模型看的错误结果。 */
function toErrorResult(error: unknown): ComputerToolResult {
  if (error instanceof ComputerUseError) return { content: error.message, isError: true }
  if (error instanceof Error) return { content: `computer-use: 操作失败：${error.message}`, isError: true }
  return { content: 'computer-use: 操作失败：内部错误', isError: true }
}

/**
 * 造 `computer_screenshot`：截当前屏幕。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createComputerScreenshotTool(
  session: ComputerToolSession,
  options: ComputerToolsOptions = {},
): ComputerTool {
  const fallback = options.defaultOwner ?? 'default'
  const maxInline = options.maxInlineScreenshotBytes ?? DEFAULT_MAX_INLINE_SCREENSHOT_BYTES
  return {
    name: 'computer_screenshot',
    description:
      '截当前屏幕的图。**截图里可能有个人信息**（邮件、聊天记录、密码提示都在里面），所以只在真的需要看屏幕时才用。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（computer_open 返回的）。' },
      },
      required: ['sessionId'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      try {
        const shot = await session.screenshot(ownerOf(ctx, fallback), sessionId)
        return renderScreenshot(shot, maxInline)
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `computer_click`：在屏幕上点一下。
 *
 * **这一步要人点头**：桌面上没有天然边界，点错地方就点错地方。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createComputerClickTool(
  session: ComputerToolSession,
  options: ComputerToolsOptions = {},
): ComputerTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'computer_click',
    description: '在屏幕上的某个坐标点一下（坐标从 0 开始，左上角是 0,0）。这一步需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（computer_open 返回的）。' },
        x: { type: 'number', description: '横坐标（像素）。' },
        y: { type: 'number', description: '纵坐标（像素）。' },
      },
      required: ['sessionId', 'x', 'y'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      const x = readNumberArg(args, 'x')
      const y = readNumberArg(args, 'y')
      if (x === undefined || y === undefined) return { content: 'x 与 y 是必填的，且必须是数字。', isError: true }
      try {
        await session.act(ownerOf(ctx, fallback), sessionId, { kind: 'click', x: Math.trunc(x), y: Math.trunc(y) })
        return { content: `已在 (${Math.trunc(x)}, ${Math.trunc(y)}) 点了一下。` }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `computer_type`：在屏幕上打一段字。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createComputerTypeTool(session: ComputerToolSession, options: ComputerToolsOptions = {}): ComputerTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'computer_type',
    description: '在当前焦点位置输入一段文字。这一步需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（computer_open 返回的）。' },
        text: { type: 'string', description: '要输入的文字。' },
      },
      required: ['sessionId', 'text'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      const text = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).text : undefined
      if (typeof text !== 'string' || text.length === 0) {
        return { content: 'text 是必填的，且必须是非空字符串。', isError: true }
      }
      try {
        await session.act(ownerOf(ctx, fallback), sessionId, { kind: 'type', text })
        return { content: `已输入 ${text.length} 个字符。` }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `computer_key`：按一个键。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createComputerKeyTool(session: ComputerToolSession, options: ComputerToolsOptions = {}): ComputerTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'computer_key',
    description: '按一个键（Enter / Tab / Escape / ctrl+c 这类）。这一步需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（computer_open 返回的）。' },
        key: { type: 'string', description: '键名，例如 Enter、Tab、Escape、ctrl+c。' },
      },
      required: ['sessionId', 'key'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      const key = readStringArg(args, 'key')
      if (key === undefined) return { content: 'key 是必填的，且必须是非空字符串。', isError: true }
      try {
        await session.act(ownerOf(ctx, fallback), sessionId, { kind: 'key', key })
        return { content: `已按下 ${key}。` }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造 `computer_scroll`：滚轮滚动。
 *
 * 滚动**不算高危动作**（不改内容），所以不需要人点头。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具。
 */
export function createComputerScrollTool(
  session: ComputerToolSession,
  options: ComputerToolsOptions = {},
): ComputerTool {
  const fallback = options.defaultOwner ?? 'default'
  return {
    name: 'computer_scroll',
    description: '在当前焦点位置滚动（dx 是横向、dy 是纵向，正数向下）。滚动不会改变内容，不需要确认。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id（computer_open 返回的）。' },
        dx: { type: 'number', description: '横向滚动量（像素，正数向右）。' },
        dy: { type: 'number', description: '纵向滚动量（像素，正数向下）。' },
      },
      required: ['sessionId', 'dy'],
    },
    execute: async (args, ctx) => {
      const sessionId = readStringArg(args, 'sessionId')
      if (sessionId === undefined) return { content: 'sessionId 是必填的，且必须是非空字符串。', isError: true }
      const dx = readNumberArg(args, 'dx') ?? 0
      const dy = readNumberArg(args, 'dy')
      if (dy === undefined) return { content: 'dy 是必填的，且必须是数字。', isError: true }
      try {
        await session.act(ownerOf(ctx, fallback), sessionId, {
          kind: 'scroll',
          dx: Math.trunc(dx),
          dy: Math.trunc(dy),
        })
        return { content: `已滚动 (${Math.trunc(dx)}, ${Math.trunc(dy)})。` }
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

/**
 * 造齐五个工具。
 * @param session - 会话能力。
 * @param options - 工具选项。
 * @returns 工具数组。
 */
export function createComputerTools(session: ComputerToolSession, options: ComputerToolsOptions = {}): ComputerTool[] {
  return [
    createComputerScreenshotTool(session, options),
    createComputerClickTool(session, options),
    createComputerTypeTool(session, options),
    createComputerKeyTool(session, options),
    createComputerScrollTool(session, options),
  ]
}

/**
 * 截图的渲染。
 *
 * 超过上限时不内联，只回一句说明——把几兆字节塞进上下文是帮倒忙。
 * @param shot - 截图。
 * @param maxInline - 内联上限（字节）。
 * @returns 工具结果。
 */
function renderScreenshot(shot: ComputerScreenshot, maxInline: number): ComputerToolResult {
  const bytes = shot.bytes.byteLength
  const size = shot.width === undefined ? '' : `, 屏幕 ${shot.width}x${shot.height}`
  if (bytes > maxInline) {
    return {
      content: JSON.stringify({
        kind: 'screenshot',
        mimeType: shot.mimeType,
        bytes,
        inline: false,
        note: `截图有 ${bytes} 字节，超过内联上限 ${maxInline}，没有放进工具结果。`,
      }),
    }
  }
  const base64 = Buffer.from(shot.bytes).toString('base64')
  return {
    content: JSON.stringify({
      kind: 'screenshot',
      mimeType: shot.mimeType,
      bytes,
      size,
      inline: true,
      dataUrl: `data:${shot.mimeType};base64,${base64}`,
    }),
  }
}
