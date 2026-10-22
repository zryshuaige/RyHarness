// @vitest-environment node

/**
 * preload 产物必须能被 sandbox 渲染进程装载。
 *
 * 这条约束是 Electron 的硬规则，不是风格问题：Electron 20 起渲染进程默认
 * `sandbox: true`，而 sandbox 下的 preload 只按 CommonJS 装载。喂一份 ESM 产物
 * （import/export 语句）过去后，Electron 抛的错只进 `preload-error` 事件——
 * 渲染层拿不到任何提示，`window.ryharnessDesktop` 直接不存在，「打开所在目录」
 * 永远退化成「路径已复制」，看起来像功能没做，而不是像坏了。
 *
 * 此前 tsdown 把 main 与 preload 合成一次 ESM 构建（preload.mjs），桥在真机上
 * 是完全不存在的。这里钉住三件事：preload 单独构建成 CJS、main.ts 指向这份
 * 产物、electron-builder 的 files 把它装进包。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DESKTOP = fileURLToPath(new URL('..', import.meta.url))
const MAIN_TS = join(DESKTOP, 'electron', 'main.ts')
const PACKAGE_JSON = join(DESKTOP, 'package.json')

/** tsdown.config.mjs 的结构化视图；只取断言要用的字段，其余一律忽略。 */
interface TsdownConfig {
  entry: string[]
  outDir: string
  format: string[]
  outExtensions?: (context: unknown) => Record<string, string>
}

const require_ = createRequire(import.meta.url)
// 单对象也算一份配置：日后有人把两个入口合回一个对象，断言要给出「preload 不是
// 单独构建的 CJS」而不是在模块加载时炸一个 TypeError。
const exported = (require_(join(DESKTOP, 'tsdown.config.mjs')) as { default: TsdownConfig | TsdownConfig[] }).default
const configs: TsdownConfig[] = Array.isArray(exported) ? exported : [exported]

const mainConfig = configs.find((config) => config.entry.includes('electron/main.ts'))
const preloadConfig = configs.find((config) => config.entry.includes('electron/preload.ts'))

/** 配置声明的产物文件名：`outExtensions` 决定后缀，入口 stem 决定前面那段。 */
function artifactName(config: TsdownConfig | undefined): string {
  const entry = config?.entry[0] ?? ''
  const stem =
    entry
      .split('/')
      .pop()
      ?.replace(/\.tsx?$/u, '') ?? ''
  const ext = config?.outExtensions?.({ format: config?.format[0], options: {} })?.js ?? '.js'
  return `${stem}${ext}`
}

/** electron-builder 的 files 是 gitignore 风格 glob；这里只实现断言需要的三个通配符。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    `^${escaped
      .replace(/\*\*\//gu, '(?:.*/)?')
      .replace(/\*\*/gu, '.*')
      .replace(/(?<!\.)\*/gu, '[^/]*')}$`,
  )
}

/** 产物是否会被 electron-builder 装进包：正模式命中且没有被 `!` 模式排除。 */
function packagedBy(patternList: string[], filePath: string): boolean {
  let packed = false
  for (const pattern of patternList) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(filePath)) packed = false
      continue
    }
    if (globToRegExp(pattern).test(filePath)) packed = true
  }
  return packed
}

/** 去掉注释再看模块语法：`import`/`export` 出现在注释里不算数。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1')
}

const PRELOAD_ARTIFACT = artifactName(preloadConfig)
const BUILT_IN = mkdtempSync(join(tmpdir(), 'ryharness-preload-artifact-'))
let builtPreload = ''

// 用真实的 tsdown 配置构建一次（输出到临时目录，不碰仓库里的 main/），
// 断言的是产物本身而不是配置意图——意图与产物脱节正是原来的故障形态。
beforeAll(async () => {
  const { build } = require_('tsdown') as typeof import('tsdown')
  await build({ cwd: DESKTOP, outDir: BUILT_IN, logLevel: 'silent' })
  builtPreload = readFileSync(join(BUILT_IN, PRELOAD_ARTIFACT), 'utf8')
}, 120_000)

afterAll(() => {
  rmSync(BUILT_IN, { recursive: true, force: true, maxRetries: 5 })
})

describe('preload 的模块格式', () => {
  it('preload 单独构建成 CommonJS（sandbox 只按 CJS 装载它）', () => {
    expect(preloadConfig).toBeDefined()
    expect(preloadConfig?.format).toContain('cjs')
    expect(preloadConfig?.format).not.toContain('esm')
    expect(PRELOAD_ARTIFACT).toBe('preload.cjs')
  })

  it('主进程仍是 ESM，入口名与 package.json 的 main 对得上', () => {
    expect(mainConfig).toBeDefined()
    expect(mainConfig?.format).toContain('esm')
    expect(artifactName(mainConfig)).toBe('main.mjs')
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { main: string }
    expect(manifest.main).toBe(`./main/${artifactName(mainConfig)}`)
  })

  it('产物里没有 import/export 语句，sandbox 才装得进去', () => {
    const code = stripComments(builtPreload)
    expect(code).not.toMatch(/(^|[\n;])\s*import[\s{*'"]/u)
    expect(code).not.toMatch(/(^|[\n;])\s*export[\s{*]/u)
    // 反过来也要成立：确实是 CJS（只有 require），不是「什么都没输出」。
    expect(code).toContain('require(')
    expect(code).toContain('exposeInMainWorld')
  })

  it('产物是 .cjs：应用 package.json 是 type: module，.js 会被当成 ESM', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { type: string }
    expect(manifest.type).toBe('module')
    expect(PRELOAD_ARTIFACT.endsWith('.cjs')).toBe(true)
  })

  it('Electron 20+ 默认开沙箱——这条一旦被关掉，CJS 约束就不再是硬要求', () => {
    const electronVersion = (
      JSON.parse(readFileSync(join(DESKTOP, 'node_modules', 'electron', 'package.json'), 'utf8')) as { version: string }
    ).version
    expect(Number(electronVersion.split('.')[0])).toBeGreaterThanOrEqual(20)
  })
})

describe('主进程指向这份 preload 产物', () => {
  const mainSource = readFileSync(MAIN_TS, 'utf8')
  const webPreferences = /webPreferences:\s*\{([\s\S]*?)\n {4}\}/u.exec(mainSource)?.[1] ?? ''

  it('路径是 preload.cjs，不是 ESM 的 preload.mjs', () => {
    expect(mainSource).toContain(`join(here, '${PRELOAD_ARTIFACT}')`)
    expect(mainSource).not.toContain("join(here, 'preload.mjs')")
  })

  it('webPreferences 显式写着 sandbox: true 与 contextIsolation: true', () => {
    expect(webPreferences).toMatch(/\bsandbox:\s*true\b/u)
    expect(webPreferences).toMatch(/\bcontextIsolation:\s*true\b/u)
    expect(webPreferences).toMatch(/\bnodeIntegration:\s*false\b/u)
    expect(mainSource).not.toMatch(/\bsandbox:\s*false\b/u)
  })

  it('打出来的 main.mjs 指向 preload.cjs，且显式开着沙箱', () => {
    // 源码断言挡不住「配置和代码各自说对、产物却拼错」这种情况，所以再验一次成品。
    const builtMain = readFileSync(join(BUILT_IN, 'main.mjs'), 'utf8')
    expect(builtMain).toContain('preload.cjs')
    expect(builtMain).not.toContain('preload.mjs')
    expect(builtMain).toMatch(/\bsandbox:\s*true\b/u)
  })
})

describe('打包清单', () => {
  it('files 会把 main/preload.cjs 装进安装包', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      build: { files: string[] }
    }
    expect(packagedBy(manifest.build.files, `main/${PRELOAD_ARTIFACT}`)).toBe(true)
  })

  it('files 也仍然装着主进程入口', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      build: { files: string[] }
    }
    expect(packagedBy(manifest.build.files, 'main/main.mjs')).toBe(true)
  })
})
