// @vitest-environment node

/**
 * 桌面外壳的三条安全钉子：依赖分类、CSP 收紧、防嵌套响应头。
 *
 * 三条都来自同一次评审（项目外专家只读评审），每一条都有一个「看起来是配置、
 * 实际是漏洞」的性质，所以必须写成会红的断言，而不是写进文档靠人记得：
 *
 *   1. 依赖分类 —— react / react-dom / marked / @dicebear 声明在 dependencies 里，
 *      但渲染层是 vite 打的包（vite.config.ts 的 manualChunks 明确把它们打进
 *      renderer/dist/assets/），运行时只存在于渲染层产物里，主进程压根不 import
 *      它们（main/main.mjs 的外部 import 只有 node:* | electron | @ryharness/server）。
 *      于是 electron-builder 把这四个包连同它们的传递依赖整份拷进 asar：
 *      实测 react-dom 7.69MB、@dicebear 2.39MB，而打包后的 renderer/dist/assets
 *      才 0.80MB——69% 的安装包是同一批库的第二份副本。
 *
 *   2. CSP —— index.html 的 script-src 带着 'unsafe-inline'，理由写的是
 *      「scripts/inline-dist.mjs 把产物内联进单个 index.html」。那个脚本早就不存在了，
 *      现在的产物是回环 HTTP 伺服 + 保留分片，外链完全可用，'unsafe-inline' 只是
 *      一个没人再需要的借口。去掉它之前先把主题引导脚本挪成外部文件，否则第一帧
 *      会闪一次浅色。
 *
 *   3. 防嵌套 —— 资源服务跑在固定回环端口（32101）上，地址是猜得到的：任意网页都能
 *      用 iframe 把它套进自己的页面，假页面里的 RyHarness 输入框是真的，敲进去的
 *      提示词会真的发给本地 agent。X-Frame-Options: DENY 与 CSP 的
 *      frame-ancestors 'none' 必须**每条响应**都带（404 页面同样能被套）。
 *
 * 顺带钉住「workspace 包的 TypeScript 源码不进 asar」这件事的机制：
 * node_modules/@ryharness/* 是指向 packages/* 与 apps/server 的软链，electron-builder
 * 整目录复制，于是 src/**、tsconfig.json、tsdown.config.mjs 全被带进产物（实测
 * 1.23MB）。挡它的是 build.files 里针对 @ryharness 源码目录的排除项（字面量见下面
 * 那条断言）：实测 electron-builder 26.17 的 files 排除项**对 node_modules 生效**——
 * app-builder-lib 的 getNodeModuleFileMatcher 会把 config.files 里所有 `!` 开头的
 * 模式收进 node_modules 的 matcher（且只在 node_modules 目录树里生效，app 目录树
 * 那一层另有单独一条「排除整个 node_modules」的兜底）。所以不需要 beforePack 钩子，
 * 也不需要改 workspace 包自己的 files 字段。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDERER_MOUNT, RendererAssets, securityHeaders } from '../electron/renderer-assets.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(DESKTOP, 'renderer/index.html'), 'utf8')
/**
 * 去掉 HTML 注释再断言。
 *
 * 这几段注释里会提到 `<script src>`、`<style>`、frame-ancestors 这些字面
 * （解释「为什么没有它们」），直接扫原文会扫到注释里去。
 */
const markup = html.replace(/<!--[\s\S]*?-->/g, '')

interface DesktopManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
    files?: string[]
  }
}

const manifest = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as DesktopManifest
const dependencies = manifest.dependencies ?? {}
const devDependencies = manifest.devDependencies ?? {}

/** 解析 index.html 里那条 meta CSP：指令名 → 源表达式列表。 */
function cspDirectives(): Map<string, string[]> {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
  expect(match, 'index.html 里找不到 Content-Security-Policy').not.toBeNull()
  const map = new Map<string, string[]>()
  for (const part of (match?.[1] ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const [name, ...sources] = trimmed.split(/\s+/)
    if (name === undefined) continue
    map.set(name, sources)
  }
  return map
}

/** index.html 里所有 <script> 标签的属性串。 */
function scriptTags(): string[] {
  return [...markup.matchAll(/<script\b([^>]*)>/g)].map((match) => {
    return match[1] ?? ''
  })
}

describe('依赖分类：渲染层的构建期依赖不该进运行时 dependencies', () => {
  // 这五个包是 vite 打进 renderer/dist/assets/ 的（vite.config.ts 的 manualChunks
  // 明确分了 vendor-react / vendor-marked / vendor-avatar 三个分片）。主进程不 import
  // 它们——main/main.mjs 的外部 import 只有 node:* | electron | @ryharness/server。
  const rendererOnly = ['react', 'react-dom', 'marked', '@dicebear/core', '@dicebear/collection']

  it('渲染层库不在 dependencies 里', () => {
    for (const name of rendererOnly) {
      expect(Object.keys(dependencies), `${name} 不该是运行时依赖`).not.toContain(name)
    }
  })

  it('渲染层库在 devDependencies 里（构建要得到，打包不该带上）', () => {
    for (const name of rendererOnly) {
      expect(Object.keys(devDependencies), `${name} 应该是构建期依赖`).toContain(name)
    }
  })

  it('@ryharness/server 留在 dependencies：主进程真的 import 它', () => {
    expect(Object.keys(dependencies)).toContain('@ryharness/server')
    expect(Object.keys(devDependencies)).not.toContain('@ryharness/server')
  })

  it('挡住 workspace 包源码的排除项写在 build.files 里', () => {
    const files = manifest.build?.files ?? []
    // 实测有效（见文件头）：files 的 `!` 排除项对 node_modules 生效。
    expect(files).toContain('!node_modules/@ryharness/**/src{,/**/*}')
  })
})

describe('CSP：script-src 收回 unsafe-inline', () => {
  it('script-src 只放行 self', () => {
    const sources = cspDirectives().get('script-src') ?? []
    expect(sources).toContain("'self'")
    expect(sources, "script-src 不该再有 'unsafe-inline'").not.toContain("'unsafe-inline'")
    expect(sources).not.toContain("'unsafe-eval'")
  })

  it('style-src 保留 unsafe-inline（React 全程用内联 style 属性，收掉就是把界面打死）', () => {
    const sources = cspDirectives().get('style-src') ?? []
    expect(sources).toContain("'self'")
    expect(sources).toContain("'unsafe-inline'")
  })

  it('页面里没有内联脚本：每个 <script> 都带 src', () => {
    const tags = scriptTags()
    expect(tags.length).toBeGreaterThan(0)
    for (const attrs of tags) {
      expect(attrs, `<script${attrs}> 没有 src`).toMatch(/\bsrc\s*=/)
    }
  })

  it('主题引导脚本是经典脚本且不带 defer/async（必须赶在第一帧之前同步执行）', () => {
    const tags = scriptTags()
    const theme = tags.find((attrs) => {
      return attrs.includes('theme-boot.js')
    })
    expect(theme, 'index.html 里没有引用 theme-boot.js').toBeDefined()
    expect(theme ?? '').not.toMatch(/\btype\s*=\s*["']module["']/)
    expect(theme ?? '').not.toMatch(/\bdefer\b/)
    expect(theme ?? '').not.toMatch(/\basync\b/)
  })

  it('主题脚本走 /app 前缀（与 favicon 同一条契约）', () => {
    expect(markup).toContain(`src="${RENDERER_MOUNT}/theme-boot.js"`)
  })

  it('主题引导脚本存在，且真的在定 data-theme', () => {
    const file = join(DESKTOP, 'renderer/public/theme-boot.js')
    expect(existsSync(file), 'theme-boot.js 不存在').toBe(true)
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('data-theme')
    // 存储键必须与 renderer/src/App.tsx 的 loadTheme 一致，否则读不到用户选的主题。
    expect(source).toContain('ryharness-theme')
  })
})

describe('防嵌套：所有响应都带 X-Frame-Options 与 frame-ancestors', () => {
  const tmpDirs: string[] = []
  const started: RendererAssets[] = []

  async function startAssets(): Promise<RendererAssets> {
    const root = mkdtempSync(join(tmpdir(), 'ryharness-shell-'))
    tmpDirs.push(root)
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf8')
    writeFileSync(join(root, 'assets', 'index-B6_i5xWc.js'), 'export const a = 1\n', 'utf8')
    const assets = await RendererAssets.start(root, { port: 0 })
    started.push(assets)
    return assets
  }

  afterEach(async () => {
    while (started.length > 0) await started.pop()?.close()
    while (tmpDirs.length > 0) {
      try {
        rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
      } catch {
        // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
      }
    }
  })

  it('头本身是对的', () => {
    const headers = securityHeaders()
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  })

  it('200 / 304 / 404 / 405 都带这两条头（漏一条就等于给猜路径开了口子）', async () => {
    const assets = await startAssets()

    const ok = await fetch(`${assets.url}${RENDERER_MOUNT}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-frame-options')).toBe('DENY')
    expect(ok.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const missing = await fetch(`${assets.url}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('x-frame-options')).toBe('DENY')
    expect(missing.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const wrongMethod = await fetch(`${assets.url}${RENDERER_MOUNT}`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('x-frame-options')).toBe('DENY')
    expect(wrongMethod.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    // 304 走的是另一条分支（条件请求命中），也要带。
    const first = await fetch(`${assets.url}/assets/index-B6_i5xWc.js`)
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()
    const notModified = await fetch(`${assets.url}/assets/index-B6_i5xWc.js`, {
      headers: { 'if-none-match': etag ?? '' },
    })
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('x-frame-options')).toBe('DENY')
    expect(notModified.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('frame-ancestors 不靠 meta CSP：浏览器会忽略 meta 里的这条 directive', () => {
    // meta 形式只认一部分 directive，frame-ancestors 不在其中——写了等于没写。
    // 防嵌套只能靠响应头，所以这条 directive 不该出现在 meta CSP 里。
    expect(cspDirectives().has('frame-ancestors')).toBe(false)
  })
})
