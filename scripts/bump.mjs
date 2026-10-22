/**
 * 统一版本脚本：版本号只在一处改。
 *
 * RyHarness 的 20 个工作区包各自带一份 `version`，加上根 package.json、「我的」页
 * 的展示版本与 CHANGELOG 头部，一次发版要手工同步 4 类位置，漏任何一处都会让
 * 安装包文件名、依赖图与变更记录互相矛盾。根 package.json 是唯一真值来源：
 * `--check` 只读校验（CI 与发版前跑），`--set` 一次改完全部位置并写 CHANGELOG 头部。
 *
 * 用法：
 *   node scripts/bump.mjs --check [--tag auto|v1.2.3]
 *   node scripts/bump.mjs --set 1.2.3 [--date 2026-10-14] [--dry-run]
 *   node scripts/bump.mjs 1.2.3            # 等价于 --set 1.2.3
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const changelogPath = join(repoRoot, 'CHANGELOG.md')
const displayVersionPath = join(repoRoot, 'apps/desktop/renderer/src/components/MePage.tsx')
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const displayVersionPattern = /v\d+\.\d+\.\d+/
const unreleasedPlaceholder = '暂无。'

const rel = (path) => relative(repoRoot, path).replaceAll('\\', '/')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/** pnpm-workspace.yaml 的 packages 列表。只支持 `a/*`、`a/b/*` 这类单段通配，多级写法不认。 */
function workspacePatterns() {
  const patterns = []
  let inPackages = false
  for (const line of readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split(/\r?\n/)) {
    if (/^packages:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages || line.trim() === '' || /^\S/.test(line)) {
      inPackages = false
      continue
    }
    const item = /^\s+-\s*(.+?)\s*$/.exec(line)
    if (item !== null) patterns.push(item[1].replace(/^["']|["']$/g, ''))
  }
  return patterns
}

function expandPattern(pattern) {
  const segments = pattern.split('/')
  let dirs = [repoRoot]
  for (const segment of segments) {
    const next = []
    for (const dir of dirs) {
      if (segment !== '*') {
        if (existsSync(join(dir, segment))) next.push(join(dir, segment))
        continue
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        // 中间段（packages/llm 这类分组目录）本身没有 package.json，不能在这里
        // 过滤，否则 packages/*/* 会整片落空。
        const child = join(dir, entry.name)
        if (existsSync(child)) next.push(child)
      }
    }
    dirs = next
  }
  // 只有叶子段才是包目录；包目录是软链时 existsSync 同样成立。
  const last = segments[segments.length - 1]
  return last === '*' ? dirs.filter((dir) => existsSync(join(dir, 'package.json'))) : dirs
}

/** 根 + 全部工作区包的 package.json，按路径排序。 */
function managedPackageJson() {
  const files = [join(repoRoot, 'package.json')]
  for (const pattern of workspacePatterns()) {
    for (const dir of expandPattern(pattern)) {
      const file = join(dir, 'package.json')
      if (!files.includes(file)) files.push(file)
    }
  }
  return files.sort((a, b) => rel(a).localeCompare(rel(b)))
}

/** 按 `## [x.y.z]` 切块；第一个标题之前的行归 preamble。 */
function parseChangelog(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  let current
  let firstHeading = lines.length
  for (const [index, line] of lines.entries()) {
    const heading = /^## \[([^\]]+)\]/.exec(line)
    if (heading !== null) {
      current = { version: heading[1], line, bodyLines: [] }
      sections.push(current)
      if (current === sections[0]) firstHeading = index
      continue
    }
    if (current !== undefined) current.bodyLines.push(line)
  }
  return { lines, sections, firstHeading }
}

function checkTag(version, tagOption) {
  const problems = []
  const notes = []
  const tag = tagOption === 'auto' ? git(['describe', '--tags', '--abbrev=0']) : tagOption
  if (tag === undefined || tag === '') {
    notes.push(tagOption === 'auto' ? '仓库还没有任何 tag，跳过 tag 校验' : '未提供 tag，跳过 tag 校验')
    return { problems, notes }
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) === undefined) {
    problems.push(`仓库中不存在 tag ${tag}（发版前请先 git tag ${tag} 并推送）`)
    return { problems, notes }
  }
  const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag
  if (tagVersion !== version) problems.push(`tag ${tag} 的版本 ${tagVersion} ≠ package.json 版本 ${version}`)
  return { problems, notes, tagVersion }
}

function runCheck(tagOption) {
  const version = readJson(join(repoRoot, 'package.json')).version
  const problems = []
  const notes = []

  if (typeof version !== 'string' || !semver.test(version)) {
    problems.push(`根 package.json 的 version 不是合法 semver：${String(version)}`)
    return { problems, notes, version }
  }

  const packages = managedPackageJson()
  for (const file of packages) {
    const actual = readJson(file).version
    if (actual !== version) problems.push(`${rel(file)}：${String(actual)} ≠ ${version}`)
  }

  const display = readFileSync(displayVersionPath, 'utf8').match(displayVersionPattern)
  if (display === null) notes.push(`${rel(displayVersionPath)} 里找不到 vX.Y.Z 展示版本，跳过该项校验`)
  else if (display[0] !== `v${version}`) problems.push(`${rel(displayVersionPath)}：${display[0]} ≠ v${version}`)

  const text = readFileSync(changelogPath, 'utf8')
  const { sections } = parseChangelog(text)
  const unreleased = sections.find((section) => section.version === 'Unreleased')
  if (unreleased === undefined) problems.push('CHANGELOG.md 缺少 [Unreleased] 小节')
  const released = sections.find((section) => section.version === version)
  if (released === undefined) {
    problems.push(`CHANGELOG.md 缺少 [${version}] 发布小节（用 --set 写，或手工补上并写明日期）`)
  }
  const firstReleased = sections.find((section) => section.version !== 'Unreleased')

  if (tagOption !== undefined) {
    const tagResult = checkTag(version, tagOption)
    problems.push(...tagResult.problems)
    notes.push(...tagResult.notes)
    if (
      tagResult.tagVersion !== undefined &&
      firstReleased !== undefined &&
      firstReleased.version !== tagResult.tagVersion
    ) {
      problems.push(`CHANGELOG.md 最新发布小节是 [${firstReleased.version}]，与 tag ${tagOption} 不一致`)
    }
  }

  return { problems, notes, version, packages: packages.length, firstReleased }
}

/**
 * 把 CHANGELOG 重排成：文件头 + [Unreleased]（占位） + 新版本小节（承接原
 * Unreleased 正文）+ 原样保留的历史小节。纯函数：出问题时调用方还没落过盘。
 */
function renderChangelog(text, version, date) {
  const { lines, sections, firstHeading } = parseChangelog(text)
  if (sections.length === 0) throw new Error('CHANGELOG.md 里找不到任何 `## [x.y.z]` 小节')
  const unreleasedIndex = sections.findIndex((section) => section.version === 'Unreleased')
  if (unreleasedIndex === -1) throw new Error('CHANGELOG.md 缺少 [Unreleased] 小节，无法写入新版本')
  if (sections.some((section) => section.version === version)) {
    throw new Error(`CHANGELOG.md 已有 [${version}] 小节；换一个版本号，或手工合并后再跑`)
  }

  const pending = sections[unreleasedIndex].bodyLines.join('\n').trim()
  const promoted =
    pending === '' || pending === unreleasedPlaceholder ? '（占位：发布前请替换为本轮实际变更）' : pending
  const out = lines.slice(0, firstHeading)
  for (const [index, section] of sections.entries()) {
    if (index === unreleasedIndex) {
      out.push(section.line, '', unreleasedPlaceholder, '', `## [${version}] - ${date}`, '', promoted, '')
      continue
    }
    out.push(section.line, '', ...trimBlankEnds(section.bodyLines), '')
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function trimBlankEnds(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start += 1
  while (end > start && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end)
}

function runSet(version, dateOption, dryRun) {
  if (!semver.test(version)) throw new Error(`版本号不是合法 semver：${version}`)
  const current = readJson(join(repoRoot, 'package.json')).version
  const date = dateOption ?? new Date().toISOString().slice(0, 10)
  // 先把 CHANGELOG 排好再动版本字段：这步会抛错，抛错时仓库必须一个字节都没改。
  const nextChangelog = renderChangelog(readFileSync(changelogPath, 'utf8'), version, date)

  const changed = []
  for (const file of managedPackageJson()) {
    const text = readFileSync(file, 'utf8')
    if (readJson(file).version === version) continue
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
    if (next === text) throw new Error(`${rel(file)} 里没有可替换的 version 字段`)
    changed.push(rel(file))
    if (!dryRun) writeFileSync(file, next)
  }
  const displayText = readFileSync(displayVersionPath, 'utf8')
  const display = displayText.match(displayVersionPattern)
  if (display !== null && display[0] !== `v${version}`) {
    changed.push(rel(displayVersionPath))
    if (!dryRun) writeFileSync(displayVersionPath, displayText.replace(displayVersionPattern, `v${version}`))
  }
  if (!dryRun) writeFileSync(changelogPath, nextChangelog)
  changed.push(rel(changelogPath))
  console.log(`${dryRun ? '[dry-run] ' : ''}版本 ${current} → ${version}（${date}），改动 ${changed.length} 个文件：`)
  for (const file of changed) console.log(`  ${file}`)
}

function usage() {
  console.log(
    [
      '用法：',
      '  node scripts/bump.mjs --check [--tag auto|v1.2.3]',
      '  node scripts/bump.mjs --set 1.2.3 [--date 2026-10-14] [--dry-run]',
      '  node scripts/bump.mjs 1.2.3',
    ].join('\n'),
  )
}

function main() {
  const argv = process.argv.slice(2)
  const positionals = []
  let mode
  let tag
  let date
  let dryRun = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') mode = 'check'
    else if (arg === '--set') mode = 'set'
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--tag') {
      i += 1
      tag = argv[i]
      if (tag === undefined) throw new Error('--tag 需要一个值（auto 或 v1.2.3）')
    } else if (arg === '--date') {
      i += 1
      date = argv[i]
      if (date === undefined) throw new Error('--date 需要一个值（YYYY-MM-DD）')
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
    else positionals.push(arg)
  }

  // 裸传版本号（`bump.mjs 1.2.3`）就是 --set，省一个开关。
  if (mode === undefined && positionals.length === 1) mode = 'set'

  if (mode === undefined || (mode === 'set' && positionals[0] === undefined)) {
    usage()
    process.exit(1)
  }

  if (mode === 'set') {
    runSet(positionals[0], date, dryRun)
    return
  }

  const result = runCheck(tag)
  for (const note of result.notes) console.log(`  提示：${note}`)
  if (result.problems.length > 0) {
    console.error('版本校验失败：')
    for (const problem of result.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`版本校验通过：${result.version}`)
  if (result.packages !== undefined) console.log(`  package.json × ${result.packages}`)
  if (result.firstReleased !== undefined) console.log(`  CHANGELOG 最新发布小节：[${result.firstReleased.version}]`)
}

// 用法错误走人话一行 + exit 2，而不是整页 stack trace：CI 里这段输出会直接
// 出现在 Actions 日志里。
try {
  main()
} catch (error) {
  console.error(`bump：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
