/**
 * lint 覆盖面门禁：`apps/desktop/renderer/src/lib/` 必须在 biome 的检查范围内。
 *
 * 这里的 `lib` 不是构建产物目录，而是本仓渲染层的源码目录命名之一（同级还有
 * `renderer/src/components/`）。历史上 biome.json 的 files.includes 里有一条
 * 「任意层级下名为 lib 的目录一律排除」的通配规则（本文件刻意不写出它的字面量：
 * 那串星号紧跟斜杠会当场结束这段块注释），本意是排除 tsdown 生成的声明目录
 * （`packages/…/lib`、`apps/server/lib`，与 .gitignore 同一条约定），但它同样命中
 * `renderer/src/lib/`——`humanize.ts`、`persona.ts`、`model-catalog.ts`、
 * `windowed.ts`、`format.ts` 等 18 个模块整片**不受任何 lint 约束**：在那里写未用导入、
 * 脏格式化、非空断言，门禁一声不吭。这类排除漏洞不会自己暴露，它只表现为「某片代码
 * 质量莫名比别处差」，所以必须由测试钉住，而不是靠 review 记忆。
 *
 * 钉的是**行为**而不是配置文本：临时在目标目录里丢一个探针文件，看 biome 报不报它。
 * 这样不管后来人怎么改 glob 写法（加一条新的排除、把目录改名、把路径写得更宽），
 * 只要那片源码真的被踢出范围，用例就变红——不依赖对 biome glob 语义的复刻。
 *
 * 另一半同样要钉：`packages/…/lib` 这类构建产物必须**继续**被排除。否则「修复」
 * 会退化成删掉全部排除规则，CI 转而去 lint 每次构建都变的 `.d.ts`，很快被 ignore 回来，
 * 漏洞原样复发。
 *
 * 第三部分（`门禁自身的健壮性`）钉的是另一件事：并行 agent 写探针/临时文件时，
 * 门禁不该乱红，而真实的回归必须照样被拦住。两个方向都要钉——只钉「临时文件不误报」的话，
 * 一条宽到能吞掉任何真实回归的口径同样能让这批用例全绿，那它比没有门禁更糟。
 * 同样钉住的还有覆盖率棘轮：一次没跑完的运行不能给出覆盖率结论（`diagnoseRun`）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { diagnoseRun } from '../../../scripts/run-integrity.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(DESKTOP, '..', '..')
const BIOME = join(REPO, 'node_modules', '@biomejs', 'biome', 'bin', 'biome')

const RENDERER_LIB = 'apps/desktop/renderer/src/lib'
const BUILD_OUTPUT_LIB = 'packages/agent/lib'
const PROBE_NAME = '__biome_scope_probe.ts'
// 探针只触发一条 error 级规则（noUnusedImports），格式本身对齐 biome 风格，
// 于是「报不报」完全取决于文件在不在范围内，不掺格式噪声。
const PROBE = "import { join } from 'node:path'\n\nexport const probe = 1\n"

const createdDirs: string[] = []

/** biome 退出码非 0 时 execFileSync 抛错，stdout 仍要捞出来读。 */
function runBiome(target: string): string {
  const args = [BIOME, 'check', relative(REPO, target).split('\\').join('/')]
  try {
    return execFileSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '')
  }
}

function checkedCount(output: string): number {
  return Number(/Checked (\d+) files?\b/.exec(output)?.[1] ?? -1)
}

/** 在目标目录丢探针 → 跑 biome → 收走探针，返回本次实际被检查的文件数。 */
function probeScope(dir: string): number {
  const abs = resolve(REPO, dir)
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true })
    createdDirs.push(abs)
  }
  const file = join(abs, PROBE_NAME)
  writeFileSync(file, PROBE, 'utf8')
  try {
    return checkedCount(runBiome(file))
  } finally {
    rmSync(file, { force: true })
  }
}

afterEach(() => {
  while (createdDirs.length > 0) {
    // 只删本次 mkdir 出来的：像 packages/agent/lib 这种构建目录本就在仓里存在，
    // 跑完测试把它连同产物一起抹掉等于替人清了构建缓存。
    rmSync(createdDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('biome 覆盖面', () => {
  it('renderer/src/lib 下的模块进入 lint 范围（探针被报到）', () => {
    expect(probeScope(RENDERER_LIB)).toBe(1)
  })

  it('renderer/src/lib 整片都在范围内，没有只放行一半', () => {
    const sources = readdirSync(resolve(REPO, RENDERER_LIB)).filter((name) => /\.[cm]?tsx?$/.test(name))
    expect(sources.length).toBeGreaterThan(10)
    // 目录本身可能正带着别处的既存诊断而退出码非 0，所以只看 biome 数了几个文件，
    // 不要求这次检查是干净的。
    expect(checkedCount(runBiome(resolve(REPO, RENDERER_LIB)))).toBe(sources.length)
  })

  it('tsdown 构建产物目录仍然被排除，别把「修复」退化成删光排除规则', () => {
    expect(probeScope(BUILD_OUTPUT_LIB)).toBe(0)
  })
})

/**
 * 第三部分：门禁自身的健壮性。两条门禁（verify-biome-budget.mjs /
 * verify-no-unknown-casts.mjs）都承诺「瞬时文件（并行 agent 的临时产物、测试探针、
 * 编辑器残留）不计入基线」，且跳过会打印出来而不是静默放过。这里钉的是行为：
 * 注入一份现成的 biome JSON 报告（RYHARNESS_BIOME_REPORT，存在的理由就是让门禁可测），
 * 分别断言「瞬时诊断不红」「真实回归照样红」「基线内的命中不红」。
 * 两个方向都要钉——只钉「临时文件不误报」的话，一条宽到能吞掉任何真实回归的口径
 * 同样能让这批用例全绿，那比没有门禁更糟。
 */
const BUDGET_SCRIPT = join(REPO, 'scripts', 'verify-biome-budget.mjs')

/** 造一条最小可用的 biome 诊断：category + location.path 是门禁唯一读的两个字段。 */
function diagnostic(category: string, at: string) {
  return { category, location: { path: at } }
}

/** 注入报告 → 跑门禁 → 返回退出码与 stdout；临时报告文件放系统临时目录，用完即删。 */
let reportCounter = 0
function runBudgetGate(diagnostics: unknown[]): { status: number | null; stdout: string } {
  const reportFile = join(tmpdir(), `ryharness-biome-report-${process.pid}-${++reportCounter}.json`)
  writeFileSync(reportFile, JSON.stringify({ diagnostics }), 'utf8')
  try {
    try {
      const stdout = execFileSync(process.execPath, [BUDGET_SCRIPT], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, RYHARNESS_BIOME_REPORT: reportFile },
      })
      return { status: 0, stdout }
    } catch (err) {
      // 非 0 退出会抛：退出码与 stdout 都在错误对象上。
      const failure = err as { status?: number; stdout?: string }
      return { status: failure.status ?? null, stdout: String(failure.stdout ?? '') }
    }
  } finally {
    rmSync(reportFile, { force: true })
  }
}

describe('biome 告警棘轮（verify-biome-budget.mjs）', () => {
  it('瞬时文件上的诊断被跳过，不让门禁乱红，且跳过会被打印出来', () => {
    // 四条各自踩中 isEphemeral 的一条腿：临时目录、.probe. 中缀、__*probe* 探针名、编辑器残留 ~$。
    const result = runBudgetGate([
      diagnostic('lint/style/noNonNullAssertion', 'tmp/agent/probe.ts'),
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/scratch/foo.probe.ts'),
      diagnostic('lint/correctness/noUnusedImports', 'packages/agent/tests/__llm_probe__.ts'),
      diagnostic('lint/correctness/noUnusedVariables', 'draft/~$scratchpad.ts'),
    ])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('已跳过')
    expect(result.stdout).toContain('tmp/agent/probe.ts')
  })

  it('真实源码上的新增命中照样拦：未登记文件出现即非 0 退出', () => {
    const result = runBudgetGate([
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/renderer/src/components/NewWidget.tsx'),
    ])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('NewWidget.tsx')
    expect(result.stdout).toContain('未登记')
  })

  it('基线内的命中不红：已登记文件的条数没涨就通过', () => {
    // Modal.tsx 基线允许 2 条，这里只命中 1 条——不比基线多就放行。
    const result = runBudgetGate([
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/renderer/src/components/Modal.tsx'),
    ])
    expect(result.status).toBe(0)
  })

  it('已登记文件超量照样拦：条数增长与新增文件同样算越界', () => {
    const result = runBudgetGate([
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/renderer/src/components/Modal.tsx'),
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/renderer/src/components/Modal.tsx'),
      diagnostic('lint/style/noNonNullAssertion', 'apps/desktop/renderer/src/components/Modal.tsx'),
    ])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('超出冻结基线')
  })
})

/** 覆盖率棘轮的另一半：一次没跑完的运行必须被判定为「没有覆盖率结论」（见 vitest.config.ts 的 guard）。 */
describe('运行完整性判定（diagnoseRun）', () => {
  const passedFile = (id: string) => ({ state: () => 'passed' as const, relativeModuleId: id })

  it('全部跑到终态、无未捕获错误 → 完整', () => {
    expect(
      diagnoseRun({
        expectedFiles: 2,
        modules: [passedFile('a.test.ts'), passedFile('b.test.ts')],
        unhandledErrors: [],
        reason: 'passed',
        rerun: false,
        watch: false,
      }).incomplete,
    ).toBe(false)
  })

  it('模块停在 pending/queued → 不完整，且报出文件名', () => {
    const diagnosis = diagnoseRun({
      expectedFiles: 2,
      modules: [passedFile('a.test.ts'), { state: () => 'pending' as const, relativeModuleId: 'stuck.test.ts' }],
      unhandledErrors: [],
      reason: 'passed',
      rerun: false,
      watch: false,
    })
    expect(diagnosis.incomplete).toBe(true)
    expect(diagnosis.reasons.join()).toContain('stuck.test.ts')
  })

  it('未捕获错误与被中断（非 watch）各自构成不完整', () => {
    const base = {
      expectedFiles: 1,
      modules: [passedFile('a.test.ts')],
      rerun: false,
      watch: false,
    }
    expect(diagnoseRun({ ...base, unhandledErrors: [new Error('boom')], reason: 'passed' }).incomplete).toBe(true)
    expect(diagnoseRun({ ...base, unhandledErrors: [], reason: 'interrupted' }).incomplete).toBe(true)
    // watch 模式下的 interrupted 是「改文件重跑」，不算崩溃。
    expect(diagnoseRun({ ...base, unhandledErrors: [], reason: 'interrupted', watch: true }).incomplete).toBe(false)
  })

  it('watcher 触发的重跑（非 watch 交互模式）没有覆盖率结论', () => {
    expect(
      diagnoseRun({
        expectedFiles: 1,
        modules: [passedFile('a.test.ts')],
        unhandledErrors: [],
        reason: 'passed',
        rerun: true,
        watch: false,
      }).incomplete,
    ).toBe(true)
  })

  it('整体被 skip 的文件不算不完整，但要能被点出来', () => {
    const diagnosis = diagnoseRun({
      expectedFiles: 1,
      modules: [{ state: () => 'skipped' as const, relativeModuleId: 'skipped.test.ts' }],
      unhandledErrors: [],
      reason: 'passed',
      rerun: false,
      watch: false,
    })
    expect(diagnosis.incomplete).toBe(false)
    expect(diagnosis.skippedFiles).toEqual(['skipped.test.ts'])
  })
})
