/**
 * 死代码门禁的自测：门禁**自己**得管用。
 *
 * 这一族用例拿一个临时仓库当靶子，故意制造四种退化（不可达的包、不可达的
 * 文件、没被引用的导出、声明了却没用的依赖），逐条确认门禁报出来；再确认干
 * 净的仓库是绿的。
 *
 * **不在真仓库上做**：门禁的入口与豁免是按仓库布局定的，改真仓库的源码来
 * 测会污染工作区。临时仓库是它该被测的方式。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** 门禁脚本的位置。 */
const SCRIPT = resolve(process.cwd(), 'scripts/verify-no-dead-code.mjs')

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/**
 * 造一个靶子仓库。
 *
 * @param files - 相对路径 → 内容。
 * @returns 仓库目录。
 */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-deadcode-'))
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

/**
 * 在一个仓库上跑门禁。
 *
 * **用 `RYHARNESS_SCAN_ROOT` 指过去**：门禁按自己所在位置算仓库根，从别处跑
 * 时它扫的还是真仓库——靶子目录就白造了。
 * @param root - 仓库目录。
 * @returns 退出码与输出。
 */
function runGate(root: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RYHARNESS_SCAN_ROOT: root },
    })
    return { code: 0, output }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/** 一个最小的、干净的仓库：入口可达，没有死代码。 */
function cleanRepo(): Record<string, string> {
  return {
    'apps/server/src/index.ts': "import { thing } from '@acme/thing'\nexport const server = thing\n",
    'packages/thing/package.json': JSON.stringify({ name: '@acme/thing', version: '1.0.0' }),
    'packages/thing/src/index.ts': 'export const thing = 1\n',
  }
}

describe('死代码门禁', () => {
  it('干净的仓库是绿的', () => {
    const result = runGate(makeRepo(cleanRepo()))
    expect(result.code).toBe(0)
    expect(result.output).toContain('通过')
  })

  it('规则 A：不可达的包会被报出来', () => {
    const files = cleanRepo()
    files['packages/orphan/package.json'] = JSON.stringify({ name: '@acme/orphan', version: '1.0.0' })
    files['packages/orphan/src/index.ts'] = 'export const orphan = 1\n'
    const result = runGate(makeRepo(files))
    expect(result.code).toBe(1)
    expect(result.output).toContain('@acme/orphan')
    expect(result.output).toContain('[A]')
  })

  it('规则 B：不可达的源文件会被报出来', () => {
    const files = cleanRepo()
    files['packages/thing/src/never-used.ts'] = 'export const lonely = 1\n'
    const result = runGate(makeRepo(files))
    expect(result.code).toBe(1)
    expect(result.output).toContain('never-used.ts')
    expect(result.output).toContain('[B]')
  })

  it('规则 C：没被引用的值导出只是警告，不拦', () => {
    const files = cleanRepo()
    files['packages/thing/src/index.ts'] = 'export const thing = 1\nexport const nobodyUses = 2\n'
    const result = runGate(makeRepo(files))
    // 警告不该让门禁变红——动态引用静态证明不了。
    expect(result.code).toBe(0)
    expect(result.output).toContain('nobodyUses')
    expect(result.output).toContain('[C]')
  })

  it('规则 D：声明了却没 import 的依赖会被报出来', () => {
    const files = cleanRepo()
    files['packages/thing/package.json'] = JSON.stringify({
      name: '@acme/thing',
      version: '1.0.0',
      dependencies: { '@acme/never-imported': 'workspace:*' },
    })
    const result = runGate(makeRepo(files))
    expect(result.code).toBe(1)
    expect(result.output).toContain('@acme/never-imported')
    expect(result.output).toContain('[D]')
  })

  it('豁免清单能放过指定的包', () => {
    const files = cleanRepo()
    files['packages/orphan/package.json'] = JSON.stringify({ name: '@acme/orphan', version: '1.0.0' })
    files['packages/orphan/src/index.ts'] = 'export const orphan = 1\n'
    files['docs/dead-code-exemptions.json'] = JSON.stringify({
      packages: ['@acme/orphan'],
      paths: [],
      reasons: { '@acme/orphan': '纯库：只被编译期引用。' },
    })
    const result = runGate(makeRepo(files))
    expect(result.code).toBe(0)
  })

  it('豁免文件坏了不等于全豁免：门禁照样报', () => {
    const files = cleanRepo()
    files['packages/orphan/package.json'] = JSON.stringify({ name: '@acme/orphan', version: '1.0.0' })
    files['packages/orphan/src/index.ts'] = 'export const orphan = 1\n'
    files['docs/dead-code-exemptions.json'] = '{ 这不是 JSON'
    const result = runGate(makeRepo(files))
    // 读不出来就当没有豁免——豁免文件坏了应该让门禁更严。
    expect(result.code).toBe(1)
    // 包与它的文件都要被报出来。
    expect(result.output).toContain('@acme/orphan')
    expect(result.output).toContain('orphan/src/index.ts')
  })
})
