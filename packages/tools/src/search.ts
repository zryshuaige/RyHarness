/**
 * fs_glob / fs_grep：让助理**找得到**工作区里的东西。
 *
 * 此前工具面只有 fs_read（读一个已知路径）与 fs_write（写一个已知路径），
 * 于是助理面对「这个项目里哪里处理了登录」这类问题只能挨个猜路径——它连
 * 「有哪些文件」都问不出来。dsh 那边对应的是 tool-fs-search（glob + grep，
 * 背后是 ripgrep）；我们不引外部二进制，用一次工作区遍历实现同样的两件事。
 *
 * 边界与 fs_read 一致：只在工作区内找，路径一律过 {@link resolveTarget}。
 * @module @ryharness/tools/search
 */

import { readFileSync } from 'node:fs'
import { type Tool, type ToolResult, throwIfAborted } from '@ryharness/agent'
import { resolveTarget } from './fs.ts'
import { globMatcher, walkFiles } from './glob.ts'

/** 单次搜索最多返回多少条命中（再多模型也读不完）。 */
const DEFAULT_MATCH_LIMIT = 80
/** 单个文件超过这个字节数就不搜（多半是二进制或生成物）。 */
const MAX_SEARCH_FILE_BYTES = 1_000_000
/** 命中里每行最多保留多少字符（一行可以是压缩过的整份 JSON）。 */
const MAX_LINE_CHARS = 400
/** 读文件时判断「是不是文本」只看开头这么多字节。 */
const BINARY_SNIFF_BYTES = 1024

function argString(args: unknown, key: string): string | undefined {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function argNumber(args: unknown, key: string): number | undefined {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function argBoolean(args: unknown, key: string): boolean {
  if (typeof args === 'object' && args !== null && key in args) {
    return (args as Record<string, unknown>)[key] === true
  }
  return false
}

/** 失败一律变成**可读的中文错误结果**，不把英文异常抛给模型。 */
function failure(content: string): ToolResult {
  return { content, isError: true }
}

/** 是不是二进制（含 NUL 字节）。 */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * 按 glob 找文件。
 *
 * 返回**相对工作区**的路径（正斜杠），因为模型下一步要用它去 read/write，
 * 绝对路径既长又换台机器就失效。
 */
export const fsGlob: Tool = {
  name: 'fs_glob',
  description:
    '按 glob 模式找工作区里的文件，返回相对路径列表。支持 **（跨目录）、*（不跨 /）、?、{a,b}、[abc]。例：src/**/*.ts',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，例如 src/**/*.ts' },
      path: { type: 'string', description: '在哪个目录下找（缺省=工作区根）' },
      limit: { type: 'number', description: '最多返回多少个（缺省 200）' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    try {
      throwIfAborted(ctx.signal)
      const pattern = argString(args, 'pattern')
      if (pattern === undefined) return failure('fs_glob：缺少 pattern 参数')
      const limit = Math.min(Math.max(argNumber(args, 'limit') ?? 200, 1), 2000)
      const scope = argString(args, 'path') ?? '.'
      const root = resolveTarget(ctx.workspaceRoot, scope)
      const matches = globMatcher([pattern])
      const found = walkFiles(root, { filter: matches, limit: limit + 1 })
      const truncated = found.length > limit
      const shown = truncated ? found.slice(0, limit) : found
      if (shown.length === 0) {
        return { content: `没有匹配「${pattern}」的文件。` }
      }
      const lines = shown.map((file) => {
        return file.relativePath
      })
      const note = truncated ? `\n…（还有更多，用更精确的 pattern 或放大 limit）` : ''
      return { content: `找到 ${shown.length} 个文件：\n${lines.join('\n')}${note}` }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  },
}

/** 一条命中。 */
export interface GrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/**
 * 在工作区里按正则搜文本。
 *
 * 单独导出是为了能测：工具那层只是把参数拼好、调它、再把结果排版成文本。
 */
export function grepFiles(options: {
  root: string
  pattern: string
  glob?: string
  ignoreCase?: boolean
  limit?: number
  signal?: AbortSignal
}): { matches: GrepMatch[]; scannedFiles: number; skippedFiles: number } {
  const limit = options.limit ?? DEFAULT_MATCH_LIMIT
  const regex = new RegExp(options.pattern, options.ignoreCase === true ? 'i' : '')
  const matches = globMatcher([options.glob ?? '**'])
  const files = walkFiles(options.root, { filter: matches, limit: 2000 })
  const out: GrepMatch[] = []
  let scannedFiles = 0
  let skippedFiles = 0
  for (const file of files) {
    if (out.length >= limit) break
    if (file.size > MAX_SEARCH_FILE_BYTES) {
      skippedFiles += 1
      continue
    }
    let buffer: Buffer
    try {
      buffer = readFileSync(file.absolutePath)
    } catch {
      skippedFiles += 1
      continue
    }
    if (looksBinary(buffer)) {
      skippedFiles += 1
      continue
    }
    scannedFiles += 1
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string
      if (!regex.test(line)) continue
      out.push({
        path: file.relativePath,
        line: i + 1,
        text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
      })
      if (out.length >= limit) break
    }
  }
  return { matches: out, scannedFiles, skippedFiles }
}

/** 在工作区里按正则搜文本。 */
export const fsGrep: Tool = {
  name: 'fs_grep',
  description: '在工作区里按正则搜文本，返回「文件:行号:内容」。可先用 glob 限定范围（例：glob="src/**/*.ts"）。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
      path: { type: 'string', description: '在哪个目录下搜（缺省=工作区根）' },
      glob: { type: 'string', description: '只搜匹配这个 glob 的文件（缺省=全部）' },
      ignoreCase: { type: 'boolean', description: '忽略大小写（缺省=false）' },
      limit: { type: 'number', description: '最多返回多少条命中（缺省 80）' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    try {
      throwIfAborted(ctx.signal)
      const pattern = argString(args, 'pattern')
      if (pattern === undefined) return failure('fs_grep：缺少 pattern 参数')
      const scope = argString(args, 'path') ?? '.'
      const root = resolveTarget(ctx.workspaceRoot, scope)
      const glob = argString(args, 'glob')
      const limit = Math.min(Math.max(argNumber(args, 'limit') ?? DEFAULT_MATCH_LIMIT, 1), 500)
      let result: ReturnType<typeof grepFiles>
      try {
        result = grepFiles({
          root,
          pattern,
          ...(glob === undefined ? {} : { glob }),
          ignoreCase: argBoolean(args, 'ignoreCase'),
          limit,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
      } catch (error) {
        // 正则写错是常事，回一句能让人看懂的话，别把 RegExp 的英文异常原样丢给模型。
        return failure(`fs_grep：正则不合法（${error instanceof Error ? error.message : String(error)}）`)
      }
      if (result.matches.length === 0) {
        const skipped = result.skippedFiles > 0 ? `（跳过 ${result.skippedFiles} 个二进制或过大的文件）` : ''
        return { content: `没有匹配「${pattern}」的内容${skipped}。` }
      }
      const lines = result.matches.map((match) => {
        return `${match.path}:${match.line}: ${match.text.trim()}`
      })
      const tail = result.skippedFiles > 0 ? `\n…（跳过 ${result.skippedFiles} 个二进制或过大的文件）` : ''
      return { content: `找到 ${result.matches.length} 处匹配：\n${lines.join('\n')}${tail}` }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  },
}
