/**
 * 文件策略：程序能读哪些路径、能写哪些路径。
 *
 * 判定分两层：
 * - **词法层**：路径解析完（相对路径按 `cwd` 解析）必须落在允许的根目录里。
 * - **真实路径层**：把路径里**最近的那个真实存在的祖先**解一遍符号链接，再判一次。
 *   工作区里放一个指向外面的符号链接，词法层看不出来，真实路径层能。
 *
 * 这两层之外不做别的：程序能不能读某个文件，最终由宿主这边执行绑定时说了算，
 * 程序本身在子进程里连 `fs` 都碰不到。
 * @module @ryharness/ptc/policy
 */

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { PtcFilePolicy } from './types.ts'

/** 一次文件访问的种类。 */
export type FileAccess = 'read' | 'write'

/** 路径判定的结果。 */
export interface PathDecision {
  /** 放行没有。 */
  allowed: boolean
  /** 放行时给出的**解析后**的绝对路径。 */
  path?: string
  /** 拒绝时给出的一句中文原因。 */
  reason?: string
}

/** 解析好的文件策略（路径都是绝对路径）。 */
export interface ResolvedFilePolicy {
  /** 相对路径的基准目录。 */
  cwd: string
  /** 允许读的根目录。 */
  readRoots: readonly string[]
  /** 允许写的根目录。 */
  writeRoots: readonly string[]
}

/**
 * 把调用方给的文件策略解析成绝对路径的一组根。
 *
 * 缺省口径：`cwd` 是宿主当前目录，能读能写的都只有 `cwd` 自己——**默认不开放整个
 * 磁盘**，要放宽得显式说。
 * @param policy - 调用方给的文件策略。
 * @param fallbackCwd - 调用方没给 `cwd` 时的兜底目录。
 * @returns 解析后的策略。
 */
export function resolveFilePolicy(policy: PtcFilePolicy | undefined, fallbackCwd: string): ResolvedFilePolicy {
  const cwd = policy?.cwd === undefined ? path.resolve(fallbackCwd) : path.resolve(policy.cwd)
  const readRoots = (policy?.readRoots ?? [cwd]).map((root) => {
    return path.resolve(cwd, root)
  })
  const writeRoots = (policy?.writeRoots ?? readRoots).map((root) => {
    return path.resolve(cwd, root)
  })
  return { cwd, readRoots, writeRoots }
}

/**
 * 判一次文件访问能不能做。
 *
 * @param policy - 解析好的策略。
 * @param access - 读还是写。
 * @param requested - 程序给出的路径（相对路径按 `cwd` 解析）。
 * @returns 判定结果。
 */
export function checkPath(policy: ResolvedFilePolicy, access: FileAccess, requested: string): PathDecision {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { allowed: false, reason: '路径是空的：程序得先说清楚要动哪个文件。' }
  }
  const target = path.resolve(policy.cwd, requested)
  const roots = access === 'read' ? policy.readRoots : policy.writeRoots
  const real = realpathOfNearestExisting(target)
  const allowed = roots.some((root) => {
    return isInside(root, target) && isInside(root, real)
  })
  if (!allowed) {
    const what = access === 'read' ? '读' : '写'
    return {
      allowed: false,
      reason: `路径不在允许${what}的范围里：${target}（允许的范围：${roots.join('、')}）`,
    }
  }
  return { allowed: true, path: target }
}

/** 路径是不是落在根目录里（Windows 上按大小写不敏感算）。 */
function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalize(root)
  const normalizedTarget = normalize(target)
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
}

/** 统一分隔符并按 Windows 口径小写。 */
function normalize(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * 把路径里**最近的那个真实存在的祖先**解一遍符号链接。
 *
 * 路径本身不存在时（要新建的文件），退到它存在的父目录上解——那样也能看出
 * 「这个父目录其实指向工作区外」。
 * @param target - 目标路径。
 * @returns 解过符号链接之后的路径（解不动时原样返回）。
 */
function realpathOfNearestExisting(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    if (existsSync(current)) {
      let real: string
      try {
        real = realpathSync(current)
      } catch {
        return target
      }
      return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) return target
    tail.push(path.basename(current))
    current = parent
  }
}
