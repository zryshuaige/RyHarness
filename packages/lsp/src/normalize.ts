/**
 * 把语言服务器协议里的原样结果，翻译成归一化的形状。
 *
 * 这一层是「provider 可以换、模型拿到的东西不能变」这句话的落地处。各家服务器
 * 在同一件事上说法不同：
 *
 * - 跳定义可能回**一个** `Location`、可能回**一组** `Location`、也可能回
 *   `LocationLink[]`（带 `targetUri` / `targetSelectionRange`）；
 * - hover 的内容有四种形态：纯字符串、`MarkupContent`（带 kind 的 markdown）、
 *   `MarkedString`（带 language 的代码片段）、以及它们的数组。
 *
 * 这些差异只允许停在这一层。往外的形状只有三种：`{ uri, line, character }`、
 * 一段文本、或者一个 {@link LspError}。
 * @module @ryharness/lsp/normalize
 */

import { LspError } from './errors.ts'
import type { LspHover, LspLocation, LspRange, LspSourcePosition } from './types.ts'

/** 是不是一个普通对象（不是数组、不是 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个字符串；不是字符串就返回 undefined。 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 读一个有限的数字；不是就返回 undefined。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读一个位置（行、列）。
 *
 * 协议里的行列必须是数字，缺一个就是这份结果我们读不懂——这种情况按协议错误处理，
 * 不能悄悄当成「位置是 0,0」：那会把模型的注意力引到文件开头去。
 * @param value - 协议里的 position 对象。
 * @returns 归一化的位置；读不出来就是 undefined。
 */
function readPosition(value: unknown): LspSourcePosition | undefined {
  if (!isRecord(value)) return undefined
  const line = readNumber(value.line)
  const character = readNumber(value.character)
  if (line === undefined || character === undefined) return undefined
  return { line, character }
}

/**
 * 读一个范围。
 * @param value - 协议里的 range 对象。
 * @returns 归一化的范围；读不出来就是 undefined。
 */
function readRange(value: unknown): LspRange | undefined {
  if (!isRecord(value)) return undefined
  const start = readPosition(value.start)
  const end = readPosition(value.end)
  if (start === undefined || end === undefined) return undefined
  return { start, end }
}

/**
 * 归一化一个位置条目（`Location` 或 `LocationLink`）。
 * @param entry - 协议里的位置条目。
 * @returns 归一化后的位置。
 */
function normalizeLocationEntry(entry: unknown): LspLocation {
  if (!isRecord(entry)) {
    throw new LspError('protocol-error', '服务器返回的位置不是对象')
  }
  // LocationLink 用的是 targetUri / targetSelectionRange。
  const uri = readString(entry.uri) ?? readString(entry.targetUri)
  if (uri === undefined) {
    throw new LspError('protocol-error', '服务器返回的位置缺 uri 字段')
  }
  const rawRange = entry.range ?? entry.targetSelectionRange ?? entry.targetRange
  const range = readRange(rawRange)
  if (range === undefined) {
    throw new LspError('protocol-error', `服务器返回的位置（${uri}）缺 range 字段`)
  }
  return { uri, line: range.start.line, character: range.start.character }
}

/**
 * 把协议里的位置结果归一化成位置列表。
 *
 * 认三种形态：单个 `Location`、`Location[]`、`LocationLink[]`；`null` 表示「没有」。
 * @param raw - 服务器的原始返回值。
 * @returns 归一化后的位置列表（没有就是空数组）。
 */
export function normalizeLocations(raw: unknown): LspLocation[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return raw.map((entry) => normalizeLocationEntry(entry))
  if (isRecord(raw)) return [normalizeLocationEntry(raw)]
  throw new LspError('protocol-error', '服务器返回的位置结果既不是对象也不是数组')
}

/**
 * 把一段 hover 内容翻成文本。
 *
 * 带 `language` 的代码片段包成 Markdown 围栏代码块，带 `kind` 的 `MarkupContent`
 * 原样取 `value`，纯字符串原样保留。
 * @param value - 协议里的 contents。
 * @returns 文本；读不出来就是 undefined。
 */
function readHoverContents(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readHoverContents(item))
      .filter((item): item is string => item !== undefined && item.length > 0)
    return parts.join('\n\n')
  }
  if (!isRecord(value)) return undefined
  const text = readString(value.value)
  if (text === undefined) return undefined
  const language = readString(value.language)
  if (language !== undefined) {
    return `\`\`\`${language}\n${text}\n\`\`\``
  }
  return text
}

/**
 * 把协议里的 hover 结果归一化。
 * @param raw - 服务器的原始返回值。
 * @returns 归一化后的 hover；没有内容就是 undefined。
 */
export function normalizeHover(raw: unknown): LspHover | undefined {
  // 服务器回 null 表示「这里没有 hover」，不是错误。
  if (raw === null || raw === undefined) return undefined
  if (!isRecord(raw)) {
    throw new LspError('protocol-error', '服务器返回的 hover 结果不是对象')
  }
  const contents = readHoverContents(raw.contents)
  if (contents === undefined || contents.length === 0) return undefined
  const range = readRange(raw.range)
  return range === undefined ? { contents } : { contents, range }
}
