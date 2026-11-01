/**
 * 可执行文件查找：按名字把它落到一个真路径上。
 *
 * 为什么要单独做这一件事：`spawn('git')` 能不能跑，取决于 PATH 里有没有它、
 * 有没有那个扩展名、有没有执行权限。这三件事每台机器都不一样，所以「命令能不能
 * 跑」必须先问一句「它到底在哪儿」，而不是把 ENOENT 甩给调用方自己猜。
 *
 * 平台差异是显式的：
 * - **Windows**：认 `.exe` / `.cmd` / `.bat` / `.ps1`，另外把宿主 `PATHEXT` 里的
 *   扩展名一并认上。文件本身不需要执行位。
 * - **POSIX**：只认**绝对路径**与 PATH 里的同名文件，并且要看执行位——没有执行位的
 *   文件对 shell 来说不是命令。
 *
 * 找不到时给结构化结果（不是异常）：调用方多半要把这句话原样给模型看。
 * @module @ryharness/subprocess/executable
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ExecutableResolution, ResolveExecutableOptions } from './types.ts'

/** Windows 上认的扩展名（不含 PATHEXT 里那一份）。 */
export const WINDOWS_EXECUTABLE_EXTENSIONS: readonly string[] = ['.exe', '.cmd', '.bat', '.ps1']

/** 从环境里取 PATH（Windows 上名字可能是 `Path`）。 */
function readPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const raw = platform === 'win32' ? (env.PATH ?? env.Path ?? env.path) : env.PATH
  return raw ?? ''
}

/** PATH 拆成目录列表；空段丢掉（PATH 里写空段在本仓不是惯例，但也不该变成一个空目录）。 */
function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return readPath(env, platform)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Windows 上要试的扩展名：先是这几个，再补上 PATHEXT 里的。 */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const out = ['', ...WINDOWS_EXECUTABLE_EXTENSIONS]
  const pathext = env.PATHEXT ?? env.Pathext
  if (typeof pathext === 'string') {
    for (const part of pathext.split(';')) {
      const ext = part.trim()
      if (ext.length === 0) continue
      if (!out.includes(ext)) out.push(ext)
    }
  }
  return out
}

/** 这串东西是不是「调用方直接给了路径」。 */
function looksLikePath(name: string, platform: NodeJS.Platform): boolean {
  if (name.includes('/') || name.includes('\\')) return true
  if (platform === 'win32' && /^[A-Za-z]:/.test(name)) return true
  return false
}

/**
 * 这个文件能不能当命令跑。
 *
 * POSIX 上看执行位：文件在那儿但没有执行位，对 shell 来说它不是命令。
 * Windows 上没有执行位这回事，普通文件就是可执行的（扩展名的事在查找阶段管）。
 */
function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
  } catch {
    return false
  }
  if (platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 直接给了路径时的查找。
 *
 * 绝对路径按原样试（Windows 上还试补上扩展名）；相对路径按当前工作目录解析。
 * @returns 找到的路径；没找到是 undefined。
 */
function resolveDirect(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = platform === 'win32' ? windowsExtensions(env) : ['']
  for (const ext of extensions) {
    const candidate = ext.length === 0 ? name : `${name}${ext}`
    if (isExecutableFile(candidate, platform)) return candidate
  }
  return undefined
}

/**
 * 按名字找可执行文件。
 *
 * 查找顺序：**候选目录 → PATH**。候选目录排在前面是因为它是调用方明确指的
 * （比如某个工具自带的 node），PATH 是兜底。
 * @param options - 命令名、候选目录、环境与平台。
 * @returns 找到就给出路径与来源；没找到给出结构化原因与找过的路径清单。
 */
export function resolveExecutable(options: ResolveExecutableOptions): ExecutableResolution {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const name = options.name.trim()

  if (name.length === 0) {
    return {
      found: false,
      reason: 'invalid-name',
      searched: [],
      message: '可执行文件名为空：没东西可找。',
    }
  }

  if (looksLikePath(name, platform)) {
    const direct = resolveDirect(name, platform, env)
    if (direct !== undefined) {
      return { found: true, path: direct, source: 'direct' }
    }
    return {
      found: false,
      reason: 'not-found',
      searched: [name],
      message: `找不到可执行文件「${name}」：这个路径上没有可执行的文件。`,
    }
  }

  const candidates = options.candidates ?? []
  const dirs = pathEntries(env, platform)
  const extensions = platform === 'win32' ? windowsExtensions(env) : ['']
  const searched: string[] = []

  for (const [index, dir] of [...candidates, ...dirs].entries()) {
    const source = index < candidates.length ? 'candidate' : 'path'
    for (const ext of extensions) {
      const candidate = join(dir, name + ext)
      searched.push(candidate)
      if (isExecutableFile(candidate, platform)) {
        return { found: true, path: candidate, source }
      }
    }
  }

  const where =
    candidates.length > 0
      ? `${candidates.length} 个候选目录与 ${dirs.length} 个 PATH 目录`
      : `${dirs.length} 个 PATH 目录`
  return {
    found: false,
    reason: 'not-found',
    searched,
    message: `在 ${where} 里都找不到可执行文件「${name}」。`,
  }
}
