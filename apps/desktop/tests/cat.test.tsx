// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Cat } from '../renderer/src/components/Cat.tsx'

describe('Cat 吉祥物三态', () => {
  it('idle：圆眼 + 普通星星', () => {
    const html = renderToStaticMarkup(<Cat mood="idle" size={40} />)
    expect(html).toContain('class="star"')
    expect(html).toContain('<circle class="inkf" cx="24"')
    expect(html).not.toContain('fast')
  })

  it('thinking：星星旋转 + 斜眼', () => {
    const html = renderToStaticMarkup(<Cat mood="thinking" size={40} />)
    expect(html).toContain('class="star fast"')
    expect(html).toContain('cy="30.8"')
  })

  it('happy：星星跳跃 + 弯眼笑嘴', () => {
    const html = renderToStaticMarkup(<Cat mood="happy" size={40} />)
    expect(html).toContain('class="star joy"')
    expect(html).toContain('q3.5 -4.6 7 0')
    expect(html).toContain('fill="#c2503a"')
  })
})
