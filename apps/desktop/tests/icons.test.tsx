// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_SIZE_STEPS, ICONS, Icon, quantizeIconSize } from '../renderer/src/components/Icon.tsx'

const ICON_NAMES = Object.keys(ICONS) as (keyof typeof ICONS)[]

describe('Lucide 图标系统', () => {
  it('注册表覆盖全部 24 个需求图标', () => {
    const required = [
      'chat-bubble',
      'users',
      'cat-face',
      'sun',
      'moon',
      'gear',
      'search',
      'send',
      'brain',
      'plus',
      'x',
      'chevron-right',
      'chevron-left',
      'panel-right',
      'copy',
      'check',
      'file',
      'thumbs-up',
      'thumbs-down',
      'at-sign',
      'group',
      'pencil',
      'alert',
      'dices',
      'clipboard-list',
      'mail',
      'calendar-days',
    ]
    for (const name of required) {
      expect(typeof ICONS[name as keyof typeof ICONS], name).toBe('string')
      expect(ICONS[name as keyof typeof ICONS].length, name).toBeGreaterThan(0)
    }
    // 注册表不许留孤儿：每个图标都必须是被断言的需求清单之一。
    expect(Object.keys(ICONS).sort()).toEqual([...required].sort())
  })

  it('统一 stroke 风格：24 viewBox、currentColor、圆角线帽、fill=none、默认尺寸 20', () => {
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />)
      expect(html, name).toContain('viewBox="0 0 24 24"')
      expect(html, name).toContain('stroke="currentColor"')
      expect(html, name).toContain('stroke-linecap="round"')
      expect(html, name).toContain('stroke-linejoin="round"')
      expect(html, name).toContain('fill="none"')
      expect(html, name).toContain('stroke-width="2"') // 默认 2px 线宽
      expect(html, name).toContain('width="20" height="20"') // 默认尺寸 20
      expect(html, name).toContain('<path') // lucide 内容非空
      expect(html, name).toContain('class="icon ') // 外层 span 挂 .icon
    }
  })

  it('strokeWidth 覆盖作用于多路径图标：不留任何旧 stroke-width（replaceAll 回归点）', () => {
    // users 是多路径图标：3 条 path + 1 个 circle；只替换第一个会出现粗细不均。
    const html = renderToStaticMarkup(<Icon name="users" strokeWidth={1.6} />)
    expect((html.match(/<(path|circle)\b/g) ?? []).length).toBe(4)
    const widths = [...html.matchAll(/stroke-width="([^"]+)"/g)].map((m) => {
      return m[1]
    })
    expect(widths.length).toBeGreaterThan(0)
    expect(
      widths.every((w) => {
        return w === '1.6'
      }),
    ).toBe(true)
    expect(html).not.toContain('stroke-width="2"')
    // 同一图标所有绘制元素共享这一个线宽（stroke-width 由根 svg 继承）
    const perDrawable = html.replace(/<svg[^>]*>/, '')
    expect(perDrawable).not.toContain('stroke-width')
  })

  it('每个图标都能渲染出内容，尺寸与线宽可覆盖', () => {
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} size={20} strokeWidth={1.6} />)
      expect(html.includes('<path') || html.includes('<circle') || html.includes('<rect'), name).toBe(true)
      expect(html, name).toContain('width="20" height="20"')
      expect(html, name).not.toContain('stroke-width="2"')
    }
  })

  it('尺寸收敛为 12/16/20/24 四档：15 → 16，13 → 12，18 → 20，22 → 24', () => {
    expect(ICON_SIZE_STEPS).toEqual([12, 16, 20, 24])
    expect(quantizeIconSize(15)).toBe(16)
    expect(quantizeIconSize(11)).toBe(12)
    expect(quantizeIconSize(13)).toBe(12)
    // 等距时进位：14 距 12/16 各 2，取大档
    expect(quantizeIconSize(14)).toBe(16)
    expect(quantizeIconSize(18)).toBe(20)
    expect(quantizeIconSize(22)).toBe(24)
    // 四档本身不变，超大尺寸收敛到上限
    for (const step of ICON_SIZE_STEPS) {
      expect(quantizeIconSize(step), `size=${step}`).toBe(step)
    }
    expect(quantizeIconSize(40)).toBe(24)
    // 渲染层：旧调用点（11/13/15/18/22）拿到的是量化后的尺寸
    expect(renderToStaticMarkup(<Icon name="send" size={15} />)).toContain('width="16" height="16"')
    expect(renderToStaticMarkup(<Icon name="send" size={22} />)).toContain('width="24" height="24"')
    expect(renderToStaticMarkup(<Icon name="send" size={13} />)).toContain('width="12" height="12"')
  })

  it('未知图标名返回 null（不渲染脏内容）', () => {
    expect(renderToStaticMarkup(<Icon name={'nope' as never} />)).toBe('')
  })
})
