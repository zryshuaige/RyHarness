// @vitest-environment jsdom
/**
 * 气泡上的三个历史改写动作：编辑并重发 / 重新生成 / 从此处分支。
 *
 * 三件事各有各的边界，钉住它们：
 *
 * - **编辑并重发**只给用户自己的话（改 agent 的发言等于让用户替它说话），只给
 *   已经落库的消息（还没送达的那条没有服务端 seq，改不了）；编辑态是就地摊开的
 *   输入框，回车保存、Esc 取消，**输入法组字中的回车不算保存**（中文用户按回车
 *   选词时不能把半截拼音存进去）。
 * - **重新生成**只给已经说完的 agent 消息。
 * - **从这里分支**给任何一条有 seq 的消息。
 *
 * @module @ryharness/desktop/tests/bubble-rewrite-actions
 */

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import type { MessagePart, UiMessage } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

const textPart: MessagePart = { kind: 'text', text: '第一句' }

function userMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    key: 'hist:u1',
    senderType: 'user',
    senderId: 'user',
    senderName: '用户',
    turnIndex: 0,
    done: true,
    seq: 12,
    parts: [textPart],
    ...overrides,
  }
}

function agentMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    key: 'hist:a1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done: true,
    seq: 13,
    parts: [textPart],
    ...overrides,
  }
}

/** 找带指定 aria-label 的按钮。 */
function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((each) => {
    return each.getAttribute('aria-label') === label
  })
}

describe('编辑并重发', () => {
  it('只给用户自己的话', () => {
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={vi.fn()} />)
    expect(button(container, '编辑并重发')).toBeDefined()
    unmount()

    const agent = mount(<MessageBubble message={agentMessage()} fileUrl={fileUrl} onEdit={vi.fn()} />)
    expect(button(agent.container, '编辑并重发')).toBeUndefined()
    agent.unmount()
  })

  it('还没落库的消息（没有 seq）不给这个键', () => {
    const { container, unmount } = mount(
      <MessageBubble message={userMessage({ seq: undefined })} fileUrl={fileUrl} onEdit={vi.fn()} />,
    )
    expect(button(container, '编辑并重发')).toBeUndefined()
    unmount()
  })

  it('点开是就地输入框，里面是原正文', () => {
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={vi.fn()} />)
    act(() => {
      button(container, '编辑并重发')?.click()
    })
    const input = container.querySelector('.bubble-edit-input') as HTMLTextAreaElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('第一句')
    unmount()
  })

  it('保存把新正文交给上层', () => {
    const onEdit = vi.fn()
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={onEdit} />)
    act(() => {
      button(container, '编辑并重发')?.click()
    })
    const input = container.querySelector('.bubble-edit-input') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, '改过的第一句')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      button(container, '保存并重发')?.click()
    })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0]?.[1]).toBe('改过的第一句')
    unmount()
  })

  it('Esc 取消，不改写', () => {
    const onEdit = vi.fn()
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={onEdit} />)
    act(() => {
      button(container, '编辑并重发')?.click()
    })
    const input = container.querySelector('.bubble-edit-input') as HTMLTextAreaElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onEdit).not.toHaveBeenCalled()
    expect(container.querySelector('.bubble-edit-input')).toBeNull()
    unmount()
  })

  it('输入法组字中的回车不算保存（中文用户按回车选词）', () => {
    const onEdit = vi.fn()
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={onEdit} />)
    act(() => {
      button(container, '编辑并重发')?.click()
    })
    const input = container.querySelector('.bubble-edit-input') as HTMLTextAreaElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('compositionstart', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onEdit).not.toHaveBeenCalled()
    unmount()
  })

  it('Shift+Enter 是换行，不是保存（与输入框同一套口径）', () => {
    // 这一框有 3 行，看着能多行；但回车一律保存，用户打不出第二行。
    const onEdit = vi.fn()
    const { container, unmount } = mount(<MessageBubble message={userMessage()} fileUrl={fileUrl} onEdit={onEdit} />)
    act(() => {
      button(container, '编辑并重发')?.click()
    })
    const input = container.querySelector('.bubble-edit-input') as HTMLTextAreaElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(onEdit).not.toHaveBeenCalled()
    unmount()
  })
})

describe('重新生成与从这里分支', () => {
  it('重新生成只给已经说完的 agent 消息', () => {
    const onRegenerate = vi.fn()
    const done = mount(<MessageBubble message={agentMessage()} fileUrl={fileUrl} onRegenerate={onRegenerate} />)
    expect(button(done.container, '重新生成这条回复')).toBeDefined()
    act(() => {
      button(done.container, '重新生成这条回复')?.click()
    })
    expect(onRegenerate).toHaveBeenCalledTimes(1)
    done.unmount()

    const streaming = mount(
      <MessageBubble message={agentMessage({ done: false })} fileUrl={fileUrl} onRegenerate={onRegenerate} />,
    )
    expect(button(streaming.container, '重新生成这条回复')).toBeUndefined()
    streaming.unmount()
  })

  it('用户消息没有「重新生成」', () => {
    const { container, unmount } = mount(
      <MessageBubble message={userMessage()} fileUrl={fileUrl} onRegenerate={vi.fn()} />,
    )
    expect(button(container, '重新生成这条回复')).toBeUndefined()
    unmount()
  })

  it('从这里分支给有 seq 的消息', () => {
    const onBranch = vi.fn()
    const { container, unmount } = mount(
      <MessageBubble message={userMessage()} fileUrl={fileUrl} onBranch={onBranch} />,
    )
    expect(button(container, '从这里分支出新会话')).toBeDefined()
    act(() => {
      button(container, '从这里分支出新会话')?.click()
    })
    expect(onBranch).toHaveBeenCalledTimes(1)
    unmount()
  })
})
