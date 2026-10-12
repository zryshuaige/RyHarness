// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ICONS, Icon } from '../renderer/src/components/Icon.tsx'

describe('SVG 图标系统', () => {
  it('注册表覆盖全部需求图标（19+）', () => {
    const required = [
      'chat-bubble', 'users', 'cat-face', 'sun', 'moon', 'gear', 'search', 'send',
      'brain', 'plus', 'x', 'chevron-right', 'chevron-left', 'panel-right',
      'copy', 'check', 'file', 'thumbs-up', 'thumbs-down', 'at-sign', 'group',
    ]
    for (const name of required) {
      expect(ICONS[name], name).toBeDefined()
    }
    expect(Object.keys(ICONS).length).toBeGreaterThanOrEqual(21)
  })

  it('统一 stroke 风格：1.8px 线宽、圆角线帽、fill=none、24 viewBox', () => {
    const html = renderToStaticMarkup(<Icon name="send" />)
    expect(html).toContain('viewBox="0 0 24 24"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('stroke-width="1.8"')
    expect(html).toContain('stroke-linecap="round"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('width="18"')
  })

  it('每个图标都能渲染出路径内容，尺寸可覆盖', () => {
    for (const name of Object.keys(ICONS)) {
      const html = renderToStaticMarkup(<Icon name={name as never} size={22} />)
      expect(html.includes('<path') || html.includes('<circle') || html.includes('<rect'), name).toBe(true)
      expect(html).toContain('width="22"')
    }
  })

  it('未知图标名返回 null（不渲染脏内容）', () => {
    expect(renderToStaticMarkup(<Icon name={'nope' as never} />)).toBe('')
  })
})
