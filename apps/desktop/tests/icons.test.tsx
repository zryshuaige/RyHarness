// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ICONS, Icon } from '../renderer/src/components/Icon.tsx'

describe('Lucide 图标系统', () => {
  it('注册表覆盖全部 23 个需求图标', () => {
    const required = [
      'chat-bubble', 'users', 'cat-face', 'sun', 'moon', 'gear', 'search', 'send',
      'brain', 'plus', 'x', 'chevron-right', 'chevron-left', 'panel-right',
      'copy', 'check', 'file', 'thumbs-up', 'thumbs-down', 'at-sign', 'group',
      'pencil', 'alert',
    ]
    for (const name of required) {
      expect(typeof ICONS[name as keyof typeof ICONS], name).toBe('string')
    }
    expect(Object.keys(ICONS).length).toBeGreaterThanOrEqual(23)
  })

  it('统一 stroke 风格：24 viewBox、currentColor、圆角线帽、fill=none', () => {
    const html = renderToStaticMarkup(<Icon name="send" />)
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('width="18"')
    expect(html).toContain('<path') // lucide 内容非空
  })

  it('每个图标都能渲染出内容，尺寸与线宽可覆盖', () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const html = renderToStaticMarkup(<Icon name={name} size={22} strokeWidth={1.6} />)
      expect(html.includes('<path') || html.includes('<circle') || html.includes('<rect'), name).toBe(true)
      expect(html).toContain('width="22"')
    }
    expect(renderToStaticMarkup(<Icon name="send" strokeWidth={1.6} />)).toContain('stroke-width="1.6"')
  })

  it('未知图标名返回 null（不渲染脏内容）', () => {
    expect(renderToStaticMarkup(<Icon name={'nope' as never} />)).toBe('')
  })
})
