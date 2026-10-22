#!/usr/bin/env node
/**
 * 门禁 4／4：biome 告警的冻结基线（棘轮）。
 *
 * 为什么要有它：`biome check` 只在出现 error 时才非 0 退出，而本仓这五条规则全挂在
 * warn 上，于是「559 条 warning、exit 0」——等于没有门禁。更糟的是构成极不均衡：
 * `noNonNullAssertion` 一条就占 522 条（93%），剩下 37 条真正的正确性问题
 * （useExhaustiveDependencies 18、noUnusedImports 13、noUnusedVariables 7、
 * useTemplate 1）完全被它淹没，评审时根本没人看得见。
 *
 * 做法与 `verify-no-unknown-casts.mjs` 同一套棘轮：按「规则 + 文件」登记当前条数，
 * 只准减不准增。任何新文件出现这五条规则的命中、或任一文件超出登记条数，立即 exit 1。
 * 计数直接取 biome 自己的 JSON 报告，不另写正则扫描器——门禁与工具对「什么算违规」
 * 必须是同一个定义，否则基线会假绿。
 *
 * 存量变少时只告警不拦截：那正是清债的好时机，不该用红叉拦住一个已经更干净的 PR；
 * 但基线要跟着往下调，否则额度会在一次次「先修后加」里悄悄松回去。
 *
 * 瞬时文件不计入基线（见 EPHEMERAL_*）：并行 agent 的临时产物、测试探针、编辑器残留，
 * 都不该让门禁变红。门禁乱红一次，贡献者就开始无视它——那比门禁松更糟。口径刻意收窄到
 * 「路径本身就在说自己是临时的」，真实源码匹配不上；匹配上的文件仍会被打印出来，
 * 免得有人不小心把探针提交进仓还不知道。
 *
 * 用法：
 *   node scripts/verify-biome-budget.mjs           # 冻结基线校验，0 = 通过
 *   node scripts/verify-biome-budget.mjs --json    # 机器可读输出
 *   node scripts/verify-biome-budget.mjs --list    # 附带打印每条规则的文件分布
 *   node scripts/verify-biome-budget.mjs --freeze  # 清完债后把实测值写回基线（随提交一起评审）
 *
 * 环境变量 RYHARNESS_BIOME_REPORT=<file>：读一份现成的 biome JSON 报告而不真的跑 biome。
 * 存在的理由是让门禁本身可测（见 apps/desktop/tests/lint-coverage.test.tsx）——门禁的正确性
 * 以前只能靠「相信它」，而它一旦在某次并行运行里乱红过一次就没人再信了。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const LIST = process.argv.includes('--list')
const FREEZE = process.argv.includes('--freeze')
/** biome 默认只报 20 条诊断，不调高的话基线会凭空少掉几百条。 */
const MAX_DIAGNOSTICS = 20_000
const BIOME_ENTRY = path.join(ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome')

if (!existsSync(BIOME_ENTRY)) {
  console.error(`找不到 biome 可执行入口：${BIOME_ENTRY}（先 pnpm install）`)
  process.exit(2)
}

function runBiome() {
  // 注入的报告只给门禁自身的用例用（见文件头 RYHARNESS_BIOME_REPORT）：
  // 「跑一次全仓 biome」当断言太慢也太脆，而门禁的错误恰恰出在比对逻辑里。
  const injected = process.env.RYHARNESS_BIOME_REPORT
  if (injected) return parseReport(readFileSync(injected, 'utf8'), injected)
  const result = spawnSync(
    process.execPath,
    [BIOME_ENTRY, 'check', '.', '--reporter=json', `--max-diagnostics=${MAX_DIAGNOSTICS}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  if (result.error) {
    console.error(`biome 执行失败：${result.error.message}`)
    process.exit(2)
  }
  // biome 有 error 时退出码非 0，但 JSON 报告照样打在 stdout 上——这里要的正是那份报告。
  return parseReport(result.stdout, 'biome 的 stdout')
}

function parseReport(raw, origin) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.error(`无法解析 biome 的 JSON 报告（${origin} 前 400 字）：\n${raw.slice(0, 400)}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

/**
 * 瞬时文件判定。三条腿都只认「路径自己在说自己是临时的」：
 * 1. 任一目录段等于 tmp/temp/scratch/draft（含点号变体）——并行 agent 的临时目录；
 * 2. 文件名里带 `.tmp.`/`.temp.`/`.scratch.`/`.draft.` 这类中缀标记；
 * 3. 文件名本身就是探针或编辑器/合并残留（`__*probe*`、`foo.probe.ts`、`~$x.ts`、`a.orig`）。
 *
 * 为什么不做得更宽：真实回归必须在这些规则下依然变红。判据只看得见「形状」，
 * 看不见「意图」——所以宁可漏掉一种奇葩临时文件，也不能让一条真实的新增非空断言溜过去。
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

/** 规则 → { total, files: Map<相对路径, 当前条数> }。total 由 files 求出，不手写。 */
const BASELINE = new Map()

/**
 * total 手写过一次，代价是它会和 files 悄悄对不上（实测曾出现登记 568 / 实测 566、
 * 而 0 越界 0 可收紧的矛盾——总数只是汇总行，没人看得懂它偏在哪）。
 * 由 files 求和之后这个字段就没有独立取值，也就没有独立漂移的可能。
 */
function allow(rule, entries) {
  const files = new Map(Object.entries(entries))
  let total = 0
  for (const count of files.values()) total += count
  BASELINE.set(rule, { total, files })
}

// 存量最大的那条：非空断言在测试里几乎全是「刚断言过长度/存在」的写法（`foo[0]!.bar`），
// 在生产代码里则集中在少数窄化边界上。500 处上下跨 60 个文件，逐个改写等于重写全部用例，
// 超出本轮范围；登记后只拦新增。
// persona-ui.test.tsx 是本轮交付里新加的用例文件，随同一批改动入库：不登记它，
// 第一个跑门禁的 PR 就会因为「未登记：新增文件」而红。登记数取实测值，与其他条目同性质。
allow('lint/style/noNonNullAssertion', {
  'apps/desktop/tests/provider-settings.test.tsx': 79,
  'packages/evolve/tests/evolve.test.ts': 46,
  'apps/desktop/tests/conversation-list.test.tsx': 23,
  'packages/evolve/tests/provenance.test.ts': 21,
  'packages/memory/tests/service.test.ts': 21,
  'packages/memory/tests/store.test.ts': 21,
  'apps/desktop/tests/memory-health-usage.test.tsx': 18,
  'packages/evolve/tests/pipeline.test.ts': 17,
  'apps/desktop/tests/group-settings.test.tsx': 13,
  'apps/desktop/tests/persona-ui.test.tsx': 13,
  'packages/session/tests/coordinator.test.ts': 13,
  'apps/desktop/tests/memory-panel.test.tsx': 12,
  'apps/desktop/tests/agent-binding.test.tsx': 11,
  'apps/desktop/tests/api-ws.test.ts': 11,
  'apps/desktop/tests/interaction-p0.test.tsx': 11,
  'apps/desktop/tests/use-leaving.test.tsx': 11,
  'packages/session/tests/store.test.ts': 11,
  'apps/desktop/tests/product-closure.test.tsx': 9,
  'packages/session/tests/coordinator-wiring.test.ts': 9,
  'apps/desktop/tests/app-list-wiring.test.tsx': 8,
  'apps/desktop/tests/chatview-closure.test.tsx': 8,
  'apps/desktop/tests/toast-host.test.tsx': 8,
  'apps/desktop/tests/chatinput.test.tsx': 7,
  'apps/desktop/tests/content-channel.test.tsx': 7,
  'apps/server/tests/messages-around.test.ts': 7,
  'apps/desktop/tests/failure-a11y.test.tsx': 6,
  'apps/desktop/tests/welcome-landing.test.tsx': 6,
  'packages/tools/tests/tools.test.ts': 6,
  'scripts/demo-agent.ts': 6,
  'packages/agent/tests/loop-cancel-usage.test.ts': 5,
  'packages/memory/tests/llm.test.ts': 5,
  'packages/session/tests/store-prepared.test.ts': 5,
  'apps/desktop/tests/store.test.tsx': 4,
  'packages/session/tests/artifacts.test.ts': 4,
  'packages/session/tests/store-transaction.test.ts': 4,
  'scripts/bench.ts': 4,
  'apps/desktop/tests/modal.test.tsx': 3,
  'apps/desktop/tests/motion-wiring.test.tsx': 3,
  'packages/session/src/persona.ts': 3,
  'scripts/demo-group.ts': 3,
  'apps/desktop/renderer/src/components/Modal.tsx': 2,
  'apps/desktop/renderer/src/store.ts': 2,
  'apps/desktop/tests/avatars.test.tsx': 2,
  'apps/desktop/tests/boot-trace.test.ts': 2,
  'apps/desktop/tests/chatview-history.test.tsx': 2,
  'packages/agent/tests/evolution-hooks.test.ts': 2,
  'packages/evolve/src/store.ts': 2,
  'apps/desktop/renderer/src/App.tsx': 1,
  'apps/desktop/renderer/src/components/avatars/avatars.tsx': 1,
  'apps/desktop/renderer/src/components/ChatInput.tsx': 1,
  'apps/desktop/renderer/src/components/ChatView.tsx': 1,
  'apps/desktop/renderer/src/components/ContactsPage.tsx': 1,
  'apps/desktop/tests/chatview-motion.test.tsx': 1,
  'apps/desktop/tests/renderer-wiring.test.tsx': 1,
  'apps/desktop/tests/tool-history.test.tsx': 1,
  'apps/desktop/tests/welcome.test.tsx': 1,
  'apps/server/src/seed.ts': 1,
  'apps/server/tests/server.test.ts': 1,
  'packages/evolve/src/service.ts': 1,
  'packages/evolve/tests/consolidation.test.ts': 1,
  'packages/session/src/coordinator.ts': 1,
  'packages/session/tests/message-search.test.ts': 1,
  'scripts/check-embedding.ts': 1,
})
// 依赖数组漏项：ChatView 的流式渲染 effect 一处就 16 条。重构这类 effect 时连带修。
allow('lint/correctness/useExhaustiveDependencies', {
  'apps/desktop/renderer/src/components/ChatView.tsx': 16,
  'apps/desktop/renderer/src/components/RightPanel.tsx': 1,
})
// 未使用的 import：多为测试替身里换实现留下的残骸，以及条件编译的备用 import。
allow('lint/correctness/noUnusedImports', {
  'apps/desktop/tests/avatars.test.tsx': 1,
  'apps/desktop/tests/proactive-message.test.tsx': 1,
  'apps/server/tests/proactive.test.ts': 1,
  'apps/server/tests/server.test.ts': 1,
  'packages/agent/src/loop.ts': 1,
  'packages/session/tests/coordinator-wiring.test.ts': 1,
  'scripts/check-embedding.ts': 1,
  'scripts/smoke-siliconflow.ts': 1,
})
// 未使用的局部变量。
allow('lint/correctness/noUnusedVariables', {
  'apps/desktop/tests/conversation-list.test.tsx': 1,
  'apps/desktop/tests/memory-health-usage.test.tsx': 1,
  'packages/agent/tests/memory-hooks.test.ts': 1,
  'packages/group/tests/fanout.test.ts': 1,
  'packages/session/tests/store-prepared.test.ts': 1,
})
allow('lint/style/useTemplate', { 'apps/desktop/tests/perf/streaming.perf.ts': 1 })

function normalize(file) {
  return String(file)
    .split(/[\\/]/u)
    .join('/')
    .replace(/^.*RyHarness\//u, '')
}

const report = runBiome()
// assist/* 是 biome 的 organizeImports 等编辑建议（info 级），不是 lint 违规，不进基线。
const diagnostics = (report.diagnostics ?? []).filter(
  (item) => typeof item.category === 'string' && !item.category.startsWith('assist/'),
)

const actual = new Map()
for (const rule of BASELINE.keys()) actual.set(rule, new Map())
/** 命中五条规则但被判定为瞬时文件的诊断：跳过，但留痕。 */
const skipped = new Map()
for (const item of diagnostics) {
  const rule = item.category
  const files = actual.get(rule)
  const file = normalize(item.location?.path)
  if (isEphemeral(file)) {
    if (files !== undefined) skipped.set(`${rule} ${file}`, (skipped.get(`${rule} ${file}`) ?? 0) + 1)
    continue
  }
  if (files === undefined) continue
  files.set(file, (files.get(file) ?? 0) + 1)
}

const violations = []
const slack = []
let actualTotal = 0
let baselineTotal = 0

for (const [rule, entry] of BASELINE) {
  const files = actual.get(rule)
  const counted = [...files.values()].reduce((sum, count) => sum + count, 0)
  actualTotal += counted
  baselineTotal += entry.total
  const names = new Set([...files.keys(), ...entry.files.keys()])
  for (const file of [...names].sort()) {
    const count = files.get(file) ?? 0
    const allowed = entry.files.get(file) ?? 0
    const record = { rule, file, count, allowed }
    if (count > allowed)
      violations.push({ ...record, reason: allowed === 0 ? '未登记：新增文件' : '超出冻结基线：条数增长' })
    else if (count < allowed) slack.push(record)
  }
}

/**
 * 重新冻结：把实测值写回本文件的基线块（只换数字，块上方的理由注释原样保留）。
 * 存在的理由是清债之后数字会低于登记值——不重冻，额度就在一次次「先修后加」里松回去了。
 * 数字变更会随提交出现在 diff 里，所以它仍然是要人看的一处改动，不是静默自愈。
 */
if (FREEZE) {
  const self = fileURLToPath(import.meta.url)
  let source = readFileSync(self, 'utf8')
  for (const [rule, files] of actual) {
    const rows = [...files.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const body = rows.map(([file, count]) => `  '${file}': ${count},\n`).join('')
    const pattern = new RegExp(`(allow\\('${rule}', \\{)[\\s\\S]*?(\\n\\})\\)`)
    if (!pattern.test(source)) {
      console.error(`基线块没找到，跳过：${rule}`)
      continue
    }
    source = source.replace(pattern, (_match, head, tail) => `${head}${body}${tail})`)
  }
  writeFileSync(self, source)
  console.log(`已把 ${actual.size} 条规则的实测值写回 ${path.relative(ROOT, self)}，请连同本次改动一起提交。`)
  process.exit(0)
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      { actualTotal, baselineTotal, violations, slack, skipped: [...skipped].map(([at, count]) => ({ at, count })) },
      null,
      2,
    ),
  )
} else {
  console.log(
    `biome 告警基线：登记 ${baselineTotal} 条 / 实测 ${actualTotal} 条（${violations.length} 处越界，${slack.length} 处可收紧）。`,
  )
  if (LIST) {
    for (const [rule, files] of actual) {
      const rows = [...files.entries()].sort((a, b) => b[1] - a[1])
      console.log(`  ${rule}：${rows.reduce((sum, row) => sum + row[1], 0)} 条 / ${rows.length} 个文件`)
    }
  }
  // 跳过的瞬时文件必须显式说出来：静默跳过等于「门禁没看见它」，
  // 于是有人不小心把探针提交进仓时，门禁既不红也不提醒。
  if (skipped.size > 0) {
    const rows = [...skipped].sort((a, b) => b[1] - a[1])
    console.log(
      `  已跳过 ${skipped.size} 处瞬时文件的诊断（并行 agent / 测试探针的临时产物，不计入基线）：${rows
        .slice(0, 5)
        .map(([at, count]) => `${at}×${count}`)
        .join('、')}${rows.length > 5 ? '…' : ''}`,
    )
    console.log('    如果上面某个文件其实是要提交的源码，请改掉文件名——门禁放过它是因为它自称临时。')
  }
  for (const item of violations) {
    console.log(`\n  越界 ${item.rule} ${item.file}：实测 ${item.count} 条（基线允许 ${item.allowed}）— ${item.reason}`)
  }
  for (const item of slack) {
    console.log(
      `  可收紧 ${item.rule} ${item.file}：实测 ${item.count} 条，基线写的是 ${item.allowed}，请把基线改成 ${item.count}`,
    )
  }
  if (violations.length === 0) console.log('  通过：五条规则都没有新增命中。')
}

process.exit(violations.length === 0 ? 0 : 1)
