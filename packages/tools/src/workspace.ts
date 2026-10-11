/**
 * 工作区路径安全：所有 fs 类工具的路径必须解析到工作区根目录之内。
 * @module @ryagent/tools/workspace
 */

import { resolve, sep } from 'node:path'

/** 路径逃逸工作区时抛出。 */
export class PathEscapeError extends Error {
  constructor(readonly root: string, readonly path: string) {
    super(`path "${path}" escapes workspace root "${root}"`)
    this.name = 'PathEscapeError'
  }
}

/**
 * 把调用方给的相对/绝对路径解析进工作区；拒绝任何逃逸（..、符号链接语义
 * 由调用方保证——本函数做词法层面的规范化校验）。
 * @param root - 工作区根目录（绝对路径）。
 * @param path - 用户给出的路径（相对工作区，或根内的绝对路径）。
 * @returns 规范化后的绝对路径。
 */
export function resolveInWorkspace(root: string, path: string): string {
  const resolved = resolve(root, path)
  if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new PathEscapeError(root, path)
  }
  return resolved
}

/**
 * 截断超长输出，标注截断位置。
 * @param text - 原始输出。
 * @param maxChars - 最大保留字符数。
 * @returns 截断后的文本（超长时附省略标注）。
 */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…[truncated: ${text.length - maxChars} more chars]`
}
