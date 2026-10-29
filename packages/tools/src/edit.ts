/**
 * fs_edit：按**精确文字**改文件。
 *
 * 不用「行号 + 新内容」那种改法：行号在模型读完文件到动手之间就会漂（文件可能被
 * 别的进程改过，也可能模型自己上一轮就改过），漂了就改错地方。精确文字匹配把
 * 「我以为的位置」变成「我确实看到的那段话」——对不上就明确报错，而不是改坏。
 *
 * 写盘是原子的（先写临时文件再 rename）：改到一半断电不会留下半个文件。
 * @module @ryharness/tools/edit
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { type Tool, type ToolResult, throwIfAborted } from '@ryharness/agent'
import { resolveTarget } from './fs.ts'

/** 报错时回给模型的正文摘录长度（够它看清真实内容，又不至于把整个文件塞进历史）。 */
const EXCERPT_CHARS = 1200
/** 单次允许改的最大字节数（改大文件会让模型把整个文件读进上下文，不值）。 */
const MAX_EDIT_BYTES = 2_000_000

function argString(args: unknown, key: string): string | undefined {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function argBoolean(args: unknown, key: string): boolean {
  if (typeof args === 'object' && args !== null && key in args) {
    return (args as Record<string, unknown>)[key] === true
  }
  return false
}

function failure(content: string): ToolResult {
  return { content, isError: true }
}

/** 数一段文字在正文里出现了几次（非重叠计数）。 */
export function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 按精确文字替换文件内容。
 *
 * 单独导出是为了能测（工具那层只做参数与排版）。
 * @param options - `absolutePath` 目标文件、`oldText` 要被替换的文字、`newText` 替换成什么、
 *   `replaceAll` 为真时替换全部出现处。
 * @returns 改了多少处；失败时带一句中文原因。
 */
export function replaceInFile(options: {
  absolutePath: string
  oldText: string
  newText: string
  replaceAll?: boolean
}): { ok: true; replaced: number; bytes: number } | { ok: false; error: string; excerpt?: string } {
  let content: string
  try {
    content = readFileSync(options.absolutePath, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不到文件：${error instanceof Error ? error.message : String(error)}` }
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_EDIT_BYTES) {
    return { ok: false, error: `文件太大（${bytes} 字节），改不动；先分段处理。` }
  }
  if (options.oldText === '') {
    return { ok: false, error: 'oldText 不能为空：空串会匹配到每个位置。' }
  }
  const occurrences = countOccurrences(content, options.oldText)
  if (occurrences === 0) {
    const excerpt = content.slice(0, EXCERPT_CHARS)
    return {
      ok: false,
      error: `文件里没有这段文字。下面是文件开头的内容（照着它改）：\n${excerpt}`,
      excerpt,
    }
  }
  if (occurrences > 1 && options.replaceAll !== true) {
    return {
      ok: false,
      error: `这段文字在文件里出现了 ${occurrences} 次。给更长的上下文（含前后文）让它唯一，或者带 replaceAll=true 全部替换。`,
    }
  }
  const next =
    options.replaceAll === true
      ? content.split(options.oldText).join(options.newText)
      : content.replace(options.oldText, options.newText)
  const temporary = `${options.absolutePath}.ry-edit-tmp`
  try {
    writeFileSync(temporary, next, 'utf8')
    renameSync(temporary, options.absolutePath)
  } catch (error) {
    return { ok: false, error: `写盘失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, replaced: options.replaceAll === true ? occurrences : 1, bytes: Buffer.byteLength(next, 'utf8') }
}

/** 按精确文字改工作区里的文件。 */
export const fsEdit: Tool = {
  name: 'fs_edit',
  description:
    '按精确文字改工作区里的文件。oldText 必须与文件里那段一字不差；出现多次时要给更长上下文或加 replaceAll。改完返回替换了几处。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的文件路径' },
      oldText: { type: 'string', description: '要被替换掉的原文（必须一字不差）' },
      newText: { type: 'string', description: '替换成的新文字' },
      replaceAll: { type: 'boolean', description: '把全部出现处都替换（缺省=false，只改第一处）' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  async execute(args, ctx) {
    try {
      throwIfAborted(ctx.signal)
      const path = argString(args, 'path')
      if (path === undefined || path === '') return failure('fs_edit：缺少 path 参数')
      const oldText = argString(args, 'oldText')
      if (oldText === undefined) return failure('fs_edit：缺少 oldText 参数')
      const newText = argString(args, 'newText')
      if (newText === undefined) return failure('fs_edit：缺少 newText 参数')
      const absolutePath = resolveTarget(ctx.workspaceRoot, path)
      const result = replaceInFile({
        absolutePath,
        oldText,
        newText,
        replaceAll: argBoolean(args, 'replaceAll'),
      })
      if (!result.ok) return failure(result.error)
      return { content: `已改 ${path}：替换 ${result.replaced} 处，文件现在 ${result.bytes} 字节。` }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  },
}
