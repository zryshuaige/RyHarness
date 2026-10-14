// @vitest-environment jsdom
import { act, type ReactNode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEAVE_MS, useLeaving } from '../renderer/src/lib/useLeaving.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let reducedMotion = false
/** 组件询问过的媒体查询，用来确认实现用的是「减少动效」这条查询。 */
let mediaQueries: string[] = []
/** 有用例会主动卸载 root，避免 afterEach 重复 unmount。 */
let unmounted = false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  reducedMotion = false
  mediaQueries = []
  // jsdom 没实现 matchMedia，这里补一个可开关的桩。
  vi.stubGlobal('matchMedia', (query: string) => {
    mediaQueries.push(query)
    return {
      matches: reducedMotion,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }
  })
})

afterEach(() => {
  if (!unmounted) {
    act(() => {
      root.unmount()
    })
    unmounted = false
  }
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** 最小宿主：visible 翻 false 即触发退场。 */
function Box({ visible }: { visible: boolean }) {
  const { shown, leaving, ref } = useLeaving(LEAVE_MS, visible ? '内容' : undefined)
  if (shown === undefined) return null
  return (
    <div ref={ref} className={leaving ? 'box is-leaving' : 'box'}>
      {shown}
    </div>
  )
}

function Controller() {
  const [visible, setVisible] = useState(true)
  return (
    <>
      <button
        type="button"
        id="toggle"
        onClick={() => {
          setVisible(!visible)
        }}
      >
        切换
      </button>
      <Box visible={visible} />
    </>
  )
}

function render(node: ReactNode = <Controller />): void {
  unmounted = false
  act(() => {
    root = createRoot(container)
    root.render(node)
  })
}

function toggle(): void {
  act(() => {
    container.querySelector<HTMLButtonElement>('#toggle')!.click()
  })
}

describe('useLeaving', () => {
  it('内容消失后先挂 .is-leaving，LEAVE_MS 走完才卸载', () => {
    vi.useFakeTimers()
    render()
    expect(container.querySelector('.box')!.textContent).toBe('内容')
    expect(container.querySelector('.box')!.className).toBe('box')

    toggle()
    expect(mediaQueries).toContain(REDUCED_MOTION_QUERY)
    const leaving = container.querySelector('.box')!
    expect(leaving.className).toBe('box is-leaving')
    expect(leaving.textContent).toBe('内容') // 退场期间内容不闪空

    advance(LEAVE_MS - 1)
    expect(container.querySelector('.box')).not.toBeNull()
    advance(1)
    expect(container.querySelector('.box')).toBeNull()
  })

  it('退场途中内容回来会立刻回到进场态，不留残影', () => {
    vi.useFakeTimers()
    render()
    toggle()
    expect(container.querySelector('.box.is-leaving')).not.toBeNull()

    advance(LEAVE_MS - 20)
    toggle()
    expect(container.querySelector('.box')!.className).toBe('box')

    advance(LEAVE_MS * 2) // 旧计时器不能把已经回来的内容带走
    expect(container.querySelector('.box')).not.toBeNull()
  })

  it('animationend 提前结束退场，不必空等满时长', () => {
    vi.useFakeTimers()
    render()
    toggle()
    act(() => {
      container.querySelector('.box')!.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(container.querySelector('.box')).toBeNull()
  })

  it('子元素的 animationend 不算退场结束（只认根节点自身的动画）', () => {
    vi.useFakeTimers()
    render()
    toggle()
    const child = document.createElement('span')
    container.querySelector('.box')!.appendChild(child)
    act(() => {
      child.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    expect(container.querySelector('.box.is-leaving')).not.toBeNull()
  })

  it('prefers-reduced-motion: reduce 时同一帧直接卸载，不播退场', () => {
    reducedMotion = true
    render()
    toggle()
    expect(mediaQueries).toContain(REDUCED_MOTION_QUERY)
    expect(container.querySelector('.box')).toBeNull()
  })

  it('value 变了但没有消失时不重播进场（内容更新不该闪一下）', () => {
    const seen: (string | undefined)[] = []
    function Updater() {
      const [label, setLabel] = useState('一')
      const { shown, leaving } = useLeaving(LEAVE_MS, label)
      seen.push(shown)
      return (
        <button
          type="button"
          id="swap"
          onClick={() => {
            setLabel('二')
          }}
        >
          {shown}
          {leaving ? ' leaving' : ''}
        </button>
      )
    }
    render(<Updater />)
    act(() => {
      container.querySelector<HTMLButtonElement>('#swap')!.click()
    })
    expect(container.querySelector('#swap')!.textContent).toBe('二')
    expect(seen).not.toContain(undefined)
  })

  it('卸载后 pending 的退场计时器被清理，不会打到已销毁的组件上', () => {
    vi.useFakeTimers()
    render()
    toggle()
    expect(container.querySelector('.box.is-leaving')).not.toBeNull()
    act(() => {
      root.unmount()
    })
    unmounted = true
    expect(() => {
      advance(LEAVE_MS * 2)
    }).not.toThrow()
  })

  it('className(base) 助手：进场态是 base，退场态是 base + is-leaving', () => {
    vi.useFakeTimers()
    /** 照搬调用点写法：九个调用点统一走这个助手，不再手写三元表达式。 */
    function Banner({ visible }: { visible: boolean }) {
      const { shown, className, ref } = useLeaving(LEAVE_MS, visible ? '内容' : undefined)
      if (shown === undefined) return null
      return (
        <div ref={ref} className={className('banner')}>
          {shown}
        </div>
      )
    }
    function Harness() {
      const [visible, setVisible] = useState(true)
      return (
        <>
          <button
            type="button"
            id="toggle"
            onClick={() => {
              setVisible(!visible)
            }}
          >
            切换
          </button>
          <Banner visible={visible} />
        </>
      )
    }
    render(<Harness />)
    expect(container.querySelector('.banner')!.className).toBe('banner')
    toggle()
    expect(container.querySelector('.banner')!.className).toBe('banner is-leaving')
    advance(LEAVE_MS)
    expect(container.querySelector('.banner')).toBeNull()
  })
})
