/**
 * 窄窗右栏的样式约定（读文件，所以跑在 node 环境，与渲染测试分开）。
 *
 * 此前样式表里那条 `@media (max-width: 1199px) { .right-panel { display: none } }`
 * 把整块信息板藏了：记忆、手册、待办、调度轨迹在这个宽度下**一个入口都没有**。
 * 现在改走覆盖式抽屉——面板保留在 DOM 里，关着时滑出屏幕右侧。
 *
 * **且必须排在基础规则之后**：窄窗规则与基础规则同优先级（0,1,0），靠源码顺序取胜。
 * 写在前面就等于没写——面板一边挂着覆盖态的类名、一边按常驻栏参与布局：占着
 * 280px 却不显示（右边空一条），聊天区被挤到只剩 476px。真机 1108px 宽的窗口上
 * 量出来就是这样。下面的用例把「顺序」也钉住，免得它再滑回去。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../renderer/src/', import.meta.url)
const css = readFileSync(new URL('styles.css', SRC), 'utf8')

/** 含某个标记的那段 @media 块（从最近的一个 @media 起到下一个 @media 止）。 */
function blockOf(marker: string): string {
  const at = css.indexOf(marker)
  if (at < 0) return ''
  const start = css.lastIndexOf('@media', at)
  const end = css.indexOf('@media', at)
  return css.slice(start, end < 0 ? css.length : end)
}

describe('窄窗的右栏', () => {
  it('不再整块 display:none', () => {
    expect(css).not.toMatch(/\.right-panel \{ display: none; \}/)
  })

  it('是覆盖式抽屉：位移进出场，可见性跟着走', () => {
    const block = blockOf('.right-panel.is-overlay-open')
    expect(block).toContain('.right-panel.is-overlay-open')
    expect(block).toContain('transform: translateX(100%)')
    expect(block).toContain('position: absolute')
  })

  it('抽屉从标题栏之下开始（不盖住窗口按钮）', () => {
    expect(blockOf('.right-panel.is-overlay-open')).toContain('top: var(--titlebar-h)')
  })

  it('窄窗规则排在基础规则之后：同优先级靠源码顺序取胜，写在前面就等于没写', () => {
    const base = css.indexOf('.right-panel {')
    const overlay = css.indexOf('.right-panel.is-overlay-open')
    expect(base, '基础规则').toBeGreaterThan(-1)
    expect(overlay, '窄窗的抽屉规则').toBeGreaterThan(-1)
    // 基础规则先、窄窗规则后 → 窄窗时覆盖态赢。
    expect(overlay, '窄窗规则必须排在基础规则之后').toBeGreaterThan(base)
  })

  it('遮罩与抽屉按钮都有样式', () => {
    expect(css).toContain('.panel-scrim')
    expect(css).toContain('.panel-drawer-btn')
  })
})
