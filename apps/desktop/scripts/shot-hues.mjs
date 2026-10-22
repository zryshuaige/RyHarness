/**
 * 出「6 动物 × 8 毛色」对照图（docs/hues.png，README 引用）。
 *
 * 这张图是文档的一部分：毛色改了、资产重抠了，都要重跑它，否则 README 里那张
 * 跟产品里对不上。用 Electron 的真 GPU 截（headless 的软光栅会让柔光层看起来
 * 不一样）。
 *
 * 用法：electron scripts/shot-hues.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(join(here, '..', 'docs', 'hues.png'))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: true,
    x: 40,
    y: 40,
    backgroundColor: '#f7f2ea',
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadFile(join(here, 'hues-sheet.html'))
  await new Promise((resolve) => {
    return setTimeout(resolve, 1500)
  })
  const image = await win.webContents.capturePage()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, image.toPNG())
  console.log(`[hues] saved ${out}`)
  app.quit()
})
