/**
 * 工作区边界：只有落在工作区根之下的路径才允许被装配进上下文。
 * @module @ryharness/context/workspace
 */

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 目标是否落在工作区根之下（含根本身）。
 *
 * 语义与 @ryharness/tools 的 resolveInWorkspace 相同（词法层），写法换了一种：
 * 用 relative 算相对路径，而不是拿前缀比较——前缀比较在 Windows 上大小写不同
 * 就判成逃逸（同一目录写成 C:\Work 与 c:\work），而 relative 在 win32 上
 * 按大小写不敏感比较。
 * @param root - 工作区根目录。
 * @param target - 待判定的路径。
 * @returns 落在根之下（或是根本身）时为 true。
 */
export function isInsideWorkspace(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  // 跨盘符时 relative 直接给绝对路径，这种一律不在工作区里。
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 一条引用路径在工作区里的下落。 */
export type WorkspaceFileKind = 'ok' | 'missing' | 'outside' | 'link-escape'

/** 判定结果：路径落在哪、为什么不行。 */
export type WorkspaceFile =
  | { kind: 'ok'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'outside'; path: string }
  | { kind: 'link-escape'; path: string }

/**
 * 判定一条引用路径能不能被装配。
 *
 * 词法层之外还要查一次真实路径：工作区里的符号链接 / Windows junction 指向
 * 外部时，词法层完全看不出来，却能把工作区外的内容读进来。
 * @param root - 工作区根目录。
 * @param ref - 用户给的路径（相对工作区，或根内的绝对路径）。
 * @returns 判定结果；'ok' 时 path 是可读的绝对路径。
 */
export function resolveWorkspaceFile(root: string, ref: string): WorkspaceFile {
  const resolved = resolve(root, ref)
  if (!isInsideWorkspace(root, resolved)) return { kind: 'outside', path: resolved }
  if (!existsSync(resolved)) return { kind: 'missing', path: resolved }
  if (escapesViaLink(root, resolved)) return { kind: 'link-escape', path: resolved }
  return { kind: 'ok', path: resolved }
}

/**
 * 真实路径是不是落在工作区根的真实路径之外。
 *
 * 取不到真实路径（链接断了、权限不够）时按「没逃逸」算：宁可放过一条读不到的
 * 文件，也不要把工作区里正常的文件判成逃逸——那种误判会让模型拿到一句
 * 「在工作区之外」，而事实只是这台机器上解析失败。
 */
function escapesViaLink(root: string, target: string): boolean {
  try {
    return !isInsideWorkspace(realpathSync(root), realpathSync(target))
  } catch {
    return false
  }
}
