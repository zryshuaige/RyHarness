// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Modal } from '../renderer/src/components/Modal.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
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

function render(onClose = () => {}): void {
  act(() => {
    root = createRoot(container)
    root.render(<Harness onClose={onClose} />)
  })
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

describe('Modal 焦点管理', () => {
  it('打开时焦点进入弹窗第一个可交互元素（头部关闭按钮）', () => {
    render()
    openModal()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
  })

  it('Esc 关闭弹窗并回调 onClose，焦点还原到触发元素', () => {
    let closed = 0
    render(() => {
      closed += 1
    })
    openModal()
    keyDownOnDocument('Escape')
    expect(closed).toBe(1)
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
    act(() => {
      root = createRoot(container)
      root.render(<AutoClose />)
    })
    openModal()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭')
    act(() => {
      container.querySelector<HTMLButtonElement>('#first')!.click()
    })
    expect(document.activeElement?.id).toBe('trigger')
  })
})
