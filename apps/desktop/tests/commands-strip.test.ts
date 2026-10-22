// @vitest-environment jsdom
/**
 * `/` 命令执行后，输入框里只该少掉命令本身。
 *
 * 修掉的那个毛病：命令命中后整个输入框被清空——用户写了一半的草稿
 * （"/help 帮我看看这段代码" 里后半截那段）跟着命令一起静默消失。
 *
 * 两层断言：纯函数（lib/commands.ts 的 stripCommand）算得对不对，组件
 * （ChatInput）是不是真的用了这一份——测试里一份、实现里另一份是最容易骗过
 * 自己的写法。
 *
 * @module @ryharness/desktop/tests/commands-strip
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'
import { type Command, commandWordAt, stripCommand } from '../renderer/src/lib/commands.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('命令词占哪一段', () => {
  it('行首的斜杠算命令，中间的斜杠是正文', () => {
    expect(commandWordAt('/help', 5)).toEqual({ start: 0, end: 5, word: 'help' })
    expect(commandWordAt('abc /help', 9)).toBeNull()
    expect(commandWordAt('路径是 C:/Users', 13)).toBeNull()
  })

  it('斜杠后面紧跟空白时不是命令（"/ 新" 是正文）', () => {
    expect(commandWordAt('/ 新', 3)).toBeNull()
  })
})

describe('命令跑完，输入框里剩下什么', () => {
  it('只删命令本身，后半截草稿留着', () => {
    expect(stripCommand('/help 帮我看看这段代码', 5)).toEqual({ text: '帮我看看这段代码', cursor: 0 })
    // 光标在末尾时也一样：命令在前面，草稿在后面
    expect(stripCommand('/help 帮我看看这段代码', 17)).toEqual({ text: '帮我看看这段代码', cursor: 0 })
  })

  it('光标在中间时，光标后面的内容一个字都不动', () => {
    const stripped = stripCommand('/help 帮我看看这段代码', 8)
    expect(stripped.text).toBe('帮我看看这段代码')
    expect(stripped.text).toContain('这段代码')
    expect(stripped.cursor).toBe(0)
  })

  it('不是命令就原样不动（"abc /help" 不是命令）', () => {
    expect(stripCommand('abc /help', 9)).toEqual({ text: 'abc /help', cursor: 9 })
  })

  it('输入框里只有命令时，删完是空的', () => {
    expect(stripCommand('/help', 5)).toEqual({ text: '', cursor: 0 })
    expect(stripCommand('/', 1)).toEqual({ text: '', cursor: 0 })
  })
})

describe('ChatInput 执行命令', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot> | undefined
  const commands: Command[] = [{ id: 'help', label: 'help', hint: '示例命令', run: vi.fn() }]

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = undefined
    container.remove()
  })

  function textarea(): HTMLTextAreaElement {
    const node = container.querySelector('textarea')
    if (node === null) throw new Error('找不到输入框')
    return node
  }

  /** 受控输入：走原生 setter + input 事件，光标停在 caret 处。 */
  function typeText(value: string, caret = value.length): void {
    const node = textarea()
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('拿不到 value 的 setter')
    act(() => {
      setter.call(node, value)
      node.setSelectionRange(caret, caret)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function keyDown(key: string): void {
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  it('命令跑完，剩下的是用户写的那半截草稿', () => {
    act(() => {
      root?.render(createElement(ChatInput, { members: [], commands, onSend: vi.fn() }))
    })
    // 光标停在命令后面（用户写完命令，正文还没写完）
    typeText('/help 帮我看看这段代码', 5)
    keyDown('Enter')
    expect(commands[0]?.run).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe('帮我看看这段代码')
  })

  it('命令本身要消失：不然下次再按 "/" 会重复触发同一条命令', () => {
    act(() => {
      root?.render(createElement(ChatInput, { members: [], commands, onSend: vi.fn() }))
    })
    typeText('/help 帮我看看这段代码', 5)
    keyDown('Enter')
    expect(textarea().value.startsWith('/')).toBe(false)
  })

  it('不是命令的那半截不该被当成命令执行', () => {
    act(() => {
      root?.render(createElement(ChatInput, { members: [], commands, onSend: vi.fn() }))
    })
    typeText('abc /help', 9)
    keyDown('Enter')
    expect(commands[0]?.run).not.toHaveBeenCalled()
  })
})
