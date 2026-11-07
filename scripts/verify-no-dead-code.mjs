#!/usr/bin/env node
/**
 * 门禁 5／7：死代码扫描（自包含、零依赖）。
 *
 * ## 它盯什么
 *
 * 上一轮把 dsh 的 53 个能力家族都建成了包，但其中 12 个**在产品里根本触发不到**：
 * 没有任何 import 指向它们、注册表里没有它们的名字、界面没有入口、模型调不到。
 * 它们占地一万多行，还被 `docs/dsh-parity.md` 标成「已有」。
 *
 * 这道门禁就是防这种事再攒起来。四条规则：
 *
 * - **A（红）**：任何 workspace 包从产品入口出发**不可达** → 报错。
 * - **B（红）**：任何源码文件从产品入口出发**不可达** → 报错。
 * - **C（黄）**：任何**值导出**从没被引用 → 警告（只报警，不拦：动态引用很难静态证明，
 *   一次拦太狠会把门禁变成噪音）。
 * - **D（红）**：`package.json` 声明了 `@ryharness/*` 依赖但源码里一次都没 import
 *   → 报错（这是「声明了却没用」的典型形态）。
 *
 * ## 入口是哪几个
 *
 * - `apps/desktop/electron/main.ts`（桌面端主进程）
 * - `apps/desktop/renderer/src/main.tsx`（渲染层）
 * - `apps/server/src/index.ts`（服务端）
 *
 * 脚本、构建配置、测试都不算入口——它们是**开发时用的**，不是产品路径。
 *
 * ## 豁免
 *
 * 纯库（`vendor/*`、`packages/util/*` 这类被别的包引用的基础件）不要求自己能被
 * 产品入口走到。豁免清单在 `docs/dead-code-exemptions.json` 里，**要写理由**：
 * 没有理由的豁免等于把门禁关掉。
 *
 * 用法：
 *   node scripts/verify-no-dead-code.mjs          # 0 = 通过
 *   node scripts/verify-no-dead-code.mjs --json   # 机器可读
 *   node scripts/verify-no-dead-code.mjs --list   # 附带打印规则 C 的完整清单
 *
 * 环境变量 RYHARNESS_SCAN_ROOT=<dir>：只扫这个目录（门禁自己的用例用它喂临时夹具）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(
  process.env.RYHARNESS_SCAN_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
const JSON_OUT = process.argv.includes('--json')
const LIST = process.argv.includes('--list')

/** 产品入口：产品路径从这里出发。 */
const ENTRY_POINTS = ['apps/desktop/electron/main.ts', 'apps/desktop/renderer/src/main.tsx', 'apps/server/src/index.ts']

/** 不算源码的文件（脚本、配置、声明）。 */
const NON_SOURCE = new Set(['.d.ts', '.json', '.md', '.css', '.html', '.png', '.jpg', '.svg', '.webp', '.yml', '.yaml'])

/** 目录名：这些目录整个跳过。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'lib',
  'coverage',
  '.git',
  '.zcode',
  'data',
  'main',
  'out',
  'release',
  'ryharness-release',
  'site',
  'vendor',
  '.tmp-coverage-lane',
  '.tmp-lane-scripts',
  'prepared-media',
  'videos',
])

/** 这些文件是「约定式入口」：不由别处 import，但确实会被用到。 */
const CONVENTIONAL_ENTRIES = new Set([
  'apps/desktop/electron/preload.ts',
  // 构建配置：靠文件名被构建工具读到，不由 import 到达。
  'apps/desktop/renderer/vite.config.ts',
  'apps/desktop/tsdown.config.mjs',
  'apps/server/tsdown.config.mjs',
  // 独立启动入口：由命令行拉起（`tsx apps/server/src/main.ts`），不由 import 到达。
  'apps/server/src/main.ts',
  // 类型声明：给编辑器看的，没有运行时代码。
  'apps/desktop/renderer/src/vite-env.d.ts',
  // 主题引导脚本：由 index.html 直接引用。
  'apps/desktop/renderer/public/theme-boot.js',
  // askpass 助手：由 ssh 客户端按路径调起，不是 import。
  'apps/server/assets/askpass.mjs',
  // ptc 的子进程宿主脚本：子进程按路径加载它，不是 import。
  'packages/ptc/child.mjs',
  // 性能测试的构建配置：按文件名被 vitest 读到。
  'vitest.perf.config.ts',
])

/** 构建配置的后缀：这些文件按名字被工具读到，一律不算「不可达」。 */
const CONFIG_FILE_PATTERN = /(^|\/)(tsdown|vite|vitest|rollup|esbuild|tsconfig)\.config\.[cm]?[jt]s$/

/** 豁免清单的路径。 */
const EXEMPTIONS_PATH = path.join(ROOT, 'docs', 'dead-code-exemptions.json')

/**
 * 读豁免清单。
 *
 * **读不出来就是空清单**（没有豁免）——不是「全豁免」。豁免文件坏了应该让门禁
 * 更严，而不是更松。
 * @returns 豁免的包名、路径前缀与理由。
 */
function readExemptions() {
  const result = { packages: new Set(), paths: new Set(), reasons: {} }
  if (!existsSync(EXEMPTIONS_PATH)) return result
  try {
    const parsed = JSON.parse(readFileSync(EXEMPTIONS_PATH, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return result
    if (Array.isArray(parsed.packages)) {
      for (const item of parsed.packages) if (typeof item === 'string') result.packages.add(item)
    }
    if (Array.isArray(parsed.paths)) {
      for (const item of parsed.paths) if (typeof item === 'string') result.paths.add(item)
    }
    if (typeof parsed.reasons === 'object' && parsed.reasons !== null) {
      for (const [key, value] of Object.entries(parsed.reasons)) {
        if (typeof value === 'string') result.reasons[key] = value
      }
    }
  } catch {
    // 读不出来就当没有豁免。
  }
  return result
}

/**
 * 列出仓库里所有源码文件。
 *
 * 不用 `git ls-files`（那要在 git 仓库里才跑得起来，而这个脚本也可能被拿去做
 * 别的检查）；直接走文件系统，靠目录黑名单跳过不该看的东西。
 * @returns 相对路径（用 / 分隔）的文件列表。
 */
function listSourceFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      const full = path.join(dir, entry)
      let isDirectory = false
      try {
        isDirectory = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        walk(full)
        continue
      }
      const ext = path.extname(entry)
      if (NON_SOURCE.has(ext)) continue
      if (!['.ts', '.tsx', '.mjs', '.js'].includes(ext)) continue
      out.push(path.relative(ROOT, full).split(path.sep).join('/'))
    }
  }
  walk(ROOT)
  return out
}

/**
 * 找出所有 workspace 包（带 package.json 的目录）。
 * @returns 包名 → 目录（相对路径）。
 */
function listWorkspacePackages() {
  const result = new Map()
  for (const root of ['packages', 'apps', 'vendor']) {
    const rootDir = path.join(ROOT, root)
    if (!existsSync(rootDir)) continue
    const walk = (dir, depth) => {
      if (depth > 2) return
      let entries
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue
        const full = path.join(dir, entry)
        let isDirectory = false
        try {
          isDirectory = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (!isDirectory) continue
        const manifestPath = path.join(full, 'package.json')
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
            if (typeof manifest.name === 'string') {
              result.set(manifest.name, path.relative(ROOT, full).split(path.sep).join('/'))
            }
          } catch {
            // 读不出来的 manifest 不算包。
          }
        }
        walk(full, depth + 1)
      }
    }
    walk(rootDir, 0)
  }
  return result
}

/**
 * 读一个文件的内容。
 * @param rel - 相对路径。
 * @returns 内容；读不出来是空串。
 */
function readFile(rel) {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return ''
  }
}

/** 解析 import 语句里的模块说明符。 */
const SPEC_PATTERN = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

/**
 * 解析一个相对说明符，落到仓库里的具体文件。
 * @param from - 出处的相对路径。
 * @param spec - 说明符。
 * @param files - 仓库里的文件集合。
 * @returns 命中的相对路径；没命中是 undefined。
 */
function resolveRelative(from, spec, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate
  }
  return undefined
}

/**
 * 读整个仓库里出现过的文本（源码 + 脚本 + 配置文件）。
 *
 * 只读文本类文件：源码、`.mjs` 脚本、`*.config.*`。
 * 媒体与二进制文件读进来只会撑内存，对判断没有帮助。
 *
 * **跳过 `package.json`**：依赖名本来就写在那里，把它算进去等于「凡是被声明的
 * 依赖都算用过」，规则 D 就永远报不出东西。
 * @returns 拼起来的文本。
 */
function readRepoText() {
  const parts = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      const full = path.join(dir, entry)
      let isDirectory = false
      try {
        isDirectory = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        walk(full, depth + 1)
        continue
      }
      if (entry === 'package.json') continue
      const ext = path.extname(entry)
      const isText = ['.ts', '.tsx', '.mjs', '.js', '.md'].includes(ext)
      const isConfig = entry.includes('config')
      if (!isText && !isConfig) continue
      try {
        parts.push(readFileSync(full, 'utf8'))
      } catch {
        // 读不出来就算了。
      }
    }
  }
  walk(ROOT, 0)
  return parts.join('\n')
}

/**
 * 从入口出发做可达性分析。
 * @param files - 仓库里的文件集合。
 * @param packages - 包名 → 目录。
 * @returns 可达的文件集合与可达的包名集合。
 */
function computeReachable(files, packages) {
  const reachableFiles = new Set()
  const reachablePackages = new Set()
  const queue = []

  for (const entry of ENTRY_POINTS) {
    if (files.has(entry)) queue.push(entry)
  }

  while (queue.length > 0) {
    const current = queue.pop()
    if (reachableFiles.has(current)) continue
    reachableFiles.add(current)
    const text = readFile(current)
    SPEC_PATTERN.lastIndex = 0
    let match = SPEC_PATTERN.exec(text)
    while (match !== null) {
      const spec = match[1]
      let next
      if (spec.startsWith('.')) {
        next = resolveRelative(current, spec, files)
      } else {
        // 包名：找到那个包的入口文件。
        const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        for (const [name, dir] of packages) {
          if (name !== spec && name !== root && !name.startsWith(`${root}/`)) continue
          reachablePackages.add(name)
          const index = path.join(dir, 'src', 'index.ts').split(path.sep).join('/')
          if (files.has(index)) next = index
          break
        }
      }
      if (next !== undefined && !reachableFiles.has(next)) queue.push(next)
      match = SPEC_PATTERN.exec(text)
    }
  }

  return { files: reachableFiles, packages: reachablePackages }
}

/**
 * 抽出一个文件里的值导出名。
 *
 * **只抽值导出**（const/let/var/function/class/enum），不抽类型导出：类型只在
 * 编译期存在，运行时没人引用，「没人 import 一个类型」不能说明它没用。
 * @param text - 文件内容。
 * @returns 导出名列表。
 */
function exportedValueNames(text) {
  const names = []
  const pattern =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/g
  let match = pattern.exec(text)
  while (match !== null) {
    // 模板字符串里的代码样例（`export function ${factoryName}(invoke...)`）会把
    // `${` 的 `$` 抽成一个名叫 `$` 的「导出」。真名叫 `$` 的导出后面不会紧跟
    // `{`（那是插值），据此跳过。
    const isTemplateInterpolation = match[1] === '$' && text[match.index + match[0].length] === '{'
    if (!isTemplateInterpolation) names.push(match[1])
    match = pattern.exec(text)
  }
  return names
}

/** 这个文件是不是测试。 */
function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes('/tests/')
}

const exemptions = readExemptions()
const allFiles = listSourceFiles()
const fileSet = new Set(allFiles)
const packages = listWorkspacePackages()
const reachable = computeReachable(fileSet, packages)

const violations = []
const warnings = []

// ---- 规则 A：不可达的包 ----
for (const [name, dir] of packages) {
  if (reachable.packages.has(name)) continue
  if (exemptions.packages.has(name)) continue
  if (exemptions.paths.has(dir)) continue
  violations.push({
    rule: 'A',
    detail: `包「${name}」从产品入口出发不可达：产品里没有任何路径能用到它`,
    where: dir,
  })
}

// ---- 规则 B：不可达的源码文件 ----
for (const file of allFiles) {
  if (reachable.files.has(file)) continue
  if (CONVENTIONAL_ENTRIES.has(file)) continue
  if (CONFIG_FILE_PATTERN.test(file)) continue
  if (exemptions.paths.has(file)) continue
  // **包豁免自动覆盖它里面的文件**：豁免一个包却让它的文件照旧被报，是自相矛盾。
  const inExemptPackage = [...exemptions.packages].some((name) => {
    const dir = packages.get(name)
    return dir !== undefined && file.startsWith(`${dir}/`)
  })
  if (inExemptPackage) continue
  // 测试与脚本不算：它们不由产品入口到达是**应该的**。
  if (isTestFile(file)) continue
  if (file.startsWith('scripts/')) continue
  if (file.includes('/scripts/')) continue
  if (file.startsWith('docs/')) continue
  violations.push({
    rule: 'B',
    detail: '这个源文件从产品入口出发不可达：没人 import 它',
    where: file,
  })
}

// ---- 规则 C：没被引用的值导出（只警告） ----
//
// **先把全仓源码拼成一个大字符串**：逐个导出对每个文件跑正则，是 O(导出数 × 文件数)；
// 拼成一个大串之后每个导出只扫一遍，降成 O(导出数 × 全文长度)——后者在
// 946 个文件上是几十秒对几百毫秒的差别。
//
// **要排除定义文件自己**：导出的名字在自己的定义处就出现一次，把它算进去的话
// 每个导出都算「被引用」，规则 C 就永远报不出东西。用偏移量切出「除自己以外的
// 全文」来测。
const fileTexts = allFiles.map((file) => readFile(file))
const fileSpans = []
let cursor = 0
for (const text of fileTexts) {
  fileSpans.push({ start: cursor, end: cursor + text.length })
  cursor += text.length + 1
}
const allSourceText = fileTexts.join('\n')

/**
 * 整个仓库里出现过的那些文本。
 *
 * 规则 D 用它判断「这个依赖是不是只在构建脚本与配置文件里用」——`vite`、
 * `electron-builder` 这些名字会出现在 `package.json` 的 scripts 与各种配置文件里，
 * 但源码里不会 import。它们不是「假声明」。
 */
const allRepoText = readRepoText()

const unusedExports = []
for (let index = 0; index < allFiles.length; index += 1) {
  const file = allFiles[index]
  if (isTestFile(file)) continue
  const span = fileSpans[index]
  // 除自己以外的全文：前缀 + 后缀。
  const withoutSelf = `${allSourceText.slice(0, span.start)}\n${allSourceText.slice(span.end)}`
  for (const name of exportedValueNames(fileTexts[index])) {
    const pattern = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)
    pattern.lastIndex = 0
    if (!pattern.test(withoutSelf)) unusedExports.push({ file, name })
  }
}
for (const item of unusedExports) {
  warnings.push({
    rule: 'C',
    detail: `导出「${item.name}」从来没被引用过`,
    where: item.file,
  })
}

// ---- 规则 D：声明了却没 import 的依赖 ----
//
// **查全部依赖，不只是自家的**：第三方也一样可疑——`package.json` 里写着
// `ws`，源码里一次都没 import，这份声明就是假的（装了个用不上的包，还多一份
// 安全更新的负担）。
//
// **工具类依赖不算假的**：`vite`、`electron-builder`、`jsdom` 这些是在构建脚本
// 与配置文件里用的，源码里本来就不 import。判据是「整个仓库里（源码、脚本、
// 配置）能不能找到这个名字」——找不到才是假的。
//
// 例外：上游代码（vendor）不归我们判：它的依赖关系由上游自己管。
for (const [name, dir] of packages) {
  const manifestPath = path.join(ROOT, dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
  const dirPrefix = `${dir}/`
  for (const dep of Object.keys(declared)) {
    if (dep === name) continue
    // 上游代码（vendor）不归我们判：它的依赖关系由上游自己管。
    if (dir.startsWith('vendor/')) continue
    let used = false
    for (const file of allFiles) {
      if (!file.startsWith(dirPrefix)) continue
      if (!file.includes('/src/') && !file.includes('/tests/')) continue
      const text = readFile(file)
      if (text.includes(`'${dep}'`) || text.includes(`"${dep}"`)) {
        used = true
        break
      }
    }
    if (used) continue
    // 类型包（`@types/*`）靠 TS 的类型解析生效，本来就不 import：不是假声明。
    if (dep.startsWith('@types/')) continue
    // 整个仓库里都找不到它：这份声明是假的。
    // （构建脚本、配置文件里出现的名字在 `allRepoText` 里，那不算假的。）
    if (allRepoText.includes(dep)) continue
    violations.push({
      rule: 'D',
      detail: `声明了依赖「${dep}」但源码里一次都没 import：这份声明是假的`,
      where: dir,
    })
  }
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        entryPoints: ENTRY_POINTS,
        filesScanned: allFiles.length,
        packagesScanned: packages.size,
        reachableFiles: reachable.files.size,
        reachablePackages: reachable.packages.size,
        violations,
        warnings,
        unusedExports,
      },
      null,
      2,
    ),
  )
} else {
  console.log(
    `死代码检查：读 ${allFiles.length} 个源码文件、${packages.size} 个包；` +
      `产品入口可达 ${reachable.files.size} 个文件、${reachable.packages.size} 个包。`,
  )
  console.log(`  规则 A/B/D 命中 ${violations.length} 处；规则 C 警告 ${warnings.length} 处。`)
  for (const violation of violations) {
    console.log(`  [${violation.rule}] ${violation.detail}\n      ${violation.where}`)
  }
  const shownWarnings = LIST ? warnings : warnings.slice(0, 15)
  for (const warning of shownWarnings) {
    console.log(`  [${warning.rule}] ${warning.detail}\n      ${warning.where}`)
  }
  if (warnings.length > shownWarnings.length) {
    console.log(`  …另有 ${warnings.length - shownWarnings.length} 处未列出（用 --list）`)
  }
  if (violations.length === 0) {
    console.log('  通过：没有不可达的包、没有不可达的源码文件、没有声明了却没用的依赖。')
  }
}

process.exit(violations.length === 0 ? 0 : 1)
