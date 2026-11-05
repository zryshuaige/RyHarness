/**
 * CDP 驱动的用例：找浏览器、开页面、点元素、读正文、截图。
 *
 * 这一族是**真机**：真的起一个 Edge / Chrome（走 CDP，不下载浏览器二进制），
 * 真的打开页面、真的点击。没有浏览器时整个文件跳过——那是环境问题，不是代码坏了。
 *
 * 另有一组**不碰浏览器**的用例：可执行文件的查找（哪些路径会被试、显式路径
 * 怎么对待），那部分纯逻辑，任何机器上都能跑。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCdpDriverFactory, findBrowserExecutable } from '../src/index.ts'

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

/** 本机有没有能用的浏览器。 */
const hasBrowser = findBrowserExecutable() !== undefined

/** 真机用例的时限：起浏览器 + 加载页面。 */
const REAL_TIMEOUT_MS = 90_000

describe('CDP 驱动：找浏览器（不碰浏览器）', () => {
  it('显式给的路径存在就用它', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-browser-'))
    tmpDirs.push(dir)
    const exe = join(dir, 'fake-browser.exe')
    writeFileSync(exe, '', 'utf8')
    expect(findBrowserExecutable({ executablePath: exe })).toBe(exe)
  })

  it('显式给的路径不存在：找不到就说找不到，不退回默认候选', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-browser-'))
    tmpDirs.push(dir)
    const missing = join(dir, 'not-there.exe')
    // 这一条不能退回平台默认候选——显式指定的东西不存在就该报不存在。
    expect(findBrowserExecutable({ executablePath: missing, platform: 'linux' })).toBeUndefined()
  })

  it('环境变量里的路径也认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-browser-'))
    tmpDirs.push(dir)
    const exe = join(dir, 'from-env.exe')
    writeFileSync(exe, '', 'utf8')
    expect(findBrowserExecutable({ env: { RYHARNESS_BROWSER_PATH: exe } })).toBe(exe)
  })

  it('找不到时给 undefined，不抛异常', () => {
    // linux 平台的候选路径在本机（Windows）上都不存在。
    expect(findBrowserExecutable({ platform: 'linux', env: {} })).toBeUndefined()
  })
})

describe.skipIf(!hasBrowser)('CDP 驱动（真机）', () => {
  it(
    '真的开一个浏览器：开页面、读正文、截图、点元素',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        expect(driver.name).toBe('cdp')

        await driver.open('data:text/html;charset=utf-8,' + encodeURIComponent(CLICKABLE_PAGE))
        const text = await driver.readText()
        expect(text).toContain('CDP 真机自测页')

        const shot = await driver.screenshot()
        expect(shot.mimeType).toBe('image/png')
        expect(shot.bytes.byteLength).toBeGreaterThan(500)

        await driver.click('#mark')
        expect(await driver.readText()).toContain('已点击')
      } finally {
        await factory.close()
      }
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '关掉之后驱动不能再用（连接真的断了）',
    async () => {
      const factory = createCdpDriverFactory()
      const driver = await factory.driverFactory()
      await driver.open('data:text/html;charset=utf-8,' + encodeURIComponent(CLICKABLE_PAGE))
      await factory.close()
      await expect(driver.readText()).rejects.toThrow()
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '点不存在的元素要报 DRIVER_FAILED，不是假装成功',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        await driver.open('data:text/html;charset=utf-8,' + encodeURIComponent(CLICKABLE_PAGE))
        await expect(driver.click('#definitely-not-there')).rejects.toThrow(/找不到元素/)
      } finally {
        await factory.close()
      }
    },
    REAL_TIMEOUT_MS,
  )
})

/** 自带的测试页：点一下按钮，文字会变。 */
const CLICKABLE_PAGE =
  '<html><body><h1>CDP 真机自测页</h1>' +
  '<button id="mark" onclick="this.textContent=\'已点击\'">标记</button>' +
  '</body></html>'
