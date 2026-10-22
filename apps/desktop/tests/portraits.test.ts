// @vitest-environment node

/**
 * 立绘的验收网：四张立绘是不是「一家人」。
 *
 * 立绘此前是四条各写各的路径产出的——底色有琥珀 / 饱和蓝 / 紫蓝三种，构图有脸部特写 /
 * 全身带道具 / 头戴贝雷帽三种，渲染有 3D 与平面剪影两种。四张图同屏就是四种语言，
 * 而「要成一家」此前只是一句口头约定：谁改图谁拍脑袋，于是它就一直是四张。
 *
 * 这份网把它变成**能被测试断言的数字**：
 *
 *   1. 三方键集合一致 —— PORTRAITS / FILES / PortraitKey 必须一一对应，
 *      防止「注册表加了新键却忘了传文件」（那会在界面上留下一张裂图）。
 *   2. 三档齐备且尺寸对得上 —— 24 / 64 / 256 档都在，像素尺寸就是档位尺寸。
 *      24 档是新增的：此前最小档是 64，浏览器缩到 20px 时人物糊成一团色斑。
 *   3. 四角透明 —— 圆形透明底是硬约束。方形立绘进 50% 的圆形画布会被切角，
 *      而不透明的方角在暗色主题上就是一块白补丁。
 *   4. 底色同属暖琥珀 —— 全家只有一系底色。系统里蓝是 --info 语义色，
 *      出现在头像上会读成「这是出错了」。
 *   5. 主体占圆比例落在指定区间 —— bust（头肩）0.62–0.70，head（特写）0.70–0.95。
 *      这是「构图统一」的可验收形式。
 *   6. 占位立绘要标明自己是占位 —— 剪影不是第 4 个正式角色。
 *
 * 断言钉结构不变量（文件、尺寸、形状、底色族、比例、占位标记），
 * 不钉具体长相——换一张图不必然是错的。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  isPortraitKey,
  PORTRAITS,
  type PortraitKey,
  portraitOf,
  portraitSrcSet,
} from '../renderer/src/lib/brand-portraits.ts'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORTRAIT_DIR = join(DESKTOP, 'assets/portraits')

/** 三档的像素尺寸。 */
const TIERS = [24, 64, 256]

/** 统一底色（与 gen-portraits.mjs 的 PLATE 同一口径）。 */
const PLATE = { r: 252, g: 236, b: 204 }

/** 判定「这是底板不是主体」的色距阈值。 */
const PLATE_TOLERANCE = 40

/** bust 档（头肩构图）的主体占圆面积区间。 */
const BUST_RATIO = [0.62, 0.7]
/** head 档（脸部特写）的主体占圆面积区间。 */
const HEAD_RATIO = [0.7, 0.95]

function fileOf(key: string, size: number): string {
  return join(PORTRAIT_DIR, `${key}-${size}.webp`)
}

interface Pixels {
  width: number
  height: number
  channels: number
  data: Buffer
}

async function readPixels(file: string): Promise<Pixels> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, channels: info.channels, data }
}

/** 某像素的 alpha。 */
function alphaAt(pixels: Pixels, x: number, y: number): number {
  return pixels.data[(y * pixels.width + x) * pixels.channels + 3] as number
}

/** 主体（非底板色）占圆面积的比例。 */
function subjectRatio(pixels: Pixels): number {
  let subject = 0
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const i = (y * pixels.width + x) * pixels.channels
      if ((pixels.data[i + 3] as number) < 128) continue
      const d = Math.hypot(
        (pixels.data[i] as number) - PLATE.r,
        (pixels.data[i + 1] as number) - PLATE.g,
        (pixels.data[i + 2] as number) - PLATE.b,
      )
      if (d > PLATE_TOLERANCE) subject++
    }
  }
  const radius = pixels.width / 2
  return subject / (Math.PI * radius * radius)
}

/**
 * 底板色：取圆盘**外缘**那一圈的众数色。
 *
 * 为什么不用整幅图的众数色：剪影立绘（mask）的主体是一片连成片的深棕，
 * 面积比底板还大，整幅众数色量到的是剪影而不是底板。外缘那一圈一定是底板
 * （主体不贴边——取景时留了余量），所以从那里取色。
 */
function plateColor(pixels: Pixels): { r: number; g: number; b: number } {
  const { width: w, height: h } = pixels
  const cx = w / 2
  const cy = h / 2
  const radius = w / 2
  const counts = new Map<string, number>()
  // 外缘环：半径的 80%–92%（贴着圆边，但在遮罩之内）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * pixels.channels
      if ((pixels.data[i + 3] as number) < 128) continue
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius
      if (d < 0.8 || d > 0.92) continue
      const key = `${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const [r, g, b] = ([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0,0,0').split(',').map(Number)
  return { r: r as number, g: g as number, b: b as number }
}

/** 颜色的色相（度，0–360）。 */
function hueOf(color: { r: number; g: number; b: number }): number {
  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  const delta = max - min
  if (delta === 0) return 0
  if (max === color.r) return 60 * (((color.g - color.b) / delta) % 6)
  if (max === color.g) return 60 * ((color.b - color.r) / delta + 2)
  return 60 * ((color.r - color.g) / delta + 4)
}

describe('立绘注册表：三方键集合必须一致', () => {
  it('PORTRAITS 的键、PortraitKey 联合与实际文件三处对得上', () => {
    const registered = PORTRAITS.map((portrait) => {
      return portrait.key
    })
    // PortraitKey 联合与 PORTRAITS 是同一份清单：加键时两处都要动（isPortraitKey 读它）。
    for (const key of registered) {
      expect(isPortraitKey(key), key).toBe(true)
      expect(portraitOf(key)?.key, key).toBe(key)
    }
    // 键不重复
    expect(new Set(registered).size, `注册表有重复键：${registered.join(',')}`).toBe(registered.length)
  })

  it('每一键都有三档产物，且像素尺寸就是档位尺寸', async () => {
    for (const portrait of PORTRAITS) {
      for (const size of TIERS) {
        const file = fileOf(portrait.key, size)
        expect(existsSync(file), `${portrait.key}-${size}.webp 缺失`).toBe(true)
        const meta = await sharp(file).metadata()
        expect(meta.width, `${portrait.key}-${size} 宽`).toBe(size)
        expect(meta.height, `${portrait.key}-${size} 高`).toBe(size)
      }
    }
  })

  it('资产目录里没有多余的档位文件（新增立绘忘了更新注册表时会被看见）', () => {
    const expected = PORTRAITS.flatMap((portrait) => {
      return TIERS.map((size) => {
        return `${portrait.key}-${size}.webp`
      })
    }).sort()
    const actual = readdirSync(PORTRAIT_DIR)
      .filter((name) => name.endsWith('.webp'))
      .sort()
    expect(actual).toEqual(expected)
  })

  it('srcset 三档齐全：24w 是给接力链与群头像格的新档', () => {
    const srcset = portraitSrcSet('dog')
    expect(srcset).toContain('24w')
    expect(srcset).toContain('64w')
    expect(srcset).toContain('256w')
  })
})

describe('立绘形状：圆形透明底是硬约束', () => {
  it('每一档的四角都透明（方角在暗色主题上就是一块白补丁）', async () => {
    for (const portrait of PORTRAITS) {
      for (const size of TIERS) {
        const pixels = await readPixels(fileOf(portrait.key, size))
        for (const [x, y] of [
          [0, 0],
          [pixels.width - 1, 0],
          [0, pixels.height - 1],
          [pixels.width - 1, pixels.height - 1],
        ]) {
          expect(alphaAt(pixels, x as number, y as number), `${portrait.key}-${size} 角 (${x},${y})`).toBe(0)
        }
      }
    }
  })

  it('圆心是实的（不是抠空了一个环）', async () => {
    for (const portrait of PORTRAITS) {
      const pixels = await readPixels(fileOf(portrait.key, 64))
      const mid = Math.floor(pixels.width / 2)
      expect(alphaAt(pixels, mid, mid), `${portrait.key} 圆心`).toBeGreaterThan(200)
    }
  })
})

describe('立绘成一家：底色同属一系，构图落在同一口径', () => {
  it('四张立绘的底色都是暖琥珀洗底，没有蓝底与紫底', async () => {
    for (const portrait of PORTRAITS) {
      const pixels = await readPixels(fileOf(portrait.key, 64))
      const plate = plateColor(pixels)
      // 暖琥珀洗底：红 > 绿 > 蓝，且色相落在琥珀区间（约 25°–55°）。
      // 蓝底（蓝 ≥ 红）与紫底（红蓝接近）都会被这两条挡下。
      expect(plate.r, `${portrait.key} 底色 ${plate.r},${plate.g},${plate.b}`).toBeGreaterThan(plate.b)
      expect(plate.g, `${portrait.key} 底色 ${plate.r},${plate.g},${plate.b}`).toBeLessThan(plate.r)
      const hue = hueOf(plate)
      expect(hue, `${portrait.key} 底色色相 ${hue.toFixed(0)}° 应在琥珀区间`).toBeGreaterThan(20)
      expect(hue, `${portrait.key} 底色色相 ${hue.toFixed(0)}° 应在琥珀区间`).toBeLessThan(60)
    }
  })

  it('四张立绘的底色彼此接近（不是「都是暖色」但各差各的）', async () => {
    const plates = await Promise.all(
      PORTRAITS.map(async (portrait) => {
        return plateColor(await readPixels(fileOf(portrait.key, 64)))
      }),
    )
    // 任意两张之间的色距都在一条窄带内
    for (let i = 0; i < plates.length; i++) {
      for (let j = i + 1; j < plates.length; j++) {
        const a = plates[i] as { r: number; g: number; b: number }
        const b = plates[j] as { r: number; g: number; b: number }
        const distance = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
        expect(distance, `底色差 ${distance.toFixed(0)}（${PORTRAITS[i]?.key} vs ${PORTRAITS[j]?.key}）`).toBeLessThan(
          60,
        )
      }
    }
  })

  it('头肩档（64/256）的主体占圆 0.62–0.70：构图统一的可验收形式', async () => {
    for (const portrait of PORTRAITS) {
      for (const size of [64, 256]) {
        const ratio = subjectRatio(await readPixels(fileOf(portrait.key, size)))
        expect(
          ratio,
          `${portrait.key}-${size} 主体占圆 ${ratio.toFixed(3)}，应在 ${BUST_RATIO[0]}–${BUST_RATIO[1]}`,
        ).toBeGreaterThanOrEqual(BUST_RATIO[0])
        expect(
          ratio,
          `${portrait.key}-${size} 主体占圆 ${ratio.toFixed(3)}，应在 ${BUST_RATIO[0]}–${BUST_RATIO[1]}`,
        ).toBeLessThanOrEqual(BUST_RATIO[1])
      }
    }
  })

  it('脸部特写档（24）的主体占圆 0.70 以上：20px 位上要认得出是谁', async () => {
    for (const portrait of PORTRAITS) {
      const ratio = subjectRatio(await readPixels(fileOf(portrait.key, 24)))
      expect(
        ratio,
        `${portrait.key}-24 主体占圆 ${ratio.toFixed(3)}，特写档应 ≥ ${HEAD_RATIO[0]}`,
      ).toBeGreaterThanOrEqual(HEAD_RATIO[0])
      expect(ratio, `${portrait.key}-24 主体占圆 ${ratio.toFixed(3)}，特写档应 ≤ ${HEAD_RATIO[1]}`).toBeLessThanOrEqual(
        HEAD_RATIO[1],
      )
    }
  })
})

describe('立绘注册表：visualSpec 是验收项，不是描述', () => {
  it('每个立绘都声明了视觉规范，比例落在对应区间', () => {
    for (const portrait of PORTRAITS) {
      const spec = portrait.visualSpec
      expect(spec.plate, `${portrait.key} 底色系`).toBe('amber')
      expect(spec.subjectRatio, `${portrait.key} 比例`).toBeGreaterThanOrEqual(BUST_RATIO[0])
      expect(spec.subjectRatio, `${portrait.key} 比例`).toBeLessThanOrEqual(BUST_RATIO[1])
    }
  })

  it('占位立绘（剪影）被标出来：它不是第 4 个正式角色', () => {
    const placeholders = PORTRAITS.filter((portrait) => {
      return portrait.visualSpec.placeholder
    })
    expect(placeholders.length).toBeGreaterThan(0)
    for (const placeholder of placeholders) {
      expect(placeholder.label.length).toBeGreaterThan(0)
      // 占位必须说清自己是占位，不能让用户以为那就是它的正式形象
      expect(placeholder.hint, `${placeholder.key} 的人设说明要写明是占位`).toContain('占位')
    }
  })

  it('正式立绘的占位标记为 false', () => {
    for (const portrait of PORTRAITS) {
      if (portrait.key === 'mask') continue
      expect(portrait.visualSpec.placeholder, `${portrait.key}`).toBe(false)
    }
  })
})

describe('立绘键的类型出口', () => {
  it('PortraitKey 与注册表键集合一致（新增立绘要同时改联合类型）', () => {
    const keys: PortraitKey[] = ['cat', 'dog', 'fox', 'mask']
    expect(
      PORTRAITS.map((portrait) => {
        return portrait.key
      }).sort(),
    ).toEqual([...keys].sort())
  })
})
