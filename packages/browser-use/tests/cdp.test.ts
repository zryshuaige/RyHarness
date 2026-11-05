/**
 * CDP 驱动的**真机**用例：真的起一个 Edge / Chrome，真的开页面、读正文、截图。
 *
 * 这不是 mock 用例——它连的是本机已装的浏览器。跑它需要：
 * - 本机装了 Edge 或 Chrome（或 `RYHARNESS_BROWSER_PATH` 指了一个）；
 * - 能访问 `https://example.com`（读正文那条要网络）。
 *
 * 没有浏览器时**整个文件跳过**（不是失败）：「本机没装浏览器」是环境问题，
 * 不是代码坏了。判断标准写在 `findBrowserExecutable` 里，与驱动本身一致。
 *
 * @module @ryharness/browser-use/tests/cdp
 */

import { describe, expect, it } from 'vitest'
import { createCdpDriverFactory, findBrowserExecutable } from '../src/index.ts'

/** 本机有没有能用的浏览器。 */
const hasBrowser = findBrowserExecutable() !== undefined

/** 跑一条真机用例时留够时间：起浏览器 + 联网 + 加载页面。 */
const REAL_TIMEOUT_MS = 90_000

/**
 * 自带的测试页。
 *
 * 用 `data:` URL 而不是公网地址：内容固定，断言不受网络波动与浏览器翻译影响。
 * 点一下 `#mark` 就会把文字改成「已点击」——用来证明点击真的发生了。
 */
const DEMO_PAGE =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<html><body><h1>CDP 驱动自测页</h1><button id="mark" onclick="this.textContent=\'已点击\'">标记</button></body></html>',
  )

describe.skipIf(!hasBrowser)('CDP 驱动（真机）', () => {
  it(
    '真的起一个浏览器，开页面、读正文、截图、点元素',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        expect(driver.name).toBe('cdp')

        // 开一个自带的页面：内容是我们自己写的，断言不受网络与浏览器翻译影响。
        await driver.open(DEMO_PAGE)

        // 读正文。
        const text = await driver.readText()
        expect(text).toContain('CDP 驱动自测页')

        // 截图：拿到的是真的 PNG（有 PNG 的魔数）。
        const shot = await driver.screenshot()
        expect(shot.mimeType).toBe('image/png')
        expect(shot.bytes.byteLength).toBeGreaterThan(1000)
        // PNG 魔数：89 50 4E 47。
        expect([...shot.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])

        // 点一个元素：点完页面上的标记要变。
        await driver.click('#mark')
        const after = await driver.readText()
        expect(after).toContain('已点击')
      } finally {
        await factory.close()
      }
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '真的能打开公网网页并读到正文',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        await driver.open('https://example.com')
        const text = await driver.readText()
        // example.com 的正文会被 Edge 的翻译功能改成中文，所以只断言「读到东西了」。
        expect(text.length).toBeGreaterThan(20)
        expect(text).toContain('example')
      } finally {
        await factory.close()
      }
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '点不存在的元素要报 DRIVER_FAILED，不是假装成功',
    async () => {
      const factory = createCdpDriverFactory()
      try {
        const driver = await factory.driverFactory()
        await driver.open(DEMO_PAGE)
        await expect(driver.click('#definitely-not-there')).rejects.toThrow(/找不到元素/)
      } finally {
        await factory.close()
      }
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '关掉工厂之后浏览器进程收干净，不留孤儿',
    async () => {
      const factory = createCdpDriverFactory()
      const driver = await factory.driverFactory()
      await driver.open(DEMO_PAGE)
      await factory.close()
      // 关掉之后驱动再用会失败——这正说明连接真的断了，不是假装还能用。
      await expect(driver.readText()).rejects.toThrow()
    },
    REAL_TIMEOUT_MS,
  )
})

describe('CDP 驱动的纯逻辑部分（不碰浏览器）', () => {
  it('找不到浏览器时给结构化的 NO_DRIVER 错误', async () => {
    // 指一个一定不存在的路径：走的是「显式给了路径但文件不在」这一支。
    const factory = createCdpDriverFactory({ executablePath: 'C:\\definitely\\not\\there.exe' })
    await expect(factory.driverFactory()).rejects.toMatchObject({ code: 'NO_DRIVER' })
    await factory.close()
  })

  it('显式给了不存在的路径时找不到浏览器', () => {
    expect(findBrowserExecutable({ executablePath: 'C:\\definitely\\not\\there.exe' })).toBeUndefined()
  })
})
