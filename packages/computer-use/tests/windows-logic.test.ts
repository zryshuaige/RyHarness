/**
 * Windows 桌面驱动的用例：找 PowerShell、键名翻译、非 Windows 上的拒绝。
 *
 * 真截屏与真点击另有真机用例（`windows.test.ts`）；这一族盯的是纯逻辑：
 * 键名怎么翻、找不到 PowerShell 时说什么、非 Windows 上是不是如实拒绝。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findPowerShell, toSendKeys, WindowsDesktopDriver } from '../src/index.ts'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-pwsh-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('找 PowerShell', () => {
  it('显式给的路径存在就用它', () => {
    const dir = tempDir()
    const exe = join(dir, 'powershell.exe')
    writeFileSync(exe, '', 'utf8')
    expect(findPowerShell({ powershellPath: exe })).toBe(exe)
  })

  it('显式给的路径不存在：找不到就说找不到', () => {
    const dir = tempDir()
    expect(findPowerShell({ powershellPath: join(dir, 'nope.exe') })).toBeUndefined()
  })

  it('按 SystemRoot 找（本机 Windows 上找得到）', () => {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (root === undefined) return
    const found = findPowerShell({ env: { SystemRoot: root } })
    expect(found).toContain('powershell.exe')
  })
})

describe('键名翻译', () => {
  it('有名字的键翻成 SendKeys 的写法', () => {
    expect(toSendKeys('Enter')).toBe('{ENTER}')
    expect(toSendKeys('tab')).toBe('{TAB}')
    expect(toSendKeys('escape')).toBe('{ESC}')
    expect(toSendKeys('backspace')).toBe('{BACKSPACE}')
    expect(toSendKeys('pageup')).toBe('{PGUP}')
    expect(toSendKeys('f5')).toBe('{F5}')
  })

  it('修饰键翻成前缀', () => {
    expect(toSendKeys('ctrl+c')).toBe('^c')
    expect(toSendKeys('alt+tab')).toBe('%{TAB}')
    expect(toSendKeys('shift+a')).toBe('+a')
    expect(toSendKeys('win+r')).toBe('#r')
  })

  it('单字符原样', () => {
    expect(toSendKeys('a')).toBe('a')
  })

  it('已经写成 SendKeys 语法的原样用', () => {
    expect(toSendKeys('{ENTER}')).toBe('{ENTER}')
  })

  it('空名不炸', () => {
    expect(toSendKeys('')).toBe('')
    expect(toSendKeys('   ')).toBe('')
  })

  it('没收录的多字符键逐个发', () => {
    expect(toSendKeys('ab')).toBe('ab')
  })
})

describe('非 Windows 上的行为', () => {
  it('截图要如实报「没有驱动」，不是返回一张空图', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })

  it('点击同样要如实报', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.click(1, 1)).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })

  it('打字同样要如实报', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.type('你好')).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })

  it('按键同样要如实报', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.key('Enter')).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })

  it('移动同样要如实报', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.move(1, 1)).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })

  it('滚动同样要如实报', async () => {
    const driver = new WindowsDesktopDriver({ platform: 'linux' })
    await expect(driver.scroll(0, 120)).rejects.toMatchObject({ code: 'NO_DRIVER' })
  })
})
