/**
 * file_produce：把内容落成产物文件并返回"产物卡片"元数据——
 * 这是"发文件"能力的内核：UI 拿到卡片渲染成文件消息。
 * @module @ryharness/tools/produce
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { type ProduceCard, type Tool, throwIfAborted } from '@ryharness/agent'
import { resolveInWorkspace } from './workspace.ts'

/** 产物统一落进工作区下的这个子目录。 */
export const ARTIFACTS_DIR = '.ryharness-artifacts'

/** 常见扩展名 → MIME（覆盖不全时退回 octet-stream）。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

function argString(args: unknown, key: string): string {
  if (typeof args === 'object' && args !== null && key in args) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  throw new Error(`file_produce: missing string argument "${key}"`)
}

/** 文件名只允许叶子名（不允许路径分隔符），防目录混淆。 */
function sanitizeLeafName(name: string): string {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`file_produce: invalid file name "${name}" (leaf names only)`)
  }
  return name
}

function guessMime(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** 按扩展名推断 MIME（供文件下载等复用）。 */
export { guessMime }

/**
 * 把内容写入工作区 `.ryharness-artifacts/` 并返回产物卡片。
 * 卡片字段（path/name/size/mime）即 UI 渲染文件消息所需的全部元数据。
 */
export const fileProduce: Tool = {
  name: 'file_produce',
  description: '把内容保存为工作区产物文件，返回产物卡片（path/name/size/mime）供 UI 展示。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '文件名（如 report.md）；只允许叶子名' },
      content: { type: 'string', description: '文件内容（UTF-8 文本）' },
      mime: { type: 'string', description: '可选 MIME 覆盖；默认按扩展名推断' },
    },
    required: ['name', 'content'],
  },
  async execute(args, ctx) {
    throwIfAborted(ctx.signal)
    const name = sanitizeLeafName(argString(args, 'name'))
    const content = argString(args, 'content')
    const mime =
      typeof args === 'object' && args !== null && typeof (args as Record<string, unknown>).mime === 'string'
        ? ((args as Record<string, unknown>).mime as string)
        : guessMime(name)
    const dir = resolveInWorkspace(ctx.workspaceRoot, ARTIFACTS_DIR)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, name)
    writeFileSync(target, content, 'utf8')
    const card: ProduceCard = {
      path: target,
      name,
      size: statSync(target).size,
      mime,
    }
    return {
      content: `produced ${name} (${card.size} bytes, ${mime})`,
      produce: card,
    }
  },
}
