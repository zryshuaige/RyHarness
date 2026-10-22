#!/usr/bin/env node
/**
 * 门禁 2／4：workspace 包内引用了 `@ryharness/*`，就必须在自身 package.json 里声明。
 *
 * 为什么：仓库里有「只在测试里 import、但 package.json 没写」的跨包引用。这类
 * 缺失不会让本地 install 报错（hoisted node_modules 兜住了），但会让干净 clone
 * 或依赖提升策略变化后的 CI 直接炸，属于典型的「包依赖缺失」退化。
 *
 * 判定范围：每个 workspace 包（apps 与 packages 下各级、以及 vendor）下路径含
 * src/ 或 tests/ 的 .ts/.tsx/.mts/.cts 文件里的 `@ryharness/xxx` 导入。
 * 已声明集合 = dependencies + devDependencies + peerDependencies +
 * optionalDependencies（peer 也算声明：本仓用 peer 表达「由宿主提供」的运行时
 * 依赖，如 @ryharness/cordis，把 peer 排除会造成大批假阳性）。
 *
 * 用法：
 *   node scripts/verify-package-deps.mjs          # 0 = 全部已声明
 *   node scripts/verify-package-deps.mjs --json
 *   node scripts/verify-package-deps.mjs --list   # 附带打印每个已声明依赖的引用文件
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const LIST = process.argv.includes('--list')

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
  '.turbo',
])
const SCAN_EXT = new Set(['.ts', '.tsx', '.mts', '.cts'])
const SPEC_PATTERNS = [
  /from\s*['"](@ryharness\/[^'"]+)['"]/g,
  /import\s*\(\s*['"](@ryharness\/[^'"]+)['"]\s*\)/g,
  /require\(\s*['"](@ryharness\/[^'"]+)['"]\s*\)/g,
  /import\s+['"](@ryharness\/[^'"]+)['"]/g,
]

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) out.push(path.join(dir, entry.name))
  }
  return out
}

/** workspace 成员：按 pnpm-workspace.yaml 的 glob 手工展开，避免依赖 YAML 解析器。 */
function workspaceDirs() {
  const roots = ['apps', 'packages', 'packages/*', 'vendor']
  const dirs = []
  for (const pattern of roots) {
    if (!pattern.includes('*')) {
      const abs = path.join(ROOT, pattern)
      if (!existsSync(abs)) continue
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(abs, entry.name))
      }
      continue
    }
    const parent = path.join(ROOT, pattern.split('/')[0])
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(parent, entry.name))
    }
  }
  return dirs.filter((d) => existsSync(path.join(d, 'package.json')))
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

const violations = []
const summary = []
for (const dir of workspaceDirs()) {
  const manifestPath = path.join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const self = manifest.name
  const rel = path.relative(ROOT, dir).split(path.sep).join('/')
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])

  /** dependency → 引用位置（只在路径里带 src/ 或 tests/ 的文件上判定）。 */
  const used = new Map()
  for (const abs of walk(dir)) {
    const relFile = path.relative(ROOT, abs).split(path.sep).join('/')
    const segments = relFile.split('/')
    if (!segments.includes('src') && !segments.includes('tests')) continue
    const text = readFileSync(abs, 'utf8')
    for (const pattern of SPEC_PATTERNS) {
      pattern.lastIndex = 0
      let match = pattern.exec(text)
      while (match !== null) {
        const rootName = match[1].split('/').slice(0, 2).join('/')
        if (rootName !== self) {
          if (!used.has(rootName)) used.set(rootName, [])
          used.get(rootName).push(`${relFile}:${lineOf(text, match.index)}`)
        }
        match = pattern.exec(text)
      }
    }
  }

  const missing = [...used.keys()].filter((dep) => !declared.has(dep)).sort()
  summary.push({ package: rel, name: self, imports: used.size, declared: declared.size, missing })
  if (missing.length > 0)
    violations.push({ package: rel, name: self, missing, sites: missing.flatMap((m) => used.get(m)) })
  else if (LIST) console.log(`${rel} (${self})：${used.size} 个跨包引用，全部已声明。`)
}

if (JSON_OUT) {
  console.log(JSON.stringify({ violations, summary }, null, 2))
} else {
  console.log(`包依赖声明检查：扫描 ${summary.length} 个 workspace 包，缺失声明的包 ${violations.length} 个。`)
  for (const v of violations) {
    console.log(`\n  ${v.package} (${v.name}) 缺少声明：${v.missing.join(', ')}`)
    for (const site of v.sites.slice(0, 8)) console.log(`    ${site}`)
    if (v.sites.length > 8) console.log(`    …另有 ${v.sites.length - 8} 处引用`)
  }
  if (violations.length === 0) console.log('  通过：所有跨包引用都已在自身 package.json 声明。')
}

process.exit(violations.length === 0 ? 0 : 1)
