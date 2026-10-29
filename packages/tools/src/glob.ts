/**
 * glob 匹配与工作区遍历：给 fs_glob / fs_grep 共用的底座。
 *
 * 为什么自己写而不是引一个依赖：这套语法只用到 `**` / `*` / `?` / `{a,b}` / `[abc]`
 * 五种，够用且能测；引 minimatch 之类的库要给安装包加一份依赖，而它的行为
 * （点文件、大小写、`**` 是否匹配零层）我们只需要其中一种口径，自己写反而更可控。
 *
 * 口径（写在这里，测试按它钉）：
 * - `**` 只在**整段**位置有意义：`src/<递归>/a.ts` 匹配 `src/a.ts`（零层）与 `src/x/y/a.ts`；
 * - `*` 不跨 `/`，`?` 匹配任意一个非 `/` 字符；
 * - `{a,b}` 是或，`[abc]` / `[a-z]` / `[!abc]` 是字符类；
 * - 模式开头的 `!` 表示排除（`!node_modules/**` 这种写法我们不用，但排除项本身要支持）。
 * @module @ryharness/tools/glob
 */

import { type Dirent, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 遍历时跳过的目录：版本库、依赖、构建产物与产物目录。 */
export const SKIP_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  '.ryharness-artifacts',
  'coverage',
  'dist',
  'lib',
  '.cache',
  '.turbo',
]

/** 一次遍历最多看多少个文件（防止在一个巨大的目录树上把机器拖死）。 */
export const MAX_WALK_FILES = 20_000

/** 把用户给的 glob 归一：反斜杠换成正斜杠，去掉开头的 `./`。 */
export function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '')
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把一段 glob 编译成正则的源码。
 *
 * 逐段处理而不是整串替换：`{a,b}` 里的内容可能是 `*.ts`，它要作为**分支**而不是字面量。
 */
function globSource(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i] as string
    if (char === '*') {
      // 整段 `**` 才跨目录；`**` 后面跟着 `/` 时匹配零层目录。
      const isSegmentStar = pattern.startsWith('**/', i) || (pattern.startsWith('**', i) && pattern.length === i + 2)
      if (isSegmentStar) {
        if (pattern.startsWith('**/', i)) {
          // 递归段既匹配零层也匹配多层：写成 `(?:[^/]+/)*`
          out += '(?:[^/]+/)*'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
        i += 1
        continue
      }
      const alternatives = pattern
        .slice(i + 1, end)
        .split(',')
        .map((part) => {
          return globSource(part)
        })
      out += `(?:${alternatives.join('|')})`
      i = end + 1
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        out += '\\['
        i += 1
        continue
      }
      let body = pattern.slice(i + 1, end)
      let negate = false
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true
        body = body.slice(1)
      }
      // 字符类内部只保留可安全放进正则类的字符；`\` 保持转义。
      out += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`
      i = end + 1
      continue
    }
    out += escapeLiteral(char)
    i += 1
  }
  return out
}

/**
 * 把 glob 模式编译成正则（整串匹配）。
 * @param pattern - glob 模式。
 * @param options - `caseInsensitive` 时忽略大小写。
 * @returns 编译好的正则。
 */
export function globToRegExp(pattern: string, options?: { caseInsensitive?: boolean }): RegExp {
  const source = globSource(normalizeGlob(pattern))
  return new RegExp(`^${source}$`, options?.caseInsensitive === true ? 'i' : '')
}

/**
 * 一组 glob 模式的匹配器：先按包含项筛，再按排除项剔。
 *
 * 排除项以 `!` 开头。**没有包含项时默认全通过**（调用方只给排除项，
 * 意思是「除了这些都要」）。
 */
export function globMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const includes: string[] = []
  const excludes: string[] = []
  for (const raw of patterns) {
    const pattern = normalizeGlob(raw.trim())
    if (pattern === '') continue
    if (pattern.startsWith('!')) excludes.push(pattern.slice(1))
    else includes.push(pattern)
  }
  const includeRes = includes.map((pattern) => {
    return globToRegExp(pattern)
  })
  const excludeRes = excludes.map((pattern) => {
    return globToRegExp(pattern)
  })
  return (relativePath: string): boolean => {
    const normalized = relativePath.replace(/\\/g, '/')
    if (
      excludeRes.some((re) => {
        return re.test(normalized)
      })
    ) {
      return false
    }
    if (includeRes.length === 0) return true
    return includeRes.some((re) => {
      return re.test(normalized)
    })
  }
}

/** 遍历结果里的一项。 */
export interface WalkedFile {
  /** 相对工作区根的路径（正斜杠）。 */
  readonly relativePath: string
  /** 绝对路径。 */
  readonly absolutePath: string
  /** 文件字节数。 */
  readonly size: number
}

/**
 * 遍历工作区里的文件。
 *
 * 只走真实目录，不跟符号链接：符号链接既可能指回上级形成环，也可能指向工作区
 * 之外——跟进去就等于把工作区边界漏了。
 * @param root - 工作区根目录。
 * @param options - `filter` 决定哪些文件要（按相对路径判定）、`limit` 是最多返回多少个。
 * @returns 找到的文件（相对路径字典序）。
 */
export function walkFiles(
  root: string,
  options?: { filter?: (relativePath: string) => boolean; limit?: number },
): WalkedFile[] {
  const out: WalkedFile[] = []
  const limit = options?.limit ?? MAX_WALK_FILES
  const filter = options?.filter
  let visited = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 目录读不动（权限、并发删除）就跳过，不让一次搜索因为一个目录整个失败。
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue
        stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      visited += 1
      if (visited > MAX_WALK_FILES) return out.sort(byPath)
      const absolutePath = join(dir, entry.name)
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      if (filter !== undefined && !filter(relativePath)) continue
      let size = 0
      try {
        size = statSync(absolutePath).size
      } catch {
        size = 0
      }
      out.push({ relativePath, absolutePath, size })
      if (out.length >= limit) return out.sort(byPath)
    }
  }
  return out.sort(byPath)
}

/** 相对路径字典序（同一台机器上比较结果要稳定，否则「第一个匹配」会飘）。 */
function byPath(a: WalkedFile, b: WalkedFile): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
}
