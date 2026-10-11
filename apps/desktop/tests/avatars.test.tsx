// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AVATARS, AVATAR_BY_KEY, fallbackColor } from '../renderer/src/components/avatars/avatars.tsx'
import { Avatar } from '../renderer/src/components/avatars/Avatar.tsx'
import { GroupAvatar, groupGridAreas } from '../renderer/src/components/avatars/GroupAvatar.tsx'

describe('头像注册表', () => {
  it('至少 12 个预置头像，key 唯一，均为圆形底 SVG', () => {
    expect(AVATARS.length).toBeGreaterThanOrEqual(12)
    const keys = AVATARS.map((a) => { return a.key })
    expect(new Set(keys).size).toBe(keys.length)
    for (const avatar of AVATARS) {
      expect(avatar.svg).toContain('<circle cx="32" cy="32"')
      expect(avatar.bg).toMatch(/^#/)
      expect(AVATAR_BY_KEY[avatar.key]).toBe(avatar)
    }
    // 用户要求的种类齐全
    for (const key of ['cat', 'corgi', 'fox', 'panda', 'rabbit', 'owl', 'penguin', 'hamster', 'koala', 'bot', 'dragon', 'deer', 'whale']) {
      expect(AVATAR_BY_KEY[key]).toBeDefined()
    }
  })

  it('Avatar 组件按 key 渲染 SVG；cat 走 Cat 组件', () => {
    const fox = renderToStaticMarkup(<Avatar avatarKey="fox" name="小狐" size={40} />)
    expect(fox).toContain('<svg')
    expect(fox).toContain('小狐（狐狸）')
    const cat = renderToStaticMarkup(<Avatar avatarKey="cat" name="Ryen" size={40} />)
    expect(cat).toContain('class="cat"')
  })

  it('未知 key 回退首字符暖色块，颜色稳定', () => {
    const html = renderToStaticMarkup(<Avatar avatarKey="nope" name="CodeBot" size={40} />)
    expect(html).toContain('avatar-fallback')
    expect(html).toContain('C')
    expect(fallbackColor('CodeBot')).toBe(fallbackColor('CodeBot'))
    expect(fallbackColor('A')).not.toBe(fallbackColor('B'))
  })
})

describe('群聊九宫格', () => {
  const members = Array.from({ length: 9 }, (_, i) => {
    return { id: `m${i}`, name: `成员${i}`, avatarKey: 'fox' }
  })

  it('微信规则：2 人左右各半，3 人品字，4 人 2×2', () => {
    expect(groupGridAreas(2)).toEqual(['1 / 1 / 2 / 2', '1 / 2 / 2 / 3'])
    expect(groupGridAreas(3)).toEqual(['1 / 1 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'])
    expect(groupGridAreas(4)).toHaveLength(4)
    expect(groupGridAreas(4)[0]).toBe('1 / 1 / 2 / 2')
  })

  it('5–9 人 3×3 取前 N 格；>9 截前 9', () => {
    expect(groupGridAreas(5)).toHaveLength(5)
    expect(groupGridAreas(9)).toHaveLength(9)
    expect(groupGridAreas(12)).toHaveLength(9)
    expect(groupGridAreas(5)[0]).toBe('1 / 1 / 2 / 2')
    expect(groupGridAreas(5)[4]).toBe('1 / 3 / 2 / 4')
  })

  it('渲染拼图：圆形外框 + 成员格数正确', () => {
    const html = renderToStaticMarkup(<GroupAvatar members={members.slice(0, 5)} size={48} />)
    expect(html).toContain('avatar-group')
    // 5 个成员格
    expect(html.match(/grid-area/g) ?? []).toHaveLength(5)
    const nine = renderToStaticMarkup(<GroupAvatar members={members} size={48} />)
    expect(nine.match(/grid-area/g) ?? []).toHaveLength(9)
  })
})
