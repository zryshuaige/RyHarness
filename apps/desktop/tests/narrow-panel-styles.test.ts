/**
 * 窄窗右栏的样式约定（读文件，所以跑在 node 环境，与渲染测试分开）。
 *
 * 此前样式表里那条 `@media (max-width: 1199px) { .right-panel { display: none } }`
 * 把整块信息板藏了：记忆、手册、待办、调度轨迹在这个宽度下**一个入口都没有**。
 * 现在改走覆盖式抽屉——面板保留在 DOM 里，关着时滑出屏幕右侧。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../renderer/src/', import.meta.url)
const css = readFileSync(new URL('styles.css', SRC), 'utf8')

describe('窄窗的右栏', () => {
  it('不再整块 display:none', () => {
    expect(css).not.toMatch(/\.right-panel \{ display: none; \}/)
  })

  it('是覆盖式抽屉：位移进出场，可见性跟着走', () => {
    const start = css.indexOf('@media (max-width: 1199px)')
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf('@media (max-width: 1040px)'))
    expect(block).toContain('.right-panel.is-overlay-open')
    expect(block).toContain('transform: translateX(100%)')
    expect(block).toContain('position: absolute')
  })

  it('抽屉从标题栏之下开始（不盖住窗口按钮）', () => {
    const start = css.indexOf('@media (max-width: 1199px)')
    const block = css.slice(start, css.indexOf('@media (max-width: 1040px)'))
    expect(block).toContain('top: var(--titlebar-h)')
  })

  it('遮罩与抽屉按钮都有样式', () => {
    expect(css).toContain('.panel-scrim')
    expect(css).toContain('.panel-drawer-btn')
  })
})
