// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AGENT_HUE_GRAPHIC,
  AGENT_HUE_TEXT_DARK,
  AGENT_HUE_TEXT_LIGHT,
  AVATAR_STYLE_BY_KEY,
  AVATAR_STYLES,
  agentHues,
  BRAND_AVATAR,
  dicebearSvg,
  fallbackColor,
  isAvatarStyleLoaded,
  loadAvatarStyle,
  parseAvatarSpec,
  randomAvatarSpec,
} from '../renderer/src/components/avatars/avatars.tsx'
import { GroupAvatar, groupGridAreas } from '../renderer/src/components/avatars/GroupAvatar.tsx'

/**
 * DiceBear 渲染器已拆成独立 chunk（styles-avatar.ts），avatars.tsx 只在风格未就绪
 * 时返回 null 并异步拉取。下面几个用例需要确定的「未加载」初始态，因此各自用
 * vi.resetModules() + 动态 import 拿一份全新的模块实例（自带空 loaded 表），并用
 * 假定时器压掉模块顶层的空闲预热（真实预热是 setTimeout 800ms，会让断言随机器快慢漂移）。
 */
async function freshAvatarModules(): Promise<typeof import('../renderer/src/components/avatars/avatars.tsx')> {
  vi.resetModules()
  return await import('../renderer/src/components/avatars/avatars.tsx')
}

describe('DiceBear 头像体系', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
  })

  it('风格收敛为 2 个：人物 dylan + 吉祥物 mascot（同屏不再黑白线稿与彩色卡通混排）', () => {
    expect(
      AVATAR_STYLES.map((s) => {
        return s.key
      }),
    ).toEqual(['dylan', 'mascot'])
    expect(
      AVATAR_STYLES.map((s) => {
        return s.name
      }),
    ).toEqual(['人物', '吉祥物'])
    for (const style of AVATAR_STYLES) {
      expect(style.license, style.key).toBe('CC-BY-4.0') // 收敛后不再有 CC0 风格
      expect(AVATAR_STYLE_BY_KEY[style.key], style.key).toBe(style)
    }
    expect(Object.isFrozen(AVATAR_STYLE_BY_KEY)).toBe(true)
  })

  it('懒加载：风格未就绪时返回 null，就绪后本地生成 SVG（无网络）', async () => {
    vi.useFakeTimers()
    const mod = await freshAvatarModules()
    expect(mod.isAvatarStyleLoaded('dylan')).toBe(false)
    // 未就绪：同步拿不到 SVG（同时已触发后台加载）
    expect(mod.dicebearSvg('dylan', 'test-seed')).toBeNull()
    expect(mod.isAvatarStyleLoaded('dylan')).toBe(false)

    await mod.loadAvatarStyle('dylan')
    expect(mod.isAvatarStyleLoaded('dylan')).toBe(true)
    const svg = mod.dicebearSvg('dylan', 'test-seed')
    expect(svg).toContain('<svg')
    expect(svg).toContain('http://www.w3.org/2000/svg')
    expect(svg).toContain('width="100%"') // 宽高 100% 由容器控制
    expect(svg).not.toContain('<metadata') // metadata 已剥离
    // 同 seed 结果稳定，不同 seed 结果不同
    expect(mod.dicebearSvg('dylan', 'test-seed')).toBe(svg)
    expect(mod.dicebearSvg('dylan', 'another-seed')).not.toBe(svg)
  })

  it('未知风格不产出 SVG，加载请求直接 reject', async () => {
    vi.useFakeTimers()
    const mod = await freshAvatarModules()
    expect(mod.dicebearSvg('nope', 'x')).toBeNull()
    expect(mod.isAvatarStyleLoaded('nope')).toBe(false)
    await expect(mod.loadAvatarStyle('nope')).rejects.toThrow('unknown avatar style "nope"')
  })

  it('avatar 字段编码解析：只认白名单风格，旧库值平滑降级为 null', () => {
    expect(parseAvatarSpec('db:dylan:abc123')).toEqual({ styleKey: 'dylan', seed: 'abc123' })
    expect(parseAvatarSpec('db:mascot:abc123')).toEqual({ styleKey: 'mascot', seed: 'abc123' })
    // 收敛掉的旧风格（旧库数据不再被解析成 DiceBear，走兜底色块）
    for (const legacy of ['lorelei', 'notionists', 'avataaars', 'bottts', 'fun-emoji', 'thumbs', 'unknown']) {
      expect(parseAvatarSpec(`db:${legacy}:abc123`), legacy).toBeNull()
    }
    expect(parseAvatarSpec('db:dylan:')).toBeNull() // seed 不能为空
    expect(parseAvatarSpec('cat')).toBeNull()
    expect(parseAvatarSpec('🐈')).toBeNull()
    expect(parseAvatarSpec(undefined)).toBeNull()
  })

  it('randomAvatarSpec 只生成白名单内的风格或品牌橘猫', () => {
    for (let i = 0; i < 20; i++) {
      const raw = randomAvatarSpec(() => {
        return 'fixedseed'
      })
      if (raw === BRAND_AVATAR) continue
      const spec = parseAvatarSpec(raw)
      expect(spec, raw).not.toBeNull()
      expect(AVATAR_STYLE_BY_KEY[spec!.styleKey], raw).toBeDefined()
      expect(spec!.seed).toBe('fixedseed')
    }
  })

  it('randomAvatarSpec 有一定概率落到品牌橘猫（品牌必须可达，不能只在数据库里）', () => {
    expect(BRAND_AVATAR).toBe('cat')
    const cat = vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(randomAvatarSpec()).toBe(BRAND_AVATAR)
    cat.mockRestore()
    // 不中猫时仍然只从白名单风格里取
    const style = vi.spyOn(Math, 'random').mockReturnValue(0.99)
    expect(
      randomAvatarSpec(() => {
        return 'fixedseed'
      }),
    ).toBe('db:mascot:fixedseed')
    style.mockRestore()
    // 概率不是 0：默认取 200 次，必有一次以上命中
    let hits = 0
    for (let i = 0; i < 200; i++) {
      if (randomAvatarSpec() === BRAND_AVATAR) hits++
    }
    expect(hits).toBeGreaterThan(0)
  })

  it('兜底色稳定', () => {
    expect(fallbackColor('CodeBot')).toBe(fallbackColor('CodeBot'))
    expect(fallbackColor('A')).not.toBe(fallbackColor('B'))
  })
})

/**
 * 栅格化工具：把 dicebearSvg 的产物当成浏览器里的 40px 圆形头像画一遍。
 * 「有输出」「色相稳定」这类断言量的是字符串，不是画面——真机那次破图（空白圆盘 + 左上角
 * 一小块蓝）就是在这类断言下长期挂着的：字符串完全正常，只有画出来才知道缺了九成。
 */
async function rasterize(svg: string, px: number) {
  const sized = svg.replace('width="100%" height="100%"', `width="${px}" height="${px}"`)
  const { data } = await sharp(Buffer.from(sized), { density: 600 })
    .resize(px, px, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = 4
  const at = (x: number, y: number) => {
    const i = (y * px + x) * channels
    return [data[i] as number, data[i + 1] as number, data[i + 2] as number, data[i + 3] as number]
  }
  return { px, at }
}

/** 四角不透明 = 底色铺满整个视口（画布没有被裁出透明的角）。 */
function opaqueCorners(r: Awaited<ReturnType<typeof rasterize>>): boolean {
  const { px, at } = r
  return [
    [0, 0],
    [px - 1, 0],
    [0, px - 1],
    [px - 1, px - 1],
  ].every(([x, y]) => at(x as number, y as number)[3] === 255)
}

/** 非底色像素的包围盒（占画布的比例 + 中心偏移），也就是「脸画在哪」。 */
function artBox(r: Awaited<ReturnType<typeof rasterize>>) {
  const { px, at } = r
  const bg = at(0, 0)
  let minX = px
  let minY = px
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const p = at(x, y)
      if (p[3] < 250) continue
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) < 24) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  // 一格底色都没有时返回一组必定挂掉断言的占位值，省掉调用点的非空断言。
  if (maxX < 0) return { empty: true, w: 0, h: 0, offX: 1, offY: 1 }
  const w = (maxX - minX + 1) / px
  const h = (maxY - minY + 1) / px
  return {
    empty: false,
    w,
    h,
    offX: (minX + (maxX - minX + 1) / 2) / px - 0.5,
    offY: (minY + (maxY - minY + 1) / 2) / px - 0.5,
  }
}

describe('DiceBear 渲染级不变量', () => {
  /** 内置 agent「阿屁」用的就是 mascot/hoarder，真机破图就是它。 */
  const seeds = ['hoarder', 'nightowl', 'scribe', 'ry1', 'ry2']
  const PX = 64

  it('两族的 SVG 都不再带文档全局 id（真机破图的根因）', async () => {
    for (const style of ['dylan', 'mascot']) {
      await loadAvatarStyle(style)
      for (const seed of seeds) {
        const svg = dicebearSvg(style, seed) ?? ''
        // DiceBear v9 给每张头像都发一个 <mask id="viewboxMask">，id 是文档全局的：
        // 同屏第二枚及以后的头像会引用到第一枚的遮罩，于是只剩左上角一块可见。
        expect(svg, `${style}/${seed}`).not.toContain('id="viewboxMask"')
        expect(svg, `${style}/${seed}`).not.toContain('url(#viewboxMask)')
      }
    }
  })

  it('viewBox 与满幅底色 rect 覆盖整块画布（不能只断言「有输出」）', async () => {
    for (const style of ['dylan', 'mascot']) {
      await loadAvatarStyle(style)
      for (const seed of seeds) {
        const svg = dicebearSvg(style, seed) ?? ''
        const tag = `${style}/${seed}`
        const box = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)
        expect(box, `${tag} 没有 viewBox`).not.toBeNull()
        const [vx, vy, vw, vh] = (box as RegExpExecArray).slice(1).map(Number) as [number, number, number, number]
        expect(vw, `${tag} viewBox 宽度`).toBeGreaterThan(0)
        const rect = /<rect\b[^>]*>/.exec(svg)
        expect(rect, `${tag} 没有底色 rect`).not.toBeNull()
        const attr = (name: string) => {
          return Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(rect?.[0] ?? '')?.[1] ?? 0)
        }
        expect(attr('x'), `${tag} 底色左沿`).toBeLessThanOrEqual(vx)
        expect(attr('y'), `${tag} 底色上沿`).toBeLessThanOrEqual(vy)
        expect(attr('x') + attr('width'), `${tag} 底色右沿`).toBeGreaterThanOrEqual(vx + vw)
        expect(attr('y') + attr('height'), `${tag} 底色下沿`).toBeGreaterThanOrEqual(vy + vh)
      }
    }
  })

  it('真渲染：底色铺满四角，脸铺开并居中（破图 = 只剩左上角一块）', async () => {
    // 阈值不是拍的：35 个 seed × 两族实测，横向最窄 0.688（mascot）/0.797（dylan），
    // 纵向最矮 0.391，横向中心最大偏移 0.016，纵向最大偏移 0.133。四角不透明 0 例外。
    // 破图状态下包围盒塌成 0.34×0.34 且中心偏到 -0.33，两条都挂。
    for (const style of ['dylan', 'mascot']) {
      await loadAvatarStyle(style)
      for (const seed of seeds) {
        const svg = dicebearSvg(style, seed) ?? ''
        const r = await rasterize(svg, PX)
        const tag = `${style}/${seed}`
        expect(opaqueCorners(r), `${tag} 四角透明：底色没铺满视口`).toBe(true)
        const box = artBox(r)
        expect(box.empty, `${tag} 一格底色都没有`).toBe(false)
        expect(box.w, `${tag} 美术横向铺得太窄`).toBeGreaterThan(0.6)
        expect(box.h, `${tag} 美术纵向铺得太矮`).toBeGreaterThan(0.35)
        expect(Math.abs(box.offX), `${tag} 美术横向偏心`).toBeLessThan(0.05)
        expect(Math.abs(box.offY), `${tag} 美术纵向偏心`).toBeLessThan(0.2)
      }
    }
  })
})

describe('身份色：图形与正文分两套 token', () => {
  /** WCAG 相对亮度与对比度。 */
  const relativeLuminance = (hexColor: string) => {
    const n = parseInt(hexColor.slice(1), 16)
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p)
    return (hi + 0.05) / (lo + 0.05)
  }
  /** 气泡底色：styles.css 的 --bubble-peer，浅色主题 #FFFFFF、暗色主题 #1C1E23。 */
  const BUBBLE_LIGHT = '#FFFFFF'
  const BUBBLE_DARK = '#1C1E23'

  it('图形色（1.4.11，3:1）对两套气泡底都成立', () => {
    for (const color of AGENT_HUE_GRAPHIC) {
      expect(contrast(color, BUBBLE_LIGHT), `${color} 对白底`).toBeGreaterThanOrEqual(3)
      expect(contrast(color, BUBBLE_DARK), `${color} 对暗底`).toBeGreaterThanOrEqual(3)
    }
  })

  it('正文色（1.4.3，4.5:1）各对自己的主题底色成立', () => {
    for (const color of AGENT_HUE_TEXT_LIGHT) {
      expect(contrast(color, BUBBLE_LIGHT), `${color} 对白底`).toBeGreaterThanOrEqual(4.5)
    }
    for (const color of AGENT_HUE_TEXT_DARK) {
      expect(contrast(color, BUBBLE_DARK), `${color} 对暗底`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('两套 token 确实不同：图形色当不了正文色（这正是要拆的原因）', () => {
    expect(AGENT_HUE_TEXT_LIGHT).not.toBe(AGENT_HUE_GRAPHIC)
    expect(AGENT_HUE_TEXT_DARK).not.toBe(AGENT_HUE_GRAPHIC)
    // 同一个值满足不了 4.5:1 × 两套底色：亮底要 L ≤ 0.183，暗底要 L ≥ 0.203，没有交集。
    expect(
      AGENT_HUE_GRAPHIC.some((color) => contrast(color, BUBBLE_LIGHT) < 4.5),
      '图形色板必须仍然有达不到正文 4.5:1 的条目，否则这套拆分已无必要',
    ).toBe(true)
    // 同一个 seed 的三套 token 必须同色相（按名字稳定，且不串台）：同一下标即同族。
    for (const seed of ['CodeBot', '阿码', 'Ryen', 'x', '']) {
      const hues = agentHues(seed)
      expect(hues.graphic, seed).toBe(fallbackColor(seed))
      const i = (AGENT_HUE_GRAPHIC as readonly string[]).indexOf(hues.graphic)
      expect(i, `${seed} 的图形色不在色板里`).toBeGreaterThanOrEqual(0)
      expect(AGENT_HUE_TEXT_LIGHT[i] as string, seed).toBe(hues.textLight)
      expect(AGENT_HUE_TEXT_DARK[i] as string, seed).toBe(hues.textDark)
    }
    expect(agentHues('CodeBot')).toEqual(agentHues('CodeBot'))
    expect(agentHues('A').graphic).not.toBe(agentHues('B').graphic)
  })
})

describe('Avatar 组件', () => {
  it('DiceBear 懒加载：未就绪渲染等尺寸骨架，就绪后替换为 SVG（不产生布局抖动）', async () => {
    vi.resetModules()
    const { Avatar: FreshAvatar } = await import('../renderer/src/components/avatars/Avatar.tsx')
    const mod = await import('../renderer/src/components/avatars/avatars.tsx')

    const skeleton = renderToStaticMarkup(<FreshAvatar avatarKey="db:dylan:s1" name="A" size={40} />)
    expect(skeleton).toContain('avatar-loading')
    expect(skeleton).toContain('aria-busy="true"')
    expect(skeleton).toContain('width:40px;height:40px')
    expect(skeleton).not.toContain('<svg')

    await mod.loadAvatarStyle('dylan')
    const ready = renderToStaticMarkup(<FreshAvatar avatarKey="db:dylan:s1" name="A" size={40} />)
    expect(ready).toContain('<svg')
    expect(ready).toContain('width:40px;height:40px') // 容器尺寸与骨架一致
    expect(ready).not.toContain('avatar-loading')
    expect(ready).not.toContain('avatar-fallback')
  })

  it('avatarKey 三条路径：db:* → DiceBear SVG / cat → 橘猫 / 旧值 → 首字符色块', async () => {
    await loadAvatarStyle('dylan')
    const db = renderToStaticMarkup(<Avatar avatarKey="db:dylan:s1" name="A" size={40} />)
    expect(db).toContain('<svg')
    expect(db).not.toContain('avatar-fallback')
    expect(db).not.toContain('avatar-cat')

    const cat = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={40} />)
    expect(cat).toContain('avatar-cat')
    expect(cat).toContain('<img class="cat cat-circle"')
    expect(cat).not.toContain('avatar-fallback')

    // 旧库值（emoji / 手绘 key / 已收敛的 DiceBear 风格）平滑回退首字符块
    const legacy = renderToStaticMarkup(<Avatar avatarKey="🐈" name="旧数据" size={40} />)
    expect(legacy).toContain('avatar-fallback')
    expect(legacy).toContain('旧')
    expect(renderToStaticMarkup(<Avatar avatarKey="owl" name="旧数据" size={40} />)).toContain('avatar-fallback')
    const legacy2 = renderToStaticMarkup(<Avatar avatarKey="db:lorelei:s1" name="旧数据" size={40} />)
    expect(legacy2).toContain('avatar-fallback')
    // 未给 avatarKey 时也走兜底
    expect(renderToStaticMarkup(<Avatar name="无头像" size={40} />)).toContain('avatar-fallback')
  })
})

describe('群聊九宫格', () => {
  const members = Array.from({ length: 9 }, (_, i) => {
    return { id: `m${i}`, name: `成员${i}`, avatar: `db:dylan:seed${i}` }
  })

  it('微信规则：2 人左右各半，3 人品字，4 人 2×2', () => {
    expect(groupGridAreas(2)).toEqual(['1 / 1 / 2 / 2', '1 / 2 / 2 / 3'])
    expect(groupGridAreas(3)).toEqual(['1 / 1 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'])
    expect(groupGridAreas(4)).toHaveLength(4)
  })

  it('5–9 人 3×3 取前 N 格；>9 截前 9', () => {
    expect(groupGridAreas(5)).toHaveLength(5)
    expect(groupGridAreas(9)).toHaveLength(9)
    expect(groupGridAreas(12)).toHaveLength(9)
  })

  it('渲染拼图：成员 DiceBear 头像全部生效', async () => {
    await loadAvatarStyle('dylan')
    const html = renderToStaticMarkup(<GroupAvatar members={members.slice(0, 5)} size={48} />)
    expect(html).toContain('avatar-group')
    expect((html.match(/<svg/g) ?? []).length).toBe(5)
    expect(html).not.toContain('avatar-fallback')
  })
})
