#!/usr/bin/env node
/**
 * 门禁 1／4：禁止 `as unknown as` 双重断言。
 *
 * 为什么：`as unknown as` 会一次性抹掉两侧类型，是类型逃逸最隐蔽的形状——
 * 编译器不再校验任何字段，被断言的接口重构后也不会报错。这是「死代码/类型
 * 逃逸」两类退化的共同入口，所以全仓禁止。
 *
 * 收敛策略：冻结基线（ratchet）。全仓当前 76 处，分布在 37 个文件，全部落在
 * 本次改动所有权之外（测试替身 74 处 + 生产代码 2 处），无法本轮回清。因此
 * 已有位置按「文件 + 允许条数」登记并逐条写明理由，任何新文件、或任一文件
 * 超出登记条数，立即 exit 1。--strict 关闭白名单，用于跟踪清零进度。
 *
 * 瞬时文件不计入基线（见 isEphemeral）：并行 agent 的临时产物、测试探针不该让门禁乱红。
 * 口径与 verify-biome-budget.mjs 一致，且同样刻意收窄——跳过会打印出来，不静默放过。
 *
 * 用法：
 *   node scripts/verify-no-unknown-casts.mjs            # 冻结基线校验，0 = 通过
 *   node scripts/verify-no-unknown-casts.mjs --strict   # 白名单失效，有命中即 1
 *   node scripts/verify-no-unknown-casts.mjs --json     # 机器可读输出
 *
 * 环境变量 RYHARNESS_SCAN_ROOT=<dir>：只扫这个目录（门禁自身的用例用它喂临时夹具）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(
  process.env.RYHARNESS_SCAN_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)
/** 本脚本自身：扫描时排除（它的检测目标就是本文件里的字面量）。 */
const SELF_PATH = fileURLToPath(import.meta.url)
const STRICT = process.argv.includes('--strict')
const JSON_OUT = process.argv.includes('--json')

/** 扫描范围：全仓源码与脚本，排除构建产物、依赖与 vendor（vendor 是第三方镜像）。 */
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
const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js'])
const HIT_PATTERN = /\bas\s+unknown\s+as\b/g

/**
 * 瞬时文件判定，与 verify-biome-budget.mjs 同一套判据（这里必须一致：两条门禁在
 * 「什么算临时产物」上给出不同答案时，排查一次乱红要读两个文件）。
 * 三条腿只认路径形状——目录段 tmp/temp/scratch/draft、文件名中缀 `.tmp.` 等、
 * 以及探针/编辑器残留名。真实源码匹配不上，所以真实新增的 `as unknown as` 照样变红。
 */
const EPHEMERAL_DIRS = new Set(['tmp', 'temp', 'scratch', 'draft', '.tmp', '.temp', '.scratch', '.draft'])
const EPHEMERAL_BASENAMES = [
  /\.(?:tmp|temp|scratch|draft)\./iu,
  /^__.*probe.*$/iu,
  /\.probe\.[^.]+$/iu,
  /^~\$/u,
  /\.(?:orig|rej|old)$/iu,
]

function isEphemeral(rel) {
  const parts = rel.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (EPHEMERAL_DIRS.has(parts[i].toLowerCase())) return true
  }
  return EPHEMERAL_BASENAMES.some((pattern) => pattern.test(parts[parts.length - 1]))
}

/**
 * 先把注释与字符串字面量抹成空白（保留换行以保证行号不变），再匹配。
 * 不这么做的话，本文件自己的文档注释、以及任何在字符串里提到这个写法的代码
 * 都会被算成命中——门禁不能把自己的说明当成违规。
 */
const NON_CODE_PATTERN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g

function stripNonCode(text) {
  return text.replace(NON_CODE_PATTERN, (match) => match.replace(/[^\n]/g, ' '))
}

/**
 * 冻结基线。max = 该文件当前允许出现的 `as unknown as` 条数；只准减不准增。
 * 每条都必须有理由——没有理由的位置请直接改代码，不要往这里加。
 */
const ALLOWLIST = new Map()

const REASON_TEST_DOUBLE =
  '测试替身：只用少数字段伪造完整接口（Vitest 部分 mock / 伪造 Response、Message、ApiClient 等）。' +
  '删掉需要重写全部用例的构造方式，超出本轮范围；新增一律拒绝。'
const REASON_GLOBAL_INJECTION =
  '测试注入全局：向 window 挂载宿主注入的全局变量（__RYHARNESS_API_BASE__ / __RYHARNESS_BOOT__ 等），' +
  'window 类型上没有这些字段。'
const REASON_HOST_BOUNDARY =
  '生产代码：宿主/驱动边界的类型重解释——DOM window 上没有宿主注入的全局 token 字段；' +
  'node:sqlite 把 BLOB 读成 Buffer，需要按底层 ArrayBuffer 视图重解释 Float32。'

function allowCounts(entries, reason) {
  for (const [file, max] of Object.entries(entries)) {
    ALLOWLIST.set(file, { max, reason })
  }
}

allowCounts(
  {
    'apps/desktop/tests/design-system.test.tsx': 2,
    'apps/desktop/tests/desktop-resident.test.ts': 5,
    'apps/desktop/tests/failure-a11y.test.tsx': 3,
    'apps/desktop/tests/interaction-p0.test.tsx': 5,
    'apps/desktop/tests/memory-health-usage.test.tsx': 2,
    // persona-ui.test.tsx 随本轮新增入库（替身里伪造 ApiClient），不登记则第一个跑门禁的 PR 即红。
    'apps/desktop/tests/persona-ui.test.tsx': 2,
    'apps/desktop/tests/tool-history.test.tsx': 1,
    'apps/desktop/tests/product-closure.test.tsx': 2,
    'apps/desktop/tests/renderer-wiring.test.tsx': 2,
    'apps/desktop/tests/store-bounds.test.ts': 2,
    'apps/desktop/tests/welcome-landing.test.tsx': 3,
    'apps/server/tests/providers.test.ts': 2,
    'packages/agent/tests/loop-concurrency.test.ts': 3,
    'packages/agent/tests/loop.test.ts': 2,
    'packages/agent/tests/memory-hooks.test.ts': 2,
    'packages/evolve/tests/consolidation.test.ts': 1,
    'packages/evolve/tests/evolve.test.ts': 1,
    // dispatcher.test.ts 随交接工具（handoff）用例增长：伪造 LlmRuntime 观察
    // 工具调用与接力 prompt——「接手成员有没有拿到任务」只能通过请求体断言。
    'packages/group/tests/dispatcher.test.ts': 5,
    // 路由名单 / 交接格式两份用例：member() 替身伪造 AgentDefinition。
    'packages/group/tests/handoff-format.test.ts': 1,
    'packages/group/tests/routing-roster.test.ts': 1,
    'packages/group/tests/fanout-memory.test.ts': 3,
    'packages/group/tests/fanout.test.ts': 6,
    'packages/memory/tests/llm.test.ts': 2,
    'packages/memory/tests/store.test.ts': 2,
    'packages/session/tests/coordinator.test.ts': 4,
    // 本轮新增的三份会话包用例：同样是测试替身模式（伪造 LlmRuntime、
    // spyOn 原型方法、把重建结果当只读数组断言）。棘轮照旧——只允许登记条数，
    // 任何增长会让 CI 变红。
    'packages/session/tests/artifacts.test.ts': 1,
    'packages/session/tests/first-token-recall.test.ts': 1,
    // 记忆钩子 this 语义的回归用例：伪造 LlmRuntime（只实现 stream）以观察每个
    // 成员实际收到的 system 注入块——注入块正是「有没有退回 await 路径」的唯一
    // 外部证据，断言不了它就只能断言内部调用次数，而退化恰好不改变调用次数。
    'packages/session/tests/memory-hook-binding.test.ts': 1,
    'packages/group/tests/fanout-memory-binding.test.ts': 1,
    'packages/session/tests/history-read.test.ts': 2,
    'packages/session/tests/store-transaction.test.ts': 2,
    'packages/session/tests/tool-history.test.ts': 1,
  },
  REASON_TEST_DOUBLE,
)

allowCounts(
  {
    'apps/desktop/tests/app-list-wiring.test.tsx': 3,
    'apps/desktop/tests/boot-trace.test.ts': 1,
    'apps/server/tests/usage-health.test.ts': 1,
    'packages/session/tests/coordinator-wiring.test.ts': 1,
    'packages/session/tests/quota-wiring.test.ts': 1,
  },
  REASON_GLOBAL_INJECTION,
)

allowCounts(
  {
    'apps/desktop/renderer/src/api.ts': 1,
    'packages/memory/src/store.ts': 1,
  },
  REASON_HOST_BOUNDARY,
)

allowCounts(
  {
    'apps/desktop/tests/chatview-closure.test.tsx': 1,
    'apps/desktop/tests/chatview-motion.test.tsx': 1,
    'apps/desktop/tests/content-channel.test.tsx': 1,
    'apps/desktop/tests/memory-panel.test.tsx': 1,
    'apps/desktop/tests/proactive-message.test.tsx': 1,
    'apps/desktop/tests/wave8-wiring.test.ts': 1,
    'packages/agent/tests/evolution-hooks.test.ts': 3,
    'packages/agent/tests/loop-cancel-usage.test.ts': 1,
    'packages/agent/tests/quota.test.ts': 1,
  },
  REASON_TEST_DOUBLE,
)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!SCAN_EXT.has(path.extname(entry.name))) continue
    if (entry.name.endsWith('.d.ts')) continue
    // 校验脚本自己必然包含被禁的字面量（它就是检测目标本身），
    // 不排除就会永远自伤：这里把自己跳出扫描范围。
    if (path.resolve(dir, entry.name) === SELF_PATH) continue
    out.push(path.join(dir, entry.name))
  }
  return out
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

const findings = []
const skippedEphemeral = []
for (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  if (isEphemeral(rel)) {
    skippedEphemeral.push(rel)
    continue
  }
  const text = readFileSync(abs, 'utf8')
  const code = stripNonCode(text)
  const hits = []
  HIT_PATTERN.lastIndex = 0
  let match = HIT_PATTERN.exec(code)
  while (match !== null) {
    hits.push({
      line: lineOf(code, match.index),
      snippet: code
        .slice(match.index, match.index + 80)
        .split('\n')[0]
        .trim(),
    })
    match = HIT_PATTERN.exec(code)
  }
  if (hits.length > 0) findings.push({ file: rel, count: hits.length, hits })
}

const violations = []
let allowedSites = 0
for (const finding of findings) {
  const entry = STRICT ? undefined : ALLOWLIST.get(finding.file)
  if (entry && finding.count <= entry.max) {
    allowedSites += finding.count
    continue
  }
  violations.push({
    file: finding.file,
    count: finding.count,
    allowed: entry?.max ?? 0,
    reason: entry ? '超出冻结基线：条数增长' : STRICT ? 'strict 模式下白名单失效' : '未登记：新增文件',
    hits: finding.hits,
  })
}

const scannedFiles = findings.reduce((sum, f) => sum + f.count, 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ total: scannedFiles, allowed: allowedSites, violations, skippedEphemeral }, null, 2))
} else {
  console.log(
    `as unknown as 检查：全仓命中 ${scannedFiles} 处 / ${findings.length} 个文件；冻结基线放行 ${allowedSites} 处，违规 ${violations.length} 处。`,
  )
  // 跳过的瞬时文件要留痕：静默跳过等于门禁没看见它。
  if (skippedEphemeral.length > 0) {
    console.log(
      `  已跳过 ${skippedEphemeral.length} 个瞬时文件（不计入基线）：${skippedEphemeral.slice(0, 5).join('、')}${skippedEphemeral.length > 5 ? '…' : ''}`,
    )
  }
  for (const v of violations) {
    console.log(`\n  违规 ${v.file}：${v.count} 处（基线允许 ${v.allowed}）— ${v.reason}`)
    for (const h of v.hits.slice(0, 5)) console.log(`    ${v.file}:${h.line}  ${h.snippet}`)
    if (v.hits.length > 5) console.log(`    …另有 ${v.hits.length - 5} 处`)
  }
  if (violations.length === 0) console.log('  通过：没有新增 `as unknown as`。')
}

process.exit(violations.length === 0 ? 0 : 1)
