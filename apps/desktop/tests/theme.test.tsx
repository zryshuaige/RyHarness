// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyTheme } from '../renderer/src/App.tsx'

describe('主题切换', () => {
  it('applyTheme 写 documentElement 的 data-theme', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('主题切换的补间：走 View Transition 的 root 交叉淡化', () => {
  /**
   * 此前切主题是 0ms 硬切：App.tsx 给 body 挂 .theme-animating，而那张样式表
   * 的规则是 `transition: none !important`——过渡是被**禁掉**的。
   *
   * 顾虑本身是对的（整屏颜色差值逐元素补间会成彩虹），但解法用错了：View Transition
   * 走的是**快照**交叉淡化（图像叠化），不对任何元素做颜色补间，于是「不彩虹」
   * 与「有补间」可以同时成立。
   */
  it('切主题不再挂 theme-animating（那条规则本来就是把过渡关掉的）', () => {
    expect(document.body.className).not.toContain('theme-animating')
  })

  it('view-transition 的 helper 在 API 缺席时同步执行（结果一致，只是没有补间）', async () => {
    const { withViewTransition } = await import('../renderer/src/lib/view-transition.ts')
    // jsdom 没有 startViewTransition：调用不应抛错，且更新必须已经生效。
    let ran = false
    withViewTransition(() => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})
