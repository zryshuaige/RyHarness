// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const members = [
  { id: 'ryen', name: 'Ryen' },
  { id: 'codebot', name: 'CodeBot' },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(onSend: (text: string) => void = () => {}): void {
  act(() => {
    root = createRoot(container)
    root.render(<ChatInput members={members} onSend={onSend} />)
  })
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector('textarea')!
}

/** 受控组件输入：走原生 setter + input 事件，光标置于末尾。 */
function typeText(value: string): void {
  const node = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.setSelectionRange(value.length, value.length)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function keyDown(key: string): void {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

describe('ChatInput @补全菜单', () => {
  it('输入 @R 弹出候选菜单', () => {
    render()
    typeText('@R')
    const menu = container.querySelector('.mention-menu')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain('Ryen')
  })

  it('Esc 关闭菜单且不污染输入文本（无零宽字符）', () => {
    const sent: string[] = []
    render((text) => { sent.push(text) })
    typeText('@R')
    expect(container.querySelector('.mention-menu')).not.toBeNull()
    keyDown('Escape')
    expect(container.querySelector('.mention-menu')).toBeNull()
    // 文本原样保留，没有混入 U+200B 等魔法字符
    expect(textarea().value).toBe('@R')
    // Esc 关闭后继续输入（同一 @ 查询）应重新弹出
    typeText('@Ry')
    expect(container.querySelector('.mention-menu')).not.toBeNull()
  })

  it('Esc 关闭后 Enter 直接发送原文', () => {
    const sent: string[] = []
    render((text) => { sent.push(text) })
    typeText('@R')
    keyDown('Escape')
    keyDown('Enter')
    expect(sent).toEqual(['@R'])
  })

  it('菜单打开时 Enter 补全选中项', () => {
    render()
    typeText('@Code')
    keyDown('Enter')
    expect(textarea().value).toBe('@CodeBot ')
  })
})
