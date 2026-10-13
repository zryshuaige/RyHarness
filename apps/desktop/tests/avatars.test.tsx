// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import {
  AVATAR_STYLE_BY_KEY,
  AVATAR_STYLES,
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

  it('randomAvatarSpec 只生成白名单内的风格', () => {
    for (let i = 0; i < 20; i++) {
      const raw = randomAvatarSpec(() => {
        return 'fixedseed'
      })
      const spec = parseAvatarSpec(raw)
      expect(spec, raw).not.toBeNull()
      expect(AVATAR_STYLE_BY_KEY[spec!.styleKey], raw).toBeDefined()
      expect(spec!.seed).toBe('fixedseed')
    }
  })

  it('兜底色稳定', () => {
    expect(fallbackColor('CodeBot')).toBe(fallbackColor('CodeBot'))
    expect(fallbackColor('A')).not.toBe(fallbackColor('B'))
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
    expect(cat).toContain('<svg class="cat"')
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
