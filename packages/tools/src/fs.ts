/**
 * fs_read / fs_write：工作区限定的文件读写。
 *
 * 边界是两层：`resolveInWorkspace` 做词法规范化（`..`、绝对路径），这里再做
 * 一次真实路径校验——工作区里一个指向外部的符号链接/junction，词法层完全看不出来，
 * 却能让模型读到（或写穿）工作区外的一切。写目标还不存在，所以 realpath 从最深
 * 的**已存在**祖先开始解析，剩下的段按原样接回。
 * @module @ryagent/tools/fs
 */

import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { type Tool, type ToolResult, throwIfAborted } from '@ryagent/agent'
import { PathEscapeError, resolveInWorkspace, truncateOutput } from './workspace.ts'

const MAX_READ_CHARS = 64_000
/** 读窗口字节上限：UTF-8 每字符至多 4 字节，覆盖 MAX_READ_CHARS 个字符。 */
const MAX_READ_BYTES = MAX_READ_CHARS * 4

/** 真实路径的最深已存在祖先 + 其后各段（目标尚未创建时用）。 */
function realpathWithTail(target: string): string {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      // 一路到盘符/根都没解析出任何已存在段：只能按原样返回，交给调用方比较。
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/** candidate 是否在 root 之内（含 root 自身）。Windows/macOS 文件名大小写不敏感。 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return candidate.toLowerCase().startsWith(prefix.toLowerCase())
  }
  return candidate.startsWith(prefix)
}

/**
 * 解析工作区内的目标路径：词法边界 + 符号链接边界都过一遍。
 * @param root - 工作区根目录。
 * @param path - 调用方给的路径。
 * @returns 规范化后的绝对路径（仍用词法结果，调用方按它读写）。
 * @throws PathEscapeError - 词法逃逸，或真实路径逃出工作区（符号链接/junction）。
 */
function resolveTarget(root: string, path: string): string {
  const target = resolveInWorkspace(root, path)
  // 根目录本身也走一遍：根是符号链接时（macOS 的 /tmp、工作区指到别处），
  // 拿词法根去比真实路径会误判成逃逸。
  const realRoot = realpathWithTail(root)
  const real = realpathWithTail(target)
  if (!isInside(realRoot, real)) {
    throw new PathEscapeError(root, `${path}（真实路径 ${real} 指向工作区之外）`)
  }
  return target
}

function argString(args: unknown, key: string): string {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  throw new Error(`fs tool: missing string argument "${key}"`)
}

/** 把同步 fs 异常（含路径逃逸）映射为错误结果，而不是抛给循环。 */
function guard(operation: () => ToolResult): Promise<ToolResult> {
  try {
    return Promise.resolve(operation())
  } catch (error) {
    return Promise.resolve({ content: error instanceof Error ? error.message : String(error), isError: true })
  }
}

/** 读工作区内文件（UTF-8），超长截断。 */
export const fsRead: Tool = {
  name: 'fs_read',
  description: '读取工作区内的文本文件，返回其内容（超长时截断）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的文件路径' },
    },
    required: ['path'],
  },
  // async：取消检查抛出的 AbortedError 必须以 rejection 兑现 Tool 的
  // Promise 契约（同步 throw 会绕过调用方的 await 处理）。
  async execute(args, ctx) {
    // 取消优先于任何副作用：已取消的轮次不再读写工作区。
    throwIfAborted(ctx.signal)
    return guard(() => {
      const target = resolveTarget(ctx.workspaceRoot, argString(args, 'path'))
      const stat = statSync(target, { throwIfNoEntry: false })
      if (stat === undefined) return { content: `file not found: ${target}`, isError: true }
      if (!stat.isFile()) return { content: `not a file: ${target}`, isError: true }
      // 只读开头的窗口字节：整文件读入内存会把超大日志/数据文件直接拉爆进程。
      const fd = openSync(target, 'r')
      let raw: string
      let bytesRead = 0
      try {
        const window = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES))
        bytesRead = readSync(fd, window, 0, window.length, 0)
        raw = window.toString('utf8', 0, bytesRead)
      } finally {
        closeSync(fd)
      }
      if (bytesRead < stat.size) {
        const head = raw.slice(0, MAX_READ_CHARS)
        return { content: `${head}\n…[truncated: file is ${stat.size} bytes, showing first ${head.length} chars]` }
      }
      return { content: truncateOutput(raw, MAX_READ_CHARS) }
    })
  },
}

/** 写工作区内文件（UTF-8），自动创建父目录，返回写入摘要。 */
export const fsWrite: Tool = {
  name: 'fs_write',
  description: '把内容写入工作区内文件（自动创建父目录），返回写入结果摘要。',
  // 模型同一批里常同时写同一路径的多个片段（拆分写入）：并发会让后写的片段
  // 随机先落盘，文件内容变成片段的随机排列。
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的目标文件路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    throwIfAborted(ctx.signal)
    return guard(() => {
      const target = resolveTarget(ctx.workspaceRoot, argString(args, 'path'))
      const content = argString(args, 'content')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { content: `wrote ${content.length} chars to ${target}` }
    })
  },
}
