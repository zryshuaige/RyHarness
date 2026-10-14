// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastHost } from '../renderer/src/components/ToastHost.tsx'
import { toast } from '../renderer/src/lib/toast.ts'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
/** toast 队列是模块级状态，用例之间必须自己清干净。 */
let ids: number[] = []

function push(kind: 'info' | 'success' | 'error', text: string): void {
  act(() => {
    ids.push(toast[kind](text))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  ids = []
  // jsdom 没实现 matchMedia（退场要查是否要减少动效），补一个桩。
  vi.stubGlobal('matchMedia', (query: string) => {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  })
  act(() => {
    root = createRoot(container)
    root.render(<ToastHost />)
  })
})

afterEach(() => {
  act(() => {
    for (const id of ids) toast.dismiss(id)
  })
  ids = []
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function toasts(): NodeListOf<Element> {
  return container.querySelectorAll('.toast')
}

describe('ToastHost 退场', () => {
  it('新 toast 立即上屏，按类型着色', () => {
    push('info', '已复制')
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.className).toBe('toast toast-info')
    expect(toasts()[0]!.textContent).toContain('已复制')
  })

  it('手动关闭：先播 .is-leaving，LEAVE_MS 后才卸载', () => {
    vi.useFakeTimers()
    push('success', '已记下这条经验')
    act(() => {
      container.querySelector<HTMLButtonElement>('.toast-close')!.click()
    })
    expect(container.querySelector('.toast.is-leaving')!.textContent).toContain('已记下这条经验')

    advance(LEAVE_MS - 1)
    expect(toasts()).toHaveLength(1)
    advance(1)
    expect(toasts()).toHaveLength(0)
    expect(container.querySelector('.toast-host')).toBeNull()
  })

  it('自动消失（duration 到期）同样走退场，而不是瞬间消失', () => {
    vi.useFakeTimers()
    push('error', '反馈没送出去')
    advance(5200)
    expect(container.querySelector('.toast.is-leaving')).not.toBeNull()
    advance(LEAVE_MS)
    expect(toasts()).toHaveLength(0)
  })

  it('animationend 让退场提前结束（CSS 跑完就不再等计时器）', () => {
    vi.useFakeTimers()
    push('info', '已停止生成')
    act(() => {
      toast.dismiss(ids[0]!)
    })
    act(() => {
      container.querySelector('.toast')!.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(toasts()).toHaveLength(0)
  })

  it('多条 toast 各自退场，互不牵连', () => {
    vi.useFakeTimers()
    push('info', '第一条')
    push('error', '第二条')
    expect(toasts()).toHaveLength(2)

    act(() => {
      toast.dismiss(ids[0]!)
    })
    advance(LEAVE_MS)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.textContent).toContain('第二条')
    expect(container.querySelector('.toast.is-leaving')).toBeNull()
  })
})
