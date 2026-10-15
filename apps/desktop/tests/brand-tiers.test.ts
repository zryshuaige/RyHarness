// @vitest-environment node

/**
 * 品牌标记的两条硬指标（复评 P0）：
 *
 *   1. 16px 到 256px 都读作「猫」。评审记的是「耳朵与脸的轮廓比例导致识别跑偏，
 *      读成兔子」——兔子耳是又高又窄的长条（母版旧值：高/底 ≈ 2.4，耳高 ≈ 1.15×脸
 *      半径），猫耳是宽底矮顶的三角。这里把几何算出来钉死，顺带钉住两耳之间的负
 *      空间凹口与 ω 形嘴（只有一段弧的嘴在猫/狗/兔之间分不出家）。
 *   2. 尺寸分级是真的分级。小尺寸档必须是**独立栅格化**并做过光学补偿的产物，
 *      拿 256 档降采样只会把糊掉的结果缩小。这里用可测量的方式证明：小尺寸档的墨
 *      像素必须比同尺寸的降采样更多（加粗五官 / 删细节换来的识别度）。
 *
 * 另外钉住两处接线：托盘取 16/24 档、窗口取 256 档（不再从大图缩）；favicon 与
 * 单色版真的被网页端引到，且 public/ 里的副本与母版逐字节一致（单一真源）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { trayIconTier } from '../electron/main.ts'
import { RENDERER_MOUNT } from '../electron/renderer-assets.ts'

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

const readBrand = (name: string): string => {
  return readFileSync(resolve(BRAND, name), 'utf8')
}
const html = readFileSync(HTML_FILE, 'utf8')

/** 分级契约：档位表与每档的光学补偿参数，由 gen:icon 与母版一起生成。 */
interface TierTuning {
  eye: number
  mouth: number
  nose: number
}
interface TierManifest {
  tray: string
  trayHiDpi: string
  window: string
  favicon: string
  faviconPng: string
  mono: string
  /** 键是像素边长，值是该档的补偿参数。 */
  tuning: Record<string, TierTuning>
}
const tiers = JSON.parse(readFileSync(join(BRAND, 'tiers.json'), 'utf8')) as TierManifest
const TIER_SIZES = Object.keys(tiers.tuning).map(Number)
const tuningOf = (size: number): TierTuning => {
  return tiers.tuning[String(size)] as TierTuning
}

/** PNG 头 24 字节里就是宽高（IHDR），不引 sharp 也能核对导出尺寸。 */
function pngSize(file: string): { width: number; height: number } {
  const head = readFileSync(file)
  expect(head.subarray(1, 4).toString('latin1'), file).toBe('PNG')
  expect(head.subarray(12, 16).toString('latin1'), file).toBe('IHDR')
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/** 暗像素数：五官墨色比脸底暗一个数量级，阈值卡在两者中间。 */
async function inkPixels(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let count = 0
  for (let i = 0; i < data.length; i += info.channels) {
    const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
    if (luma < 0.25) count++
  }
  return count
}

interface Point {
  x: number
  y: number
}
const dist = (a: Point, b: Point): number => {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
/** 点到线段的垂距（耳高就是耳尖到底边的距离）。 */
function distanceToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy)
}

const master = readBrand('cat-face.svg')
const head = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" class="face"/.exec(master)
if (head === null) throw new Error('母版里没有脸')
const HEAD: Point = { x: Number(head[1]), y: Number(head[2]) }
const R = Number(head[3])
/** 耳朵三角写作 M(外侧底角) L(耳尖) L(内侧底角) Z。 */
const earPaths = [
  ...master.matchAll(/<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) Z" class="face"/g),
].map((match) => {
  const at = (i: number): Point => {
    return { x: Number(match[i]), y: Number(match[i + 1]) }
  }
  return { outer: at(1), tip: at(3), inner: at(5) }
})

describe('识别度：轮廓比例与负空间都指向「猫」而不是「兔子」', () => {
  it('耳朵是宽底矮顶的三角，不是又高又窄的长条', () => {
    expect(earPaths).toHaveLength(2)
    for (const ear of earPaths) {
      const base = dist(ear.outer, ear.inner)
      const height = distanceToLine(ear.tip, ear.outer, ear.inner)
      // 兔子耳的判据就是这个比值：旧母版 2.4（高 17.4 / 底 10.9），肉眼看是两根天线。
      expect(height / base, '耳高/耳底').toBeLessThanOrEqual(1.6)
      // 耳高相对脸半径也不能超过一整圈——旧值 1.15，耳尖比整颗脸还高。
      expect(height / R, '耳高/脸半径').toBeLessThanOrEqual(0.8)
      // 反过来底不能太窄，否则还是同一根长条
      expect(base / R, '耳底/脸半径').toBeGreaterThanOrEqual(0.4)
      // 耳尖露出脸的顶不超过 0.7 圈
      expect((HEAD.y - R - ear.tip.y) / R, '耳尖高出脸顶').toBeLessThanOrEqual(0.7)
    }
  })

  it('两只耳的外侧底角落在脸的圆周上（负空间的凹口由此才有）', () => {
    for (const ear of earPaths) {
      expect(Math.abs(dist(ear.outer, HEAD) - R), '外侧底角').toBeLessThanOrEqual(0.3)
      expect(Math.abs(dist(ear.inner, HEAD) - R), '内侧底角').toBeLessThanOrEqual(0.3)
    }
    // 两耳内侧底角之间留出一条窄缝：头顶从这里凹进去，猫耳的 V 口
    const gap = Math.abs(earPaths[0]?.inner.x - (earPaths[1]?.inner.x ?? 0))
    expect(gap).toBeGreaterThan(0)
    expect(gap, '两耳之间的缝').toBeLessThan(R * 0.5)
  })

  it('脸要够圆够大：圆脸 + 宽耳才是猫，小脸配长耳就是兔子', () => {
    expect(R, '脸半径').toBeGreaterThanOrEqual(16)
    // 整只猫（耳尖到下巴）占满 64 网格的大半，不能缩成底板中间的一小点
    const top = Math.min(...earPaths.map((ear) => ear.tip.y))
    expect((HEAD.y + R - top) / 64).toBeGreaterThan(0.6)
  })

  it('嘴是 ω 形（两段曲线），不是一条孤零零的弧', () => {
    const mouth = /<path class="ink" d="([^"]+)"/.exec(master)?.[1]
    expect(mouth).toBeDefined()
    expect((mouth as string).match(/\bq[\d.]/g), '嘴的曲线段数').toHaveLength(2)
  })

  it('三态只换五官与星光：耳朵比例在三个母版里逐字符相同', () => {
    for (const mood of ['cat-face-thinking.svg', 'cat-face-happy.svg']) {
      const ears = [...readBrand(mood).matchAll(/<path d="(M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z)"/g)]
        .map((match) => {
          return match[1]
        })
        .join(' | ')
      expect(ears, mood).toBe('M21.5 22.6 L19.6 10.4 L29.1 19.3 Z | M42.5 22.6 L44.4 10.4 L34.9 19.3 Z')
    }
  })
})

describe('尺寸分级导出（16/24/32/48/64/128/256）', () => {
  it('档位表覆盖七档，每一档都有彩色与单色位图且像素尺寸对得上', () => {
    expect(TIER_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256])
    for (const size of TIER_SIZES) {
      for (const name of [`icon-${size}.png`, `icon-mono-${size}.png`]) {
        const file = join(ASSETS, name)
        expect(existsSync(file), name).toBe(true)
        expect(pngSize(file), name).toEqual({ width: size, height: size })
      }
    }
    // 安装包用的多档 ICO 也得有
    expect(existsSync(join(ASSETS, 'icon.ico'))).toBe(true)
  })

  it('小尺寸档做过光学补偿：加粗五官、该删的细节删掉', () => {
    const masterEye = 2.7
    const masterMouth = 1.9
    for (const size of TIER_SIZES) {
      const tier = tuningOf(size)
      const rendered = (size * tier.eye * 2) / 64
      if (size <= 32) {
        // 眼直径在 16px 上低于 1.5px 就等于看不见，必须补大
        expect(tier.eye, `${size}px 眼半径`).toBeGreaterThanOrEqual(masterEye)
        expect(rendered, `${size}px 眼直径`).toBeGreaterThanOrEqual(1.5)
      }
      if (tier.mouth === 0) {
        // 16px 上嘴只有 0.5px 宽，留着只是噪点
        expect(size).toBe(16)
      } else if (size <= 48) {
        expect(tier.mouth, `${size}px 嘴宽`).toBeGreaterThanOrEqual(masterMouth)
      }
    }
    expect(tuningOf(16).mouth).toBe(0)
  })

  it('小尺寸档不是 256 档的降采样：补偿后墨像素更多（16px 上一眼能看出来）', async () => {
    const master256 = readFileSync(join(ASSETS, 'icon-256.png'))
    for (const size of [16, 24, 32, 48, 64]) {
      const naive = await sharp(master256).resize(size, size).png().toBuffer()
      const tuned = readFileSync(join(ASSETS, `icon-${size}.png`))
      expect(await inkPixels(tuned), `${size}px`).toBeGreaterThan(await inkPixels(naive))
    }
  }, 30_000)
})

describe('接线：托盘取 16/24 档、窗口取 256 档', () => {
  it('main.ts 的档位表与 tiers.json 逐项对上', () => {
    const main = readFileSync(join(DESKTOP, 'electron/main.ts'), 'utf8')
    for (const tier of [tiers.tray, tiers.trayHiDpi, tiers.window]) {
      expect(main, tier).toContain(`'${tier}'`)
    }
    // 托盘不再拿 256 档缩到 16：那份缩出来的是糊掉的母版，不是做过补偿的 16 档
    expect(main).not.toContain('createFromPath(APP_ICON).resize(')
    expect(main).toContain("tray: 'icon-16.png'")
    expect(main).toContain("trayHiDpi: 'icon-24.png'")
    expect(main).toContain("window: 'icon-256.png'")
    expect(main).toContain("icon: appIcon('window')")
  })

  it('HiDPI 屏给 24 档，其余给 16 档', () => {
    expect(trayIconTier(1)).toBe('tray')
    expect(trayIconTier(1.25)).toBe('tray')
    expect(trayIconTier(1.5)).toBe('trayHiDpi')
    expect(trayIconTier(2)).toBe('trayHiDpi')
  })
})

describe('接线：favicon 与单色版真的被网页端引到', () => {
  it('index.html 挂了三条 icon link，且都指向 RENDERER_MOUNT 下的真实文件', () => {
    const links = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map((match) => {
      return match[0]
    })
    expect(links).toHaveLength(3)
    const hrefs = [...html.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((match) => {
      return match[1] as string
    })
    expect(hrefs).toEqual([
      `${RENDERER_MOUNT}/${tiers.faviconPng}`,
      `${RENDERER_MOUNT}/${tiers.favicon}`,
      `${RENDERER_MOUNT}/${tiers.mono}`,
    ])
    for (const href of hrefs) {
      // 页面挂在 /app 上（没有尾斜杠），根相对的 href 在生产里会 404；这里钉住前缀。
      expect(href.startsWith(`${RENDERER_MOUNT}/`), href).toBe(true)
      const name = href.slice(RENDERER_MOUNT.length + 1)
      expect(existsSync(join(PUBLIC, name)), `${name} → renderer/public`).toBe(true)
      expect(existsSync(join(ASSETS, name)) || existsSync(join(BRAND, name)), `${name} 有产物`).toBe(true)
    }
  })

  it('单色版只挂在深色底那条上（浅色标签栏上它等于隐形）', () => {
    const monoLink = [...html.matchAll(/<link rel="icon"[^>]*>/g)]
      .map((match) => {
        return match[0]
      })
      .find((tag) => {
        return tag.includes(tiers.mono)
      })
    expect(monoLink).toContain(`media="(prefers-color-scheme: dark)"`)
    // 彩色 favicon 自带琥珀底板，深浅底都压得住
    expect(readBrand('favicon.svg')).toContain('ryagent-plate')
    expect(readBrand('icon-mono.svg')).not.toContain('ryagent-plate')
  })

  it('public/ 是母版的逐字节副本，不是另画的一份', () => {
    for (const [name, from] of [
      ['favicon.svg', join(BRAND, 'favicon.svg')],
      ['icon-mono.svg', join(BRAND, 'icon-mono.svg')],
      ['favicon-32.png', join(ASSETS, 'favicon-32.png')],
    ]) {
      expect(readFileSync(join(PUBLIC, name)).equals(readFileSync(from)), name).toBe(true)
    }
    expect([tiers.favicon, tiers.faviconPng]).toEqual(['favicon.svg', 'favicon-32.png'])
  })

  it('零外部素材：被引到网页端的两个 SVG 都不引用站外资源', () => {
    for (const name of ['favicon.svg', 'icon-mono.svg']) {
      const svg = readBrand(name)
      expect(svg, name).not.toMatch(/<(image|use)\b/)
      expect(svg.replace(/xmlns(:\w+)?="[^"]*"/g, ''), name).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    }
  })
})
