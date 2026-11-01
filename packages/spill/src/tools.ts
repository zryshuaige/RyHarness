/**
 * 取回工具：模型拿着定位符，把溢出去的原文分页取回来。
 *
 * 为什么是工具而不是「直接给全文」：一次给全文等于把刚省下来的上下文又塞回去，
 * 溢出就白做了。分页取让模型按需要看多少取多少——通常它要的只是其中一段。
 *
 * 工具自己不做鉴权：**会话归属由存储层核对**（取回时带上会话 id，对不上就拒）。
 * 这样同一个工具既能服务模型调用，也能服务宿主自己的路由。
 * @module @ryharness/spill/tools
 */

import { SPILL_READ_TOOL_NAME, type SpillStore, type SpillTool } from './types.ts'

/** 单次最多返回多少字符（缺省）。 */
export const DEFAULT_READ_CHARS = 4000

/** 取回工具的构造参数。 */
export interface SpillReadToolOptions {
  /** 从哪个存储取。 */
  readonly store: SpillStore
  /** 单次最多返回多少字符。缺省 4000。 */
  readonly maxChars?: number
  /** 工具名。缺省 `spill_read`。 */
  readonly name?: string
}

/** 工具参数 → 对象；不是对象就当空参数。 */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/** 参数里的字符串字段。 */
function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 参数里的数字字段。 */
function numberField(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 造一个「取回溢出文本」的工具。
 *
 * 工具名默认 `spill_read`；存储层写在定位符里的「取回指引」用的也是这个名字
 * （两边对不上，模型照着指引会去找一个不存在的工具）。
 * @param options - 存储与单次上限。
 * @returns 可注册的工具。
 */
export function createSpillReadTool(options: SpillReadToolOptions): SpillTool {
  const maxChars = options.maxChars ?? DEFAULT_READ_CHARS
  const toolName = options.name ?? SPILL_READ_TOOL_NAME
  return {
    name: toolName,
    description:
      '取回之前溢出的工具结果原文。溢出提示里会给一个 id，用它来取；一次只给一段（可用 offset 接着取），不会把上下文一次塞满。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '溢出文本的定位符 id（从溢出提示里复制）。' },
        offset: { type: 'number', description: '从第几个字符开始取（缺省从头）。' },
        limit: { type: 'number', description: `这次最多取多少字符（缺省 ${maxChars}）。` },
      },
      required: ['id'],
    },
    async execute(args, ctx) {
      if (ctx.signal?.aborted === true) {
        return { content: '这次调用已经被取消了。', isError: true }
      }
      const parsed = argsOf(args)
      const id = stringField(parsed, 'id')
      if (id === undefined) {
        return { content: '取回溢出文本需要 id 参数（从溢出提示里复制）。', isError: true }
      }
      const offset = numberField(parsed, 'offset')
      const limit = numberField(parsed, 'limit')
      const want = limit === undefined ? maxChars : Math.min(limit, maxChars)
      try {
        const result = options.store.read(id, {
          sessionId: ctx.conversationId,
          offset: offset ?? 0,
          limit: want,
        })
        if (result.chars === 0) {
          return { content: `溢出文本 ${id} 是空的。` }
        }
        return { content: renderPage(result, want, toolName) }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/**
 * 拼一页正文 + 一句「还有没有」。
 *
 * 页脚要说清**还能怎么接着取**：模型看到「第 1/4 页」却不知道下一页从哪开始，
 * 就不会再取第二次了。
 * @param result - 取回结果。
 * @param pageChars - 这一页的长度（算页码用）。
 * @param toolName - 工具名（页脚里要写出来）。
 * @returns 给模型看的正文。
 */
function renderPage(
  result: { id: string; text: string; chars: number; offset: number; nextOffset?: number; hasMore: boolean },
  pageChars: number,
  toolName: string,
): string {
  const step = Math.max(1, pageChars)
  const page = Math.floor(result.offset / step) + 1
  const pages = Math.max(1, Math.ceil(result.chars / step))
  if (!result.hasMore || result.nextOffset === undefined) {
    return [result.text, '', `[溢出文本 ${result.id} · 全文 ${result.chars} 字 · 已取完]`].join('\n')
  }
  return [
    result.text,
    '',
    `[溢出文本 ${result.id} · 第 ${page}/${pages} 页 · 共 ${result.chars} 字 · 接着取：${toolName}(id="${result.id}", offset=${result.nextOffset})]`,
  ].join('\n')
}
