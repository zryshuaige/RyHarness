// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AVATAR_STYLES, AVATAR_STYLE_BY_KEY, dicebearSvg, fallbackColor, parseAvatarSpec, randomAvatarSpec,
} from '../renderer/src/components/avatars/avatars.tsx'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import { GroupAvatar, groupGridAreas } from '../renderer/src/components/avatars/GroupAvatar.tsx'

describe('DiceBear 头像体系', () => {
  it('6 个预置风格，license 已核实（CC0 / CC BY 4.0）', () => {
    expect(AVATAR_STYLES.length).toBe(6)
    const licenses = AVATAR_STYLES.map((s) => { return s.license })
    expect(licenses.filter((l) => { return l === 'CC0-1.0' }).length).toBe(3)
    expect(licenses.filter((l) => { return l === 'CC-BY-4.0' }).length).toBe(3)
    for (const style of AVATAR_STYLES) {
      expect(AVATAR_STYLE_BY_KEY[style.key]).toBe(style)
    }
  })

  it('dicebearSvg 本地生成 SVG 内容（无网络）', () => {
    const svg = dicebearSvg('lorelei', 'test-seed')
    expect(svg).toContain('<svg')
    expect(svg).toContain('http://www.w3.org/2000/svg')
    expect(svg).toContain('width="100%"') // 宽高 100% 由容器控制
    expect(dicebearSvg('nope', 'x')).toBeNull()
  })

  it('avatar 字段编码解析：db:{style}:{seed}', () => {
    expect(parseAvatarSpec('db:lorelei:abc123')).toEqual({ styleKey: 'lorelei', seed: 'abc123' })
    expect(parseAvatarSpec('db:unknown:x')).toBeNull()
    expect(parseAvatarSpec('cat')).toBeNull()
    expect(parseAvatarSpec(undefined)).toBeNull()
  })

  it('randomAvatarSpec 生成合法编码', () => {
    for (let i = 0; i < 20; i++) {
      const spec = parseAvatarSpec(randomAvatarSpec(() => { return 'fixedseed' }))
      expect(spec).not.toBeNull()
      expect(AVATAR_STYLE_BY_KEY[spec!.styleKey]).toBeDefined()
    }
  })

  it('Avatar 组件：DiceBear / 橘猫 / 兜底三种路径', () => {
    const db = renderToStaticMarkup(<Avatar avatarKey="db:notionists:s1" name="A" size={40} />)
    expect(db).toContain('<svg')
    expect(db).not.toContain('avatar-fallback')
    const cat = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={40} />)
    expect(cat).toContain('avatar-cat')
    // 旧库值（手绘 key / emoji）平滑回退首字符块
    const legacy = renderToStaticMarkup(<Avatar avatarKey="🐈" name="旧数据" size={40} />)
    expect(legacy).toContain('avatar-fallback')
    const legacy2 = renderToStaticMarkup(<Avatar avatarKey="owl" name="旧数据" size={40} />)
    expect(legacy2).toContain('avatar-fallback')
  })

  it('兜底色稳定', () => {
    expect(fallbackColor('CodeBot')).toBe(fallbackColor('CodeBot'))
    expect(fallbackColor('A')).not.toBe(fallbackColor('B'))
  })
})

describe('群聊九宫格', () => {
  const members = Array.from({ length: 9 }, (_, i) => {
    return { id: `m${i}`, name: `成员${i}`, avatar: `db:lorelei:seed${i}` }
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

  it('渲染拼图：成员 DiceBear 头像全部生效', () => {
    const html = renderToStaticMarkup(<GroupAvatar members={members.slice(0, 5)} size={48} />)
    expect(html).toContain('avatar-group')
    expect((html.match(/<svg/g) ?? []).length).toBe(5)
  })
})
