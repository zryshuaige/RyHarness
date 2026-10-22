#!/usr/bin/env node
/**
 * 门禁 3／4：重复代码检测（自包含、零依赖）。
 *
 * 做法：把每个 .ts/.tsx 文件切成 token 流（注释丢弃、字符串字面量归一化成
 * `'str'`），再对固定长度的滑动窗口取精确 token 串做 key。同一个 key 出现在
 * 两处以上、且两处不重叠，即判定为重复片段。用「精确 token 串」而不是哈希，
 * 是为了零碰撞——门禁报出来的每一条都能直接打开核对。
 *
 * 阈值：--threshold=<token 数>，默认 DEFAULT_THRESHOLD。阈值越低越敏感。
 *
 * 为什么 400 而不是更低（本轮实测，245 个 .ts/.tsx）：
 *   阈值 400 → 0 对；200 → 8 对（**全部**是测试对测试）；120 → 60 对（57 对是测试对测试）；
 *   80  → 196 对（186 对是测试对测试）。
 * 也就是说再往下调买到的几乎全是测试样板噪音，而不是「被漏掉的复制粘贴」。
 * 评审里提过的「排除测试目录」在这里是反着来的：95% 的重复命中本来就长在测试里，
 * 排除它等于把门禁最该盯的那块地腾空，所以测试目录留在范围内。
 *
 * 判定语义的第二个修补：滑动窗口对「整份文件本身被复制」是**结构性失明**的——
 * 窗口长度 ≥ 阈值，而两个整份复制的小文件每个都不到阈值，于是它们连一个窗口都产生不了，
 * 门禁连扫描都算不上它们（实测有 54 个文件、占 22% 落在这个洞里）。
 * 所以另加一条整文件比对，覆盖 [WHOLE_FILE_MIN, 阈值) 这一段。
 * WHOLE_FILE_MIN 取 60：再小的文件（re-export 桶、单组件壳）token 完全一致是写法惯例，
 * 不是债。实测当前全仓 0 处，所以这条只会拦住未来的新增。
 *
 * 用法：
 *   node scripts/verify-duplication.mjs                     # 0 = 无超阈值重复
 *   node scripts/verify-duplication.mjs --threshold=100     # 加严试探
 *   node scripts/verify-duplication.mjs --list              # 打印全部重复对
 *   node scripts/verify-duplication.mjs --json
 *
 * 环境变量 RYHARNESS_SCAN_ROOT=<dir>：只扫这个目录（门禁自身的用例用它喂临时夹具）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(
  process.env.RYHARNESS_SCAN_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
const JSON_OUT = process.argv.includes('--json')
const LIST = process.argv.includes('--list')

const DEFAULT_THRESHOLD = 400
/** 整文件比对的下限：低于这个体量，token 一致更可能是写法惯例而不是复制粘贴。 */
const WHOLE_FILE_MIN = 60
const thresholdArg = process.argv.find((a) => a.startsWith('--threshold='))
const THRESHOLD = thresholdArg ? Number.parseInt(thresholdArg.split('=')[1], 10) : DEFAULT_THRESHOLD
if (!Number.isInteger(THRESHOLD) || THRESHOLD < 10) {
  console.error(`无效阈值：${thresholdArg}`)
  process.exit(2)
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'lib',
  'coverage',
  'vendor',
  '.git',
  '.zcode',
  'data',
  'main',
  'out',
  '.turbo',
])
const SCAN_EXT = new Set(['.ts', '.tsx'])

/**
 * 瞬时文件判定，与另两条门禁一致：目录段 tmp/temp/scratch/draft、
 * 文件名中缀 `.tmp.` 等、探针（`__*probe*`、`foo.probe.ts`）与编辑器/合并残留。
 * 口径窄是刻意的：真实源码匹配不上，所以真实复制粘贴照样变红。
 * 命中的照旧打印出来——静默跳过等于门禁没看见它。
 */
const EPHEMERAL_DIRS = new Set(['tmp', 'temp', 'scratch', 'draft', '.tmp', '.temp', '.scratch', '.draft'])
const EPHEMERAL_BASENAMES = [
  /\.(?:tmp|temp|scratch|draft)\./iu,
  /^__.*probe.*$/iu,
  /\.probe\.[^.]+$/iu,
  /^~\$/u,
  /\.(?:orig|rej|old)$/iu,
]

/** 注释丢弃 + 字符串归一化，避免「同样的数据、不同的文案」被算成重复。 */
const TOKEN_PATTERN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*|\d[\w.]*|[^\s]/g

function tokenize(text) {
  const tokens = []
  const offsets = []
  TOKEN_PATTERN.lastIndex = 0
  let match = TOKEN_PATTERN.exec(text)
  while (match !== null) {
    const raw = match[0]
    const isComment = raw.startsWith('//') || raw.startsWith('/*')
    if (!isComment) {
      tokens.push(raw[0] === "'" || raw[0] === '"' || raw[0] === '`' ? "'str'" : raw)
      offsets.push(match.index)
    }
    match = TOKEN_PATTERN.exec(text)
  }
  return { tokens, offsets }
}

function walk(dir, parts = [], out = [], skipped = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EPHEMERAL_DIRS.has(entry.name.toLowerCase())) {
        skipped.push([...parts, entry.name].join('/'))
        continue
      }
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), [...parts, entry.name], out, skipped)
      continue
    }
    if (!entry.isFile()) continue
    if (!SCAN_EXT.has(path.extname(entry.name))) continue
    if (entry.name.endsWith('.d.ts')) continue
    if (EPHEMERAL_BASENAMES.some((pattern) => pattern.test(entry.name))) {
      skipped.push([...parts, entry.name].join('/'))
      continue
    }
    out.push({ abs: path.join(dir, entry.name), rel: [...parts, entry.name].join('/') })
  }
  return { files: out, skipped }
}

/** key → [{ file, line }]，记录出现位置用于配对。 */
const windows = new Map()
/** 整份文件被复制的 key → [rel…]，覆盖滑动窗口看不见的那一段体量。 */
const wholeFiles = new Map()
let fileCount = 0
let windowScanned = 0
let wholeFileScanned = 0
let belowFloor = 0

const { files: toScan, skipped: skippedEphemeral } = walk(ROOT)
for (const { abs, rel } of toScan) {
  fileCount++
  const text = readFileSync(abs, 'utf8')
  const { tokens, offsets } = tokenize(text)
  if (tokens.length < THRESHOLD) {
    if (tokens.length >= WHOLE_FILE_MIN) {
      wholeFileScanned++
      const key = tokens.join(' ')
      if (!wholeFiles.has(key)) wholeFiles.set(key, [])
      wholeFiles.get(key).push(rel)
    } else {
      belowFloor++
    }
    continue
  }
  windowScanned++
  // 行号用游标推进而不是每个窗口重扫一次全文：offsets 单调递增，于是这一遍是 O(文件长度)，
  // 而按位置回扫是 O(窗口数 × 文件长度)——后者让门禁慢到大家都不跑它。
  let line = 1
  let cursor = 0
  for (let i = 0; i + THRESHOLD <= tokens.length; i++) {
    while (cursor < offsets[i]) {
      if (text.charCodeAt(cursor) === 10) line++
      cursor++
    }
    const key = tokens.slice(i, i + THRESHOLD).join(' ')
    if (!windows.has(key)) windows.set(key, [])
    windows.get(key).push({ file: rel, line, start: i })
  }
}

/** 收集重复对：同 key 出现在两处以上、且位置不重叠（起点间隔 ≥ 阈值）。 */
const pairs = []
const seenPairKeys = new Set()
for (const [, sites] of windows) {
  if (sites.length < 2) continue
  for (let a = 0; a < sites.length; a++) {
    for (let b = a + 1; b < sites.length; b++) {
      const first = sites[a]
      const second = sites[b]
      if (first.file === second.file && Math.abs(first.start - second.start) < THRESHOLD) continue
      const key = `${first.file}:${first.line}|${second.file}:${second.line}`
      if (seenPairKeys.has(key)) continue
      seenPairKeys.add(key)
      pairs.push({ a: first, b: second })
    }
  }
}
/** 同一对文件反复命中只报一次，避免长块被拆成上百条噪音。 */
const byFilePair = new Map()
for (const pair of pairs) {
  const key = pair.a.file <= pair.b.file ? `${pair.a.file}|${pair.b.file}` : `${pair.b.file}|${pair.a.file}`
  if (!byFilePair.has(key)) byFilePair.set(key, pair)
}
const reported = [...byFilePair.values()]

/** 整文件复制：两个文件的 token 流完全一样，且都落在滑动窗口看不见的体量段里。 */
const wholeFileHits = []
for (const [, files] of wholeFiles) {
  if (files.length < 2) continue
  for (let i = 0; i < files.length - 1; i++) {
    for (let j = i + 1; j < files.length; j++) {
      wholeFileHits.push({ a: files[i], b: files[j] })
    }
  }
}

const violations = reported.length + wholeFileHits.length
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        threshold: THRESHOLD,
        filesRead: fileCount,
        windowScanned,
        wholeFileScanned,
        belowFloor,
        pairHits: pairs.length,
        filePairs: reported.length,
        wholeFileHits,
        reported,
        skippedEphemeral,
      },
      null,
      2,
    ),
  )
} else {
  // 三个「扫了多少」必须分开报：只说「扫描 N 个文件」会让人以为那些没被算的文件也看过，
  // 而实际上它们一个窗口都产生不了。
  console.log(
    `重复代码检查（阈值 ${THRESHOLD} token）：读 ${fileCount} 个文件，其中 ${windowScanned} 个做滑窗比对、` +
      `${wholeFileScanned} 个做整文件比对（滑窗看不见的 ${WHOLE_FILE_MIN}~${THRESHOLD} token 段）、` +
      `${belowFloor} 个体量太小不参与。`,
  )
  console.log(
    `  滑窗命中 ${pairs.length} 个重复片段，涉及 ${reported.length} 对文件；整文件复制 ${wholeFileHits.length} 对。`,
  )
  const shown = LIST ? reported : reported.slice(0, 20)
  for (const pair of shown) {
    console.log(`  ${pair.a.file}:${pair.a.line}  <->  ${pair.b.file}:${pair.b.line}`)
  }
  for (const hit of LIST ? wholeFileHits : wholeFileHits.slice(0, 20)) {
    console.log(`  整文件复制：${hit.a}  <->  ${hit.b}`)
  }
  const hidden = LIST
    ? 0
    : Math.max(0, reported.length + wholeFileHits.length - shown.length - Math.min(20, wholeFileHits.length))
  if (hidden > 0) console.log(`  …另有 ${hidden} 对文件未列出（用 --list）`)
  if (skippedEphemeral.length > 0) {
    console.log(
      `  已跳过 ${skippedEphemeral.length} 个瞬时文件（并行 agent / 测试探针的临时产物）：${skippedEphemeral
        .slice(0, 5)
        .join('、')}${skippedEphemeral.length > 5 ? '…' : ''}`,
    )
  }
  if (violations === 0) console.log(`  通过：没有 ≥ ${THRESHOLD} token 的重复片段，也没有整文件复制。`)
}

process.exit(violations === 0 ? 0 : 1)
