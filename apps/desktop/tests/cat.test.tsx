// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Cat } from '../renderer/src/components/Cat.tsx'

/**
 * Cat.tsx 是极简几何橘猫：琥珀渐变底板 + 圆头三角耳 + 极简五官，
 * 三态只换五官与星光，不换轮廓（母版在 apps/desktop/assets/brand/cat-face*.svg）。
 */
describe('Cat 品牌橘猫（统一几何母版）', () => {
  it('骨架：svg.cat + 64 网格 + 琥珀渐变底板，mood 只进 aria-label 与五官组 id', () => {
    const html = renderToStaticMarkup(<Cat mood="idle" size={40} />)
    expect(html).toContain('<svg class="cat"')
    expect(html).toContain('viewBox="0 0 64 64"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Ryen idle"')
    expect(html).toContain('stop-color="#FBBF24"') // 琥珀渐变起点
    expect(html).toContain('stop-color="#D97706"') // 琥珀渐变终点
    // 三态共用同一套轮廓：脸底板 + 两只耳朵
    expect(html).toContain('<circle cx="32" cy="35.5" r="15.2" fill="#FFFDF8"/>')
    expect(html).toContain('d="M24 26.4 L17 10.4 L34 22 Z"')
    expect(html).toContain('d="M40 26.4 L47 9 L30 21.8 Z"')
  })

  it('idle：圆眼 + 三角鼻 + 微笑弧线，不带星光', () => {
    const html = renderToStaticMarkup(<Cat mood="idle" size={40} />)
    expect(html).toContain('id="ryen-cat-idle"')
    expect(html).toContain('aria-label="Ryen idle"')
    // 两只实心圆眼（class="inkf"）
    expect(html).toContain('<circle class="inkf" cx="26.7" cy="35.2" r="2.25"')
    expect(html).toContain('<circle class="inkf" cx="37.3" cy="35.2" r="2.25"')
    // 三角鼻 + 描边笑嘴
    expect(html).toContain('<path class="inkf" d="M29.9 39.8 L32 42.9 L34.1 39.8 Z"')
    expect(html).toContain('<path class="ink" d="M27.1 43.9 q4.9 4.4 9.8 0"')
    expect(html).not.toContain('class="star') // 静止态没有星光
  })

  it('thinking：眼睛上移成斜视 + 快速旋转星光', () => {
    const html = renderToStaticMarkup(<Cat mood="thinking" size={40} />)
    expect(html).toContain('id="ryen-cat-thinking"')
    expect(html).toContain('aria-label="Ryen thinking"')
    // 眼球中心比 idle 高 1.6（cy 35.2 → 33.6）＝斜眼
    expect(html).toContain('<circle class="inkf" cx="27.2" cy="33.6" r="2.25"')
    expect(html).toContain('<circle class="inkf" cx="36.8" cy="33.6" r="2.25"')
    expect(html).toContain('<path class="ink" d="M27.1 43.2 q4.9 4.4 9.8 0"')
    expect(html).toContain('class="star fast"')
  })

  it('happy：弯眼 + 弯月笑嘴 + 跳跃星光（不再是圆眼）', () => {
    const html = renderToStaticMarkup(<Cat mood="happy" size={40} />)
    expect(html).toContain('id="ryen-cat-happy"')
    expect(html).toContain('aria-label="Ryen happy"')
    // 眼睛换成描边弧线（q 曲线），idle/thinking 的实心圆眼必须消失
    expect(html).toContain('<path class="ink" d="M24.3 36 q2.4 -3.8 4.8 0"')
    expect(html).toContain('<path class="ink" d="M34.9 36 q2.4 -3.8 4.8 0"')
    expect(html).not.toContain('<circle class="inkf"')
    // 嘴换成实心弯月
    expect(html).toContain('<path class="inkf" d="M27.1 43.4 a4.9 4.9 0 0 0 9.8 0 z"')
    expect(html).toContain('class="star joy"')
  })

  it('三态在 DOM 上互不相同：眼、嘴、星光三处特征各自独立', () => {
    const idle = renderToStaticMarkup(<Cat mood="idle" size={40} />)
    const thinking = renderToStaticMarkup(<Cat mood="thinking" size={40} />)
    const happy = renderToStaticMarkup(<Cat mood="happy" size={40} />)
    expect(new Set([idle, thinking, happy]).size).toBe(3)
    // 眼神：idle 圆眼 vs thinking 上移圆眼 vs happy 弧线眼
    expect(idle).toContain('cy="35.2"')
    expect(thinking).toContain('cy="33.6"')
    expect(thinking).not.toContain('cy="35.2"')
    expect(happy).not.toContain('cy="33.6"')
    // 嘴：三者路径各不相同
    const mouth = (html: string): string => {
      return /<path class="ink[f]?" d="M2[0-9.]* [0-9.]+ [a-z]/.exec(html)?.[0] ?? ''
    }
    expect(new Set([mouth(idle), mouth(thinking), mouth(happy)]).size).toBe(3)
    // 星光：idle 无、thinking 旋转、happy 跳跃，三者不共用 class
    expect(idle).not.toContain('class="star')
    expect(thinking).toContain('class="star fast"')
    expect(thinking).not.toContain('class="star joy"')
    expect(happy).toContain('class="star joy"')
    expect(happy).not.toContain('class="star fast"')
  })

  it('shape：默认 squircle 应用图标底板，shape="circle" 供头像圆形裁切', () => {
    const squircle = renderToStaticMarkup(<Cat mood="idle" size={40} />)
    expect(squircle).toContain('d="M32 2 C46.375 2 62 10.75 62 32')
    expect(squircle).not.toContain('A30.5 30.5')
    const circle = renderToStaticMarkup(<Cat mood="idle" size={40} shape="circle" />)
    expect(circle).toContain('d="M32 1.5 A30.5 30.5 0 1 1 32 62 A30.5 30.5 0 1 1 32 1.5 Z"')
    expect(circle).not.toContain('C46.375')
  })

  it('size 透传到 svg 宽高', () => {
    expect(renderToStaticMarkup(<Cat mood="idle" size={64} />)).toContain('width="64" height="64"')
    expect(renderToStaticMarkup(<Cat mood="idle" size={22} />)).toContain('width="22" height="22"')
  })

  it('多只猫同屏时渐变 id 不重名（否则后渲染的会引用到别人的 defs）', () => {
    const html = renderToStaticMarkup(
      <div>
        <Cat mood="idle" size={24} />
        <Cat mood="happy" size={24} />
      </div>,
    )
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => {
      return m[1]
    })
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      expect(html).toContain(`<path fill="url(#${id})"`)
    }
  })
})
