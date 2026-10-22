// @vitest-environment node

/**
 * 图标分级导出的验收网：位图母版 → 逐档独立缩放 → 主进程与渲染层各自接线。
 *
 *   1. 分级契约只有一份 —— brand/tiers.json 是 gen-icon.mjs 写出的产物，档位表、圆角半径
 *      与接线文件名都必须与脚本里的源表逐项对上，防止有人手改 JSON 而下次生成被覆盖。
 *   2. 九档是同一枚母版的九次独立缩放 —— 逐像素比对「母版直接缩到该尺寸」的结果，
 *      把「有人又加回了脸部特写裁窗」钉死：一旦有裁窗，像素差立刻出现。
 *   3. 外轮廓随尺寸不变 —— 每档都带同一个圆角底板遮罩。托盘在非 HiDPI 下是圆角、HiDPI
 *      下是直角的那种分叉，就是从这里漏出去的。
 *   4. 耳朵在每一档都完整 —— 母版上两只耳尖的奶油色毛在最小那档也数得到，且分布左右两侧。
 *   5. 接线真的接上了 —— 托盘取 16/24 档、窗口取 256 档；index.html 的 icon link 指向
 *      RENDERER_MOUNT 下真实存在的文件；renderer/public 里的副本与 assets/ 逐字节一致。
 *
 * 断言钉结构不变量（文件齐备、像素尺寸、策略一致、像素与母版缩放一致、接线一致），
 * 不钉具体配色。为什么只有 PNG 没有 .svg：母版是位图，产不出真矢量，留一个自称矢量、
 * 实际内嵌 PNG 的包装只会给「这是一张真矢量」的错觉。消费方（安装包取 icon.ico、
 * Chromium 取 PNG favicon）都不需要 .svg。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { trayIconTier } from '../electron/main.ts'
import { RENDERER_MOUNT } from '../electron/renderer-assets.ts'
import { Cat } from '../renderer/src/components/Cat.tsx'

// gen-icon.mjs 以「是不是入口」守卫自己，直接 import 不会重写一遍产物。这里只声明
// 测试真正用到的那几个值。
interface GenIcon {
  MASTER: string
  MASTER_SIZE: number
  PLATE_RADIUS: number
  TIERS: number[]
  WIRING: { tray: string; trayHiDpi: string; window: string }
  DERIVED: Record<string, { file: string; size: number }>
}
// @ts-expect-error -- scripts/ 下是纯 Node 脚本，没有 .d.ts（仓库不开 allowJs），只需要它的运行时行为
const genIcon = await import('../scripts/gen-icon.mjs')
const { MASTER, MASTER_SIZE, PLATE_RADIUS, TIERS, WIRING, DERIVED } = genIcon as GenIcon

// main.ts 只在顶层 import electron 的具名导出，真正用到的 API 都在函数体内
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

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = join(DESKTOP, 'assets/brand')
const ASSETS = join(DESKTOP, 'assets')
const PUBLIC = join(DESKTOP, 'renderer/public')
const HTML_FILE = join(DESKTOP, 'renderer/index.html')

const html = readFileSync(HTML_FILE, 'utf8')

interface TierManifest {
  master: string
  masterSize: number
  plateRadius: number
  tray: string
  trayHiDpi: string
  window: string
  brand: string
  favicon: string
  faviconLarge: string
  icons: Record<string, { file: string; masked: boolean }>
}
const tiers = JSON.parse(readFileSync(join(BRAND, 'tiers.json'), 'utf8')) as TierManifest
const TIER_SIZES = TIERS

/** PNG 头 24 字节里就是宽高（IHDR），不引 sharp 也能核对导出尺寸。 */
function pngSize(file: string): { width: number; height: number } {
  const head = readFileSync(file)
  expect(head.subarray(0, 4).toString('hex'), file).toBe('89504e47')
  expect(head.subarray(12, 16).toString('latin1'), file).toBe('IHDR')
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/** 某个像素的 alpha。用来判「这一档有没有抠圆角」。 */
async function alphaAt(file: string, x: number, y: number): Promise<number> {
  const { data } = await sharp(file)
    .ensureAlpha()
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data[3] as number
}

describe('母版：assets/brand/mark.png', () => {
  it('母版是制备好的那一版：边长对上、四角抠成透明', async () => {
    const file = join(BRAND, MASTER)
    expect(existsSync(file), MASTER).toBe(true)
    expect(tiers.master).toBe(MASTER)
    expect(pngSize(file)).toEqual({ width: MASTER_SIZE, height: MASTER_SIZE })
    expect(tiers.masterSize).toBe(MASTER_SIZE)
    // 四角透明：母版之外没有像素。没有抠角的话，派生档在深色任务栏上会留一圈白角。
    for (const [x, y] of [
      [0, 0],
      [MASTER_SIZE - 1, 0],
      [0, MASTER_SIZE - 1],
      [MASTER_SIZE - 1, MASTER_SIZE - 1],
    ]) {
      expect(await alphaAt(file, x as number, y as number), `母版角 (${x},${y})`).toBe(0)
    }
    // 边中点是实心的琥珀底板（不是抠空的）
    expect(await alphaAt(file, 0, Math.floor(MASTER_SIZE / 2))).toBeGreaterThan(200)
  })

  it('品牌目录里只有母版与分级契约：没有第二份猫的造型', () => {
    // 矢量母版时代这里是「三态 SVG + 三份派生图标」，现在只剩这两份。
    expect(readdirSync(BRAND).sort()).toEqual(['mark.png', 'tiers.json'])
  })
})

describe('逐档导出：九档是同一枚母版的九次独立缩放', () => {
  it('档位表覆盖九档，每一档都有产物且像素尺寸对得上', () => {
    expect(TIER_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256, 512, 1024])
    for (const size of TIERS) {
      const file = join(ASSETS, tiers.icons[String(size)]?.file ?? `icon-${size}.png`)
      expect(existsSync(file), `${size}px`).toBe(true)
      expect(pngSize(file), `${size}px`).toEqual({ width: size, height: size })
    }
    // 安装包用的多档 ICO 也得有
    expect(existsSync(join(ASSETS, 'icon.ico'))).toBe(true)
  })

  it('分级契约只有一份：tiers.json 与 gen-icon 的源表逐项对得上', () => {
    expect(tiers.plateRadius).toBe(PLATE_RADIUS)
    // 契约里不再有裁窗：九档共用一块母版，形状不再随尺寸分叉。
    expect(tiers).not.toHaveProperty('faceCrop')
    expect({ tray: tiers.tray, trayHiDpi: tiers.trayHiDpi, window: tiers.window }).toEqual(WIRING)
    expect(
      Object.fromEntries(
        TIERS.map((size) => {
          return [String(size), { masked: true }]
        }),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(tiers.icons).map(([size, spec]) => {
          return [size, { masked: spec.masked }]
        }),
      ),
    )
  })

  it('每一档内区都与「母版直接缩到该尺寸」一致：没有裁窗，轮廓与母版逐像素相同', async () => {
    // 比圆角遮罩盖不到的内区（inset = 半径 + 2px）。
    //   alpha 通道逐字节相同 —— 轮廓就是母版的轮廓，一档都没多也没少；
    //   RGB 平均差 < 5 —— 加回脸部特写裁窗时实测平均差 32~62（24px 是 51.29），
    //   这里差 0.0~2.0。门槛离两个量级，不靠逐字节相等这种脆断言。
    for (const size of TIERS) {
      const inset = Math.round(size * PLATE_RADIUS) + 2
      const inner = Math.max(1, size - inset * 2)
      const box = { left: inset, top: inset, width: inner, height: inner }
      const fromMaster = await sharp(join(BRAND, MASTER))
        .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
        .extract(box)
        .ensureAlpha()
        .raw()
        .toBuffer()
      const produced = await sharp(join(ASSETS, `icon-${size}.png`))
        .extract(box)
        .ensureAlpha()
        .raw()
        .toBuffer()
      let alphaBad = 0
      let sum = 0
      for (let i = 0; i < produced.length; i++) {
        // 遮罩是逐像素 dest-in 合成，放大路径上有 ±1~3 的舍入（实测 128px 内区最大差
        // 3、共 16 个像素），按 8 容差比。真正要抓的是遮罩把内区啃掉一块。
        if (i % 4 === 3 && Math.abs((produced[i] as number) - (fromMaster[i] as number)) > 8) alphaBad++
        if (i % 4 !== 3) sum += Math.abs((produced[i] as number) - (fromMaster[i] as number))
      }
      expect(alphaBad, `${size}px 的轮廓与母版不一致`).toBe(0)
      const meanDiff = sum / (produced.length * 0.75)
      expect(meanDiff, `${size}px 内区与母版独立缩放差太多（被裁窗了？）`).toBeLessThan(5)
    }
  })

  it('外轮廓随尺寸不变：九档都带同一个圆角底板', async () => {
    // 这条钉的是「形状不随尺寸变」。曾经 24/32/48 是满出血直角方块，托盘于是非 HiDPI
    // 下圆角、HiDPI 下直角，同一枚 favicon 在 32 与 128 尺寸下两种身份。
    for (const size of TIERS) {
      const file = join(ASSETS, `icon-${size}.png`)
      expect(await alphaAt(file, 0, 0), `${size}px 左上角`).toBe(0)
      expect(await alphaAt(file, size - 1, size - 1), `${size}px 右下角`).toBe(0)
      // 圆角之外的正边中点仍然是实心底板（不是整张都被抠空）
      expect(await alphaAt(file, 0, Math.floor(size / 2)), `${size}px 左中`).toBeGreaterThan(200)
      expect(await alphaAt(file, Math.floor(size / 2), 0), `${size}px 上中`).toBeGreaterThan(200)
    }
    // favicon 两档也是同一套圆角：32 与 128 下缩放看到的轮廓必须一致
    for (const spec of Object.values(DERIVED)) {
      expect(await alphaAt(join(ASSETS, spec.file), 0, 0), spec.file).toBe(0)
    }
  })

  it('耳朵在每一档都完整：顶部条带左右两侧都数得到奶油色毛', async () => {
    // 「耳朵被切了」旧的断言测不出来——它只验「有深色像素」，切掉一只耳朵照样过。
    // 这里量的是耳朵本身：耳廓的奶油白（r-b < 70）在底板橙（r-b ≈ 130~190）上分得开。
    // 实测 16/24/32/48 档顶部 30% 条带内左/右分别有 1/3、4/9、11/20、28/47 个这样的像素。
    for (const size of TIERS) {
      const band = Math.max(2, Math.round(size * 0.3))
      const { data, info } = await sharp(join(ASSETS, `icon-${size}.png`))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      let left = 0
      let right = 0
      for (let y = 0; y < band; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * info.width + x) * info.channels
          const r = data[i] as number
          const b = data[i + 2] as number
          if (r < 170 || r - b >= 70) continue
          if (x < size / 2) left++
          else right++
        }
      }
      expect(left, `${size}px 左耳没了`).toBeGreaterThan(0)
      expect(right, `${size}px 右耳没了`).toBeGreaterThan(0)
    }
  })

  it('16px 托盘档数得出两只深色眼与粉鼻（托盘就吃这一档）', async () => {
    // 实测整幅 16px 深色 5 / 粉 27（24px 是 13 / 39）。此前文档写「裁到脸在 16px 全糊」，
    // 实测不成立——糊的不是脸，是把耳朵切掉了（依据见 docs/brand/icon.md）。
    const stats = async (file: string, size: number) => {
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let dark = 0
      let pink = 0
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i] as number
        const g = data[i + 1] as number
        const b = data[i + 2] as number
        if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25) dark++
        if (r > 190 && g > 100 && g < 190 && b > 110 && b < 190 && r - g > 20) pink++
      }
      expect(info.width, file).toBe(size)
      return { dark, pink }
    }
    const tray = await stats(join(ASSETS, tiers.tray), 16)
    expect(tray.dark, '16px 数不出两只眼').toBeGreaterThanOrEqual(4)
    expect(tray.pink, '16px 数不出粉鼻').toBeGreaterThanOrEqual(20)
  })
})

describe('接线：托盘取 16/24 档、窗口取 256 档', () => {
  it('main.ts 的档位表与 tiers.json 逐项对上', () => {
    const main = readFileSync(join(DESKTOP, 'electron/main.ts'), 'utf8')
    expect(main).toContain(`tray: '${tiers.tray}'`)
    expect(main).toContain(`trayHiDpi: '${tiers.trayHiDpi}'`)
    expect(main).toContain(`window: '${tiers.window}'`)
    // 托盘不再拿 256 档缩到 16：那份缩出来的是糊掉的母版，不是特写档
    expect(main).not.toContain('createFromPath(APP_ICON).resize(')
    expect(main).toContain("icon: appIcon('window')")
    for (const name of [tiers.tray, tiers.trayHiDpi, tiers.window]) {
      expect(existsSync(join(ASSETS, name)), name).toBe(true)
    }
  })

  it('HiDPI 屏给 24 档，其余给 16 档', () => {
    expect(trayIconTier(1)).toBe('tray')
    expect(trayIconTier(1.25)).toBe('tray')
    expect(trayIconTier(1.5)).toBe('trayHiDpi')
    expect(trayIconTier(2)).toBe('trayHiDpi')
  })
})

describe('接线：渲染层拿到的就是这些图', () => {
  it('index.html 挂了 icon link，且都指向 RENDERER_MOUNT 下真实存在的位图', () => {
    const hrefs = [...html.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((m) => {
      return m[1] as string
    })
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      // 页面挂在 /app 上（没有尾斜杠），根相对的 href 在生产里会 404；这里钉住前缀。
      expect(href.startsWith(`${RENDERER_MOUNT}/`), href).toBe(true)
      const name = href.slice(RENDERER_MOUNT.length + 1)
      expect(name.endsWith('.png'), `${name}：母版是位图，不产出 .svg 包装`).toBe(true)
      expect(existsSync(join(PUBLIC, name)), `${name} → renderer/public`).toBe(true)
      expect(existsSync(join(ASSETS, name)), `${name} 有产物`).toBe(true)
    }
  })

  it('renderer/public 里的品牌资产只有 gen-icon 声明的那几份，且与 assets/ 逐字节一致', () => {
    const declared = Object.values(DERIVED).map((spec) => spec.file)
    // public/ 里还住着桌面外壳自己的两个文件（主题引导脚本与 splash 样式，
    // 见 tests/desktop-shell-security.test.ts）——它们不是品牌资产，所以这里
    // 断言的是「品牌资产这一类不多不少」，而不是整个目录的精确清单：
    // 目录里多出一张猫图才是真问题（那是第二只猫）。
    const brandLike = readdirSync(PUBLIC).filter((name) => {
      return name.endsWith('.png') || name.endsWith('.svg')
    })
    expect(brandLike.sort()).toEqual([...declared].sort())
    for (const spec of Object.values(DERIVED)) {
      expect(readFileSync(join(PUBLIC, spec.file)).equals(readFileSync(join(ASSETS, spec.file))), spec.file).toBe(true)
    }
    // 契约里登记的名字与文件名一一对上（渲染层按 tiers.json 引用）
    for (const spec of Object.values(DERIVED)) {
      expect(Object.values(tiers)).toContain(spec.file)
    }
  })

  it('启动屏与 <Cat> 引的是同一张图（不是两份各自维护的猫）', () => {
    const splash = /<img[^>]*class="splash-mark"[^>]*>/.exec(html)?.[0] ?? ''
    expect(splash).not.toBe('')
    expect(splash).toContain(`${RENDERER_MOUNT}/${tiers.brand}`)
    // <Cat> 的 src 由组件自己拼（挂载前缀 + 文件名），这里渲染一次看真实产物，
    // 比在源码里找字符串更贴近「渲染层拿到的确实是这张图」。
    const badge = renderToStaticMarkup(createElement(Cat, { size: 40 }))
    expect(badge).toContain(`src="${RENDERER_MOUNT}/${tiers.brand}"`)
    expect(existsSync(join(PUBLIC, tiers.brand))).toBe(true)
  })
})
