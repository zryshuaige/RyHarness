// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../renderer/src/components/Modal.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 与 Modal.tsx 的 LEAVE_MS / styles.css 的 --dur-leave 必须一致。 */
const LEAVE_MS = 150
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let reducedMotion = false
/** Modal 询问过的媒体查询，用来验证实现用的是「减少动效」这条查询。 */
let mediaQueries: string[] = []

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
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        id="trigger"
        onClick={() => {
          setOpen(true)
        }}
      >
        打开
      </button>
      <button type="button" id="outside">
        外部按钮
      </button>
      {open && (
        <Modal title="测试弹窗" onClose={onClose}>
          <button type="button" id="first">
            第一个
          </button>
          <input id="field" />
          <button type="button" id="last">
            最后一个
          </button>
        </Modal>
      )}
    </>
  )
}

/** onClose 真正把弹窗卸载的宿主，用来观察「退场动画 → 卸载」的先后。 */
function UnmountingHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        id="trigger"
        onClick={() => {
          setOpen(true)
        }}
      >
        打开
      </button>
      {open && (
        <Modal
          title="测试弹窗"
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <button type="button" id="first">
            第一个
          </button>
        </Modal>
      )}
    </>
  )
}

function renderNode(node: ReactNode): void {
  act(() => {
    root = createRoot(container)
    root.render(node)
  })
}

function render(onClose = () => {}): void {
  renderNode(<Harness onClose={onClose} />)
}

function openModal(): void {
  const trigger = container.querySelector<HTMLButtonElement>('#trigger')!
  trigger.focus()
  act(() => {
    trigger.click()
  })
}

function keyDownOnDocument(key: string, shiftKey = false): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('Modal 焦点管理', () => {
  it('打开时焦点进入弹窗第一个可交互元素（头部关闭按钮）', () => {
    render()
    openModal()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
  })

  it('Esc 关闭：先挂 .is-leaving 播 150ms 退场动画，期间不回调 onClose，动画结束才卸载并还原焦点', () => {
    vi.useFakeTimers()
    let closed = 0
    renderNode(
      <UnmountingHarness
        onClose={() => {
          closed += 1
        }}
      />,
    )
    openModal()
    keyDownOnDocument('Escape')

    // 退场期间：遮罩与弹窗都进入 is-leaving 态，但还没卸载，onClose 也还没被调用
    expect(mediaQueries).toContain(REDUCED_MOTION_QUERY)
    expect(container.querySelector('.modal-mask.is-leaving')).not.toBeNull()
    expect(container.querySelector('.modal.is-leaving')).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(closed).toBe(0)

    advance(LEAVE_MS - 1)
    expect(closed).toBe(0)
    expect(container.querySelector('.is-leaving')).not.toBeNull()

    advance(1)
    expect(closed).toBe(1)
    expect(container.querySelector('.modal')).toBeNull()
    expect(container.querySelector('.is-leaving')).toBeNull()
    expect(document.activeElement?.id).toBe('trigger') // 卸载时才还原焦点
  })

  it('prefers-reduced-motion: reduce 时跳过退场动画，Esc 直接卸载', () => {
    reducedMotion = true
    let closed = 0
    renderNode(
      <UnmountingHarness
        onClose={() => {
          closed += 1
        }}
      />,
    )
    openModal()
    keyDownOnDocument('Escape')

    expect(mediaQueries).toContain(REDUCED_MOTION_QUERY)
    expect(closed).toBe(1) // 不等动画，同一帧就回调
    expect(container.querySelector('.modal')).toBeNull()
    expect(container.querySelector('.is-leaving')).toBeNull() // 没有可观测的退场态
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('Tab 在弹窗内循环（焦点圈禁），不会逃到遮罩外', () => {
    render()
    openModal()
    // 焦点置于最后一个可交互元素，Tab 应绕回第一个（头部关闭按钮）
    container.querySelector<HTMLElement>('#last')!.focus()
    keyDownOnDocument('Tab')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
    // Shift+Tab 从第一个绕到最后一个
    keyDownOnDocument('Tab', true)
    expect(document.activeElement?.id).toBe('last')
  })

  it('卸载后焦点还原到打开前的元素', () => {
    function AutoClose() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button
            type="button"
            id="trigger"
            onClick={() => {
              setOpen(true)
            }}
          >
            打开
          </button>
          {open && (
            <Modal
              title="t"
              onClose={() => {
                setOpen(false)
              }}
            >
              <button
                type="button"
                id="first"
                onClick={() => {
                  setOpen(false)
                }}
              >
                关
              </button>
            </Modal>
          )}
        </>
      )
    }
    renderNode(<AutoClose />)
    openModal()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
    act(() => {
      container.querySelector<HTMLButtonElement>('#first')!.click()
    })
    expect(document.activeElement?.id).toBe('trigger')
  })
})
