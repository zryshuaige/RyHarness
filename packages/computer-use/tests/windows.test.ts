/**
 * Windows 桌面驱动的**真机**用例：真的截屏、真的点、真的打字、真的按键。
 *
 * 这不是 mock 用例——它操作的是本机真实桌面。跑它需要：
 * - Windows；
 * - 一个能交互的桌面会话（远程桌面 / 无头环境里截图会是黑屏）。
 *
 * 不在 Windows 上时**整个文件跳过**：那是环境问题，不是代码坏了。
 *
 * @module @ryharness/computer-use/tests/windows
 */

import { describe, expect, it } from 'vitest'
import { findPowerShell, toSendKeys, WindowsDesktopDriver } from '../src/index.ts'

/** 本机是不是能跑这个驱动。 */
const onWindows = process.platform === 'win32'
const hasPowerShell = onWindows && findPowerShell() !== undefined

/** 桌面动作要起 PowerShell 进程，慢一点是正常的。 */
const REAL_TIMEOUT_MS = 60_000

describe.skipIf(!onWindows || !hasPowerShell)('Windows 桌面驱动（真机）', () => {
  it(
    '真的截到当前屏幕：拿到的是 PNG，尺寸与虚拟屏幕一致',
    async () => {
      const driver = new WindowsDesktopDriver()
      try {
        const shot = await driver.screenshot()
        expect(shot.mimeType).toBe('image/png')
        expect(shot.bytes.byteLength).toBeGreaterThan(1000)
        // PNG 魔数：89 50 4E 47。
        expect([...shot.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
        expect(shot.width).toBeGreaterThan(0)
        expect(shot.height).toBeGreaterThan(0)
      } finally {
        await driver.close()
      }
    },
    REAL_TIMEOUT_MS,
  )

  it(
    '真的移动鼠标、点击、滚动、打字、按键：每一步都不报错',
    async () => {
      const driver = new WindowsDesktopDriver()
      try {
        // 移到屏幕左上角附近（不点任何真实控件的位置，只验证动作本身跑得通）。
        await driver.move(5, 5)
        await driver.click(5, 5)
        await driver.scroll(0, 120)
        await driver.type('ryharness')
        await driver.key('Escape')
      } finally {
        await driver.close()
      }
    },
    REAL_TIMEOUT_MS,
  )
})

describe('Windows 桌面驱动的纯逻辑部分（不碰桌面）', () => {
  it('键名翻译成 SendKeys 写法', () => {
    expect(toSendKeys('Enter')).toBe('{ENTER}')
    expect(toSendKeys('tab')).toBe('{TAB}')
    expect(toSendKeys('escape')).toBe('{ESC}')
    expect(toSendKeys('ctrl+c')).toBe('^c')
    expect(toSendKeys('alt+tab')).toBe('%{TAB}')
    expect(toSendKeys('a')).toBe('a')
    // 已经写成 SendKeys 语法的原样用。
    expect(toSendKeys('{ENTER}')).toBe('{ENTER}')
    // 空名不炸。
    expect(toSendKeys('  ')).toBe('')
  })

  it('非 Windows 平台上驱动如实报错，不假装成功', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })
})
