// @vitest-environment jsdom

/**
 * 长列表窗口化：几千条会话 / 几千条消息不能一次性进 DOM。
 *
 * 这里验的是两件事：纯函数算出的区间（含硬上界与哨兵高度），以及 hook 真的把
 * 渲染量压到「可视区 + 余量」，而不是只在纸面上省。
 */
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERSCAN,
  FALLBACK_VIEWPORT_ROWS,
  MAX_RENDERED_ROWS,
  useVisibleWindow,
  visibleRange,
  windowSlice,
} from '../renderer/src/lib/windowed.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW_H = 64

describe('visibleRange', () => {
  it('只框住可视区 + 上下余量', () => {
    const range = visibleRange({ count: 3000, estimateHeight: ROW_H, scrollTop: 0, viewportHeight: ROW_H * 10 })
    expect(range.start).toBe(0)
    // 可视 10 行 + 上下各 6 行余量，再加当前行本身。
    expect(range.end).toBe(10 + DEFAULT_OVERSCAN * 2 + 1)
  })

  it('滚到中段时窗口跟着走，且不越界', () => {
    const middle = visibleRange({
      count: 3000,
      estimateHeight: ROW_H,
      scrollTop: ROW_H * 1000,
      viewportHeight: ROW_H * 10,
    })
    expect(middle.start).toBe(1000 - DEFAULT_OVERSCAN)
    expect(middle.end).toBeLessThanOrEqual(3000)

    const bottom = visibleRange({ count: 3000, estimateHeight: ROW_H, scrollTop: ROW_H * 2999, viewportHeight: 640 })
    expect(bottom.end).toBe(3000)
  })

  it('超宽屏 + 极矮行时仍有硬上界（窗口化在极端屏上不是摆设）', () => {
    const range = visibleRange({
      count: 5000,
      estimateHeight: 8,
      scrollTop: 0,
      viewportHeight: 4000,
      overscan: 20,
    })
    expect(range.end - range.start).toBe(MAX_RENDERED_ROWS)
  })

  it('空列表与滚动位置超出内容都不给出空区间', () => {
    expect(visibleRange({ count: 0, estimateHeight: ROW_H, scrollTop: 0, viewportHeight: 640 })).toEqual({
      start: 0,
      end: 0,
    })
    const overscrolled = visibleRange({ count: 10, estimateHeight: ROW_H, scrollTop: 999_999, viewportHeight: 640 })
    expect(overscrolled.end).toBe(10)
    expect(overscrolled.end).toBeGreaterThan(overscrolled.start)
  })
})

describe('windowSlice', () => {
  const items = Array.from({ length: 3000 }, (_, i) => `会话 ${i}`)

  it('渲染项 + 上下哨兵高度，哨兵之和等于被裁掉的内容高度', () => {
    const range = visibleRange({
      count: items.length,
      estimateHeight: ROW_H,
      scrollTop: ROW_H * 500,
      viewportHeight: 640,
    })
    const sliced = windowSlice(items, range, ROW_H)
    expect(sliced.visible[0]).toBe(`会话 ${range.start}`)
    expect(sliced.padTop).toBe(range.start * ROW_H)
    expect(sliced.padBottom).toBe((items.length - range.end) * ROW_H)
    expect(sliced.padTop + sliced.padBottom + sliced.visible.length * ROW_H).toBe(items.length * ROW_H)
  })

  it('区间越界时夹回数组范围，不抛也不给幽灵项', () => {
    const sliced = windowSlice(items, { start: 2990, end: 9999 }, ROW_H)
    expect(sliced.visible).toHaveLength(10)
    expect(sliced.padBottom).toBe(0)
  })
})

describe('useVisibleWindow', () => {
  let mounted: HTMLDivElement | undefined

  afterEach(() => {
    mounted?.remove()
    mounted = undefined
  })

  /** 渲染一个 3000 行的列表（每行就是一个 div）。 */
  function renderList(count: number, scrollRef: ReturnType<typeof createRef<HTMLDivElement | null>>) {
    const container = document.createElement('div')
    document.body.append(container)
    mounted = container
    const root = createRoot(container)
    const items = Array.from({ length: count }, (_, index) => `会话 ${index}`)
    function List() {
      const range = useVisibleWindow({ count, estimateHeight: ROW_H, scrollRef })
      const sliced = windowSlice(items, range, ROW_H)
      return (
        <div ref={scrollRef} data-testid="scroller" style={{ height: 640 }}>
          <div style={{ height: sliced.padTop }} data-testid="pad-top" />
          {sliced.visible.map((label) => {
            return (
              <div key={label} className="row">
                {label}
              </div>
            )
          })}
          <div style={{ height: sliced.padBottom }} data-testid="pad-bottom" />
        </div>
      )
    }
    act(() => {
      root.render(<List />)
    })
    return {
      root,
      container,
      scroller: container.querySelector('[data-testid="scroller"]') as HTMLDivElement,
    }
  }

  /** 哨兵高度（px）：测试里只关心它是不是 0 / 是不是撑起了被裁掉的内容。 */
  function padHeight(container: HTMLElement, testId: 'pad-top' | 'pad-bottom'): number {
    const node = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
    return Number(node.style.height.replace('px', ''))
  }

  it('3000 行只渲染可视区那一段，上下哨兵撑住滚动几何', () => {
    const scrollRef = createRef<HTMLDivElement | null>()
    const { root, container } = renderList(3000, scrollRef)
    const rows = container.querySelectorAll('.row')
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDERED_ROWS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(3000)
    // 首帧量不到 clientHeight（jsdom），按兜底行数渲染，且上面不留哨兵。
    expect(padHeight(container, 'pad-top')).toBe(0)
    act(() => {
      root.unmount()
    })
  })

  it('滚到底部后窗口换成末尾那一段（下哨兵归零）', async () => {
    const scrollRef = createRef<HTMLDivElement | null>()
    const { root, container, scroller } = renderList(3000, scrollRef)
    // jsdom 没有布局，手动给出可视高度与滚动位置。
    Object.defineProperty(scroller, 'clientHeight', { value: 640, configurable: true })
    scroller.scrollTop = ROW_H * 2990
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => {
        setTimeout(resolve, 40)
      })
    })
    const rows = [...container.querySelectorAll('.row')].map((node) => node.textContent)
    expect(rows.length).toBeLessThanOrEqual(MAX_RENDERED_ROWS)
    expect(rows[0]).not.toBe('会话 0')
    expect(padHeight(container, 'pad-bottom')).toBe(0)
    act(() => {
      root.unmount()
    })
  })

  it('量不到可视高度时先渲染兜底行数，列表不会空一帧', () => {
    const scrollRef = createRef<HTMLDivElement | null>()
    const { root, container } = renderList(3000, scrollRef)
    const rows = container.querySelectorAll('.row')
    expect(rows.length).toBeGreaterThanOrEqual(FALLBACK_VIEWPORT_ROWS)
    act(() => {
      root.unmount()
    })
  })
})
