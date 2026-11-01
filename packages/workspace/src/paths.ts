/**
 * 工作区的路径边界。
 *
 * 工作区根目录是工具读写文件的边界，这一族负责两件事：
 * - **收进来**：注册一个工作区时，根目录得像个根目录——绝对路径、不是文件系统
 *   根、落在允许的范围内、真的存在。
 * - **关出去**：往工作区里指一条路径时，它得留在根目录底下。
 *
 * 这里只做**词法**判断（`..`、绝对路径、跨盘符）。符号链接与 Windows junction
 * 的真实路径校验在 `@ryharness/tools` 的 `resolveTarget` 里——那一层才知道
 * 读写动作真正落在哪个文件上，本包不该把那份判断抄一遍。
 * @module @ryharness/workspace/paths
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { WorkspacePathError } from './errors.ts'
import type { Workspace } from './types.ts'

/**
 * 这个路径是不是文件系统根（`/`、`C:\`）。
 *
 * 工作区根**不能**是文件系统根：那样工具的「工作区内」就等于「整台机器」，
 * 边界形同虚设。
 * @param target - 待判断的路径。
 * @returns 是文件系统根时为 true。
 */
export function isFilesystemRoot(target: string): boolean {
  const resolved = resolve(target)
  return resolved === parse(resolved).root
}

/**
 * 目标是不是落在根目录之下（含根本身）。
 *
 * 用 relative 算相对路径而不是拿前缀比较：前缀比较在 Windows 上大小写不同
 * 就判成逃逸（同一目录写成 `C:\Work` 与 `c:\work`），而 relative 在 win32 上
 * 按大小写不敏感比较。
 * @param root - 根目录。
 * @param target - 待判断的路径。
 * @returns 落在根之下（或是根本身）时为 true。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  // 跨盘符时 relative 直接给绝对路径，这种一律不在根底下。
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * 检查一个根目录能不能当工作区根。
 *
 * 四条，挨个过：
 * 1. **得是绝对路径**：相对路径跟着当前目录跑，换台机器就不是同一个地方了。
 * 2. **不能是文件系统根**：`/` 或 `C:\` 当根，边界就没了。
 * 3. **得在允许的范围内**：给了 `allowedRoots` 的话，根必须落在其中某一个里面。
 * 4. **得是真实存在的目录**：根目录不存在的话，工具读写时会有一堆看不懂的错。
 * @param rootPath - 待检查的根目录。
 * @param allowedRoots - 允许的范围。空数组表示不限制（但第 2 条照样生效）。
 * @throws WorkspacePathError - 任何一条不满足时。
 */
export function assertAllowedRoot(rootPath: string, allowedRoots: readonly string[] = []): void {
  if (rootPath.trim().length === 0) {
    throw new WorkspacePathError(rootPath, '根目录不能是空串')
  }
  if (!isAbsolute(rootPath)) {
    throw new WorkspacePathError(rootPath, '根目录必须是绝对路径')
  }
  if (isFilesystemRoot(rootPath)) {
    throw new WorkspacePathError(rootPath, '不能把文件系统根当工作区根')
  }
  if (allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => isInsideRoot(root, rootPath))
    if (!allowed) {
      throw new WorkspacePathError(rootPath, `不在允许的范围内（${allowedRoots.join('、')}）`)
    }
  }
  if (!existsSync(rootPath)) {
    throw new WorkspacePathError(rootPath, '目录不存在')
  }
  if (!statSync(rootPath).isDirectory()) {
    throw new WorkspacePathError(rootPath, '不是一个目录')
  }
}

/**
 * 把一条路径解析到工作区之内。
 *
 * 相对路径按工作区根解，绝对路径原样用（但仍要在根底下）。
 * @param workspace - 目标工作区。
 * @param path - 调用方给的路径。
 * @returns 规范化后的绝对路径。
 * @throws WorkspacePathError - 路径逃出了工作区根。
 */
export function resolveInWorkspace(workspace: Workspace, path: string): string {
  const root = resolve(workspace.rootPath)
  const target = resolve(root, path)
  if (!isInsideRoot(root, target)) {
    throw new WorkspacePathError(path, `逃出了工作区「${workspace.name}」的根目录`)
  }
  return target
}
