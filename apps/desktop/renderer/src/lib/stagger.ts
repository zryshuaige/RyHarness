import type { CSSProperties } from 'react'

/**
 * 行内 CSS 自定义属性：样式表里按元素下标计算的进场 stagger（`--i`）必须由组件
 * 按下标传入，而 csstype 的 CSSProperties 没有 `--*` 索引签名，直接写会报未知属性。
 */
export type StyleVars = CSSProperties & Record<`--${string}`, string | number | undefined>

/** 列表第 index 项的 stagger 变量，配 styles.css 的 `animation-delay: calc(var(--i) * 30ms)`。 */
export function stagger(index: number): StyleVars {
  return { '--i': index }
}
