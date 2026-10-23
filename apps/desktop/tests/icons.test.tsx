// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_SIZE_STEPS, ICON_STROKE_WIDTH, ICONS, Icon, quantizeIconSize } from '../renderer/src/components/Icon.tsx'

const ICON_NAMES = Object.keys(ICONS) as (keyof typeof ICONS)[]

describe('Lucide 图标系统', () => {
  it('注册表覆盖全部需求图标，且不留孤儿', () => {
    const required = [
      'chat-bubble',
      'users',
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
      // 界面 chrome 此前用字符冒充图标（⋯ / ↑ / ↗ / ★），这四个是它们的图形版
      'ellipsis',
      'arrow-up',
      'arrow-up-right',
      'crown',
      // 「我的」页签：用户自己的页面，不是 Ryen
      'user',
      // 气泡朗读：开始 / 停止。volume-2 是喇叭加声波（发声），speaker 是硬件音箱的图形
      // （语音插件用它——那是一台音箱，不是一次发声）。
      'volume-2',
      'speaker',
      'square',
      // 独立「插件」页签：拼装块，语义是「能力由这些块组合而成」
      'blocks',
      // 独立「RyVibe」页签：闪，语义是「一句话生成点什么」
      'sparkles',
    ]
    for (const name of required) {
      expect(typeof ICONS[name as keyof typeof ICONS], name).toBe('string')
      expect(ICONS[name as keyof typeof ICONS].length, name).toBeGreaterThan(0)
    }
    // 注册表不许留孤儿：每个图标都必须是被断言的需求清单之一。
    expect(Object.keys(ICONS).sort()).toEqual([...required].sort())
    // 反向护栏：品牌猫由 Cat.tsx 的位图母版独占，图标库里再出现第三只猫就是回归。
    expect(Object.keys(ICONS)).not.toContain('cat-face')
  })

  it('统一 stroke 风格：24 viewBox、currentColor、圆角线帽、fill=none、默认尺寸 20', () => {
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />)
      expect(html, name).toContain('viewBox="0 0 24 24"')
      expect(html, name).toContain('stroke="currentColor"')
      expect(html, name).toContain('stroke-linecap="round"')
      expect(html, name).toContain('stroke-linejoin="round"')
      expect(html, name).toContain('fill="none"')
      expect(html, name).toContain(`stroke-width="${ICON_STROKE_WIDTH}"`) // 全站唯一线宽
      expect(html, name).toContain('width="20" height="20"') // 默认尺寸 20
      // 内容非空：lucide 里既有 path 也有 circle（ellipsis 是三个圆点）
      expect(html.includes('<path') || html.includes('<circle') || html.includes('<rect'), name).toBe(true)
      expect(html, name).toContain('class="icon ') // 外层 span 挂 .icon
    }
  })

  it('线宽全站只有一个值：注册表里不留任何 stroke-width，渲染结果也只有一处', () => {
    expect(ICON_STROKE_WIDTH).toBe(2)
    for (const name of ICON_NAMES) {
      // 注册表带线宽就等于出现第二个真源（还跟着 lucide 上游版本走）。
      expect(ICONS[name], name).not.toContain('stroke-width')
      const html = renderToStaticMarkup(<Icon name={name} size={16} />)
      const widths = [...html.matchAll(/stroke-width="([^"]+)"/g)].map((m) => {
        return m[1]
      })
      expect(widths, name).toEqual([String(ICON_STROKE_WIDTH)])
      // users 是多路径图标（3 条 path + 1 个 circle）：线宽只写在根 svg 上，其余全继承。
      if (name === 'users') expect((html.match(/<(path|circle)\b/g) ?? []).length).toBe(4)
      expect(html.replace(/<svg[^>]*>/, ''), name).not.toContain('stroke-width')
    }
  })

  it('每个图标都能渲染出内容，尺寸按网格收敛', () => {
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} size={24} />)
      expect(html.includes('<path') || html.includes('<circle') || html.includes('<rect'), name).toBe(true)
      expect(html, name).toContain('width="24" height="24"')
    }
  })

  it('尺寸收敛为 16/20/24 三档，且没有比 16 更小的档', () => {
    expect(ICON_SIZE_STEPS).toEqual([16, 20, 24])
    expect(quantizeIconSize(16)).toBe(16)
    expect(quantizeIconSize(20)).toBe(20)
    expect(quantizeIconSize(24)).toBe(24)
    // 等距时进位：17 距 16/20 各 3… 18 距 16/20 各 2，取大档
    expect(quantizeIconSize(18)).toBe(20)
    expect(quantizeIconSize(22)).toBe(24)
    // 旧调用点（11/12/13/14/15/22/40）全部被吸到网格上，没有一档掉到 16 以下
    expect(quantizeIconSize(11)).toBe(16)
    expect(quantizeIconSize(12)).toBe(16)
    expect(quantizeIconSize(13)).toBe(16)
    expect(quantizeIconSize(14)).toBe(16)
    expect(quantizeIconSize(15)).toBe(16)
    for (const step of ICON_SIZE_STEPS) {
      expect(quantizeIconSize(step), `size=${step}`).toBe(step)
    }
    expect(quantizeIconSize(40)).toBe(24)
    // 渲染层：旧调用点（11/13/15/18/22）拿到的是量化后的尺寸
    expect(renderToStaticMarkup(<Icon name="send" size={15} />)).toContain('width="16" height="16"')
    expect(renderToStaticMarkup(<Icon name="send" size={22} />)).toContain('width="24" height="24"')
    expect(renderToStaticMarkup(<Icon name="send" size={13} />)).toContain('width="16" height="16"')
  })

  it('未知图标名返回 null（不渲染脏内容）', () => {
    expect(renderToStaticMarkup(<Icon name={'nope' as never} />)).toBe('')
  })
})
