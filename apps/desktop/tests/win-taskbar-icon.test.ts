// @vitest-environment node

/**
 * Windows 任务栏按钮那枚图标的验收网。
 *
 * 打包后任务栏显示 Electron 默认图标，原因不在资产也不在 exe（两者都对），而在**窗口**
 * 这一环：任务栏按钮的图标取自窗口的 WM_SETICON，取不到才继续往下退；而 exe 内嵌图标
 * 那条退路在 Windows 11 上会被显式 AUMID 截断——进程带着 AUMID 时 Explorer 先去找该
 * AUMID 注册的资源，找不到就不再退到 exe，直接画默认字形。于是 WM_SETICON 必须真的设上。
 *
 * 这条链上有四个来源，四个都得对：
 *   1. assets/icon.ico            —— 内容与档位（gen-icon 的产物）
 *   2. exe 内嵌资源              —— electron-builder 拿同一个 .ico 写进 RyHarness.exe
 *   3. 开始菜单快捷方式          —— IconLocation 指向 exe，AUMID 与进程一致
 *   4. BrowserWindow 的 icon     —— 打包态此前喂的是 **asar 内**一张 256 PNG
 *
 * 第 4 条是此前唯一只在开发态（真实文件）验过的一环，且喂的不是 Windows 要的格式：
 * Electron 自己的 BrowserWindow.icon 文档写着 "On Windows it is recommended to use
 * `ICO` icons"（node_modules/electron/electron.d.ts），一张 256 档 PNG 要被系统自己
 * 降采样出 16/24/32/48/64。改法是把 .ico 随安装包 extraResources 放到 asar 之外，
 * 打包态从 process.resourcesPath 取。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// main.ts 顶层只 import electron 的具名导出，真正用到的 API 都在函数体内
// （main() 见文件末尾的 VITEST 守卫）。这里给一份够导入的替身即可。
vi.mock('electron', () => {
  return {
    app: {},
    BrowserWindow: class {},
    dialog: {},
    ipcMain: {},
    Menu: {},
    Notification: {},
    nativeImage: {},
    screen: {},
    shell: {},
    Tray: class {},
  }
})

const { windowIconPath } = await import('../electron/main.ts')

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as {
  build: { files: string[]; extraResources: { from: string; to: string }[]; win: { icon: string } }
}

/** ICO 目录项：6 字节头 + 每档 16 字节；宽/高那一字节为 0 表示 256。 */
function icoFrames(file: string): { size: number; bitCount: number }[] {
  const buf = readFileSync(file)
  expect(buf.readUInt16LE(2), 'ICO 类型：1 = 图标').toBe(1)
  const frames: { size: number; bitCount: number }[] = []
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const at = 6 + i * 16
    frames.push({
      size: buf[at] === 0 ? 256 : (buf[at] as number),
      bitCount: buf.readUInt16LE(at + 6),
    })
  }
  return frames
}

describe('assets/icon.ico：Windows 取的每一档都在', () => {
  it('含 16/24/32/48/64/256 六档，且都是 32 位', () => {
    // 少任何一档，Windows 都会拿最近的一档硬缩；256 档缺了尤其明显（任务栏 24 档）。
    const frames = icoFrames(join(DESKTOP, 'assets/icon.ico'))
    expect(frames.map((frame) => frame.size)).toEqual([16, 24, 32, 48, 64, 256])
    for (const frame of frames) expect(frame.bitCount, `${frame.size}px`).toBe(32)
  })
})

describe('窗口图标：打包态必须落在 app.asar 之外', () => {
  // 安装后的真实布局：resources/app.asar/main/ 是编译产物所在目录。
  const layout = {
    here: join('C:\\apps\\RyHarness', 'resources', 'app.asar', 'main'),
    resourcesPath: join('C:\\apps\\RyHarness', 'resources'),
    isPackaged: true,
  }

  it('打包态取 resources 根下的 .ico，不碰 asar', () => {
    const icon = windowIconPath(layout)
    expect(icon).not.toContain('app.asar')
    expect(icon.endsWith('.ico'), 'Windows 要 .ico，256 档 PNG 得由系统自己降采样').toBe(true)
    expect(icon).toBe(join(layout.resourcesPath, 'icon.ico'))
  })

  it('开发态取仓库里那份 assets/icon.ico（真实存在）', () => {
    const icon = windowIconPath({ ...layout, here: join(DESKTOP, 'main'), isPackaged: false })
    expect(icon).toBe(join(DESKTOP, 'assets', 'icon.ico'))
    expect(existsSync(icon)).toBe(true)
  })
})

describe('打包配置：打包态那条路径下真的有文件', () => {
  it('extraResources 把 icon.ico 放到 resources 根（= windowIconPath 的打包态落点）', () => {
    const entry = pkg.build.extraResources.find((res) => res.from === 'assets/icon.ico')
    expect(entry, '没有它，打包态 windowIconPath 指向一个不存在的文件，WM_SETICON 又落空').toBeDefined()
    expect(entry?.to).toBe('icon.ico')
  })

  it('win.icon（exe 内嵌）与窗口图标是同一份源', () => {
    expect(pkg.build.win.icon).toBe('assets/icon.ico')
  })

  it('托盘两档仍在 asar 内：files 仍收 assets/**', () => {
    expect(pkg.build.files).toContain('assets/**/*')
  })
})
