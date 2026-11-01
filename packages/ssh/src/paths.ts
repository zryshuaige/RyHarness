/**
 * 远端路径的处理：归一化与「关在根目录里」。
 *
 * **远端是 POSIX**，哪怕宿主是 Windows：分隔符只有 `/`，反斜杠是普通字符，
 * `C:\x` 是个名字奇怪的文件，不是路径。所以这里**不碰 node:path**，自己按 POSIX 规则算。
 *
 * 归一化要按 POSIX 语义做两件事：消掉 `.`、把 `..` 往上收。
 * `/srv/work/../etc` 归一化后是 `/srv/etc`——注意它**不是** `/etc`：`..` 只消掉一段，
 * 不会凭空跳到根。这个区别正是围栏判定的依据。
 * @module @ryharness/ssh/paths
 */

import { SshError } from './errors.ts'

/**
 * 按 POSIX 规则归一化一个远端路径。
 *
 * - 绝对路径保留开头的 `/`；相对路径保持相对。
 * - `.` 与空段被丢掉，结尾的 `/` 也被丢掉（根目录 `/` 除外）。
 * - `..` 往上收一段；收不动的（比如相对路径开头的 `..`）原样留着，交给调用方判断。
 * @param input - 远端路径。
 * @returns 归一化后的路径。
 */
export function normalizeRemotePath(input: string): string {
  if (input.length === 0) {
    throw new SshError('INVALID_ARGUMENT', '远端路径不能为空。')
  }
  const absolute = input.startsWith('/')
  const out: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = out[out.length - 1]
      if (out.length > 0 && last !== '..') {
        out.pop()
        continue
      }
      // 绝对路径在根之上没有东西（/.. 就是 /）；相对路径只能把 `..` 留着。
      if (absolute) continue
      out.push('..')
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/**
 * 目标路径是不是在根目录里面。
 *
 * 边界按**路径段**比，不按字符串前缀比：`/srv/work` 与 `/srv/workspace` 前缀相同但不是
 * 同一个目录，所以前者不算在后者里面。
 * @param root - 根目录（绝对路径）。
 * @param target - 目标路径（绝对路径）。
 * @returns 在里面返回 true。
 */
export function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeRemotePath(root)
  const normalizedTarget = normalizeRemotePath(target)
  if (normalizedRoot === '/') return normalizedTarget.startsWith('/')
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(`${normalizedRoot}/`)
}

/**
 * 把调用方给的路径解析成远端绝对路径，并检查它没越出根目录。
 *
 * 规则：
 * - 给了根目录时，相对路径按根目录解析，绝对路径**必须**已经在根目录里面；
 * - 越界（`../` 跑出去、绝对路径指向别处）一律报 `PATH_OUTSIDE_ROOT`；
 * - 没给根目录就没有围栏，只做归一化。
 * @param root - 远端根目录；不给就是没有围栏。
 * @param input - 调用方给的路径。
 * @returns 远端绝对路径。
 */
export function resolveRemotePath(root: string | undefined, input: string): string {
  const normalizedInput = normalizeRemotePath(input)
  if (root === undefined) return normalizedInput
  const normalizedRoot = normalizeRemotePath(root)
  if (!normalizedRoot.startsWith('/')) {
    throw new SshError('INVALID_ARGUMENT', `远端根目录必须是绝对路径：${root}`)
  }
  const candidate = normalizedInput.startsWith('/')
    ? normalizedInput
    : normalizeRemotePath(`${normalizedRoot}/${normalizedInput}`)
  if (!isInsideRoot(normalizedRoot, candidate)) {
    throw new SshError('PATH_OUTSIDE_ROOT', `路径越出了远端根目录：${input}（根目录是 ${normalizedRoot}）。`)
  }
  return candidate
}
