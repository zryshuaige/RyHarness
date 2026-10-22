// @vitest-environment jsdom
/**
 * `/` 命令面板。
 *
 * 两条口径要钉住：**触发**（只有行首的斜杠算命令，中间的斜杠是正文）与
 * **执行**（选中一条命令就清空输入框并跑它；没选中时 `/` 留在输入框里不被吞掉）。
 *
 * @module @ryharness/desktop/tests/command-palette
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'
import { type Command, commandQueryAt, filterCommands } from '../renderer/src/lib/commands.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const commands: Command[] = [
  { id: 'new-chat', label: '新对话', hint: 'Ctrl+N', run: vi.fn() },
  { id: 'theme-dark', label: '切到深色主题', run: vi.fn() },
  { id: 'open-workspace', label: '打开工作区目录', run: vi.fn() },
]

describe('命令触发口径', () => {
  it('行首的斜杠算命令', () => {
    expect(commandQueryAt('/', 1)).toEqual({ start: 0, query: '' })
    expect(commandQueryAt('/新', 2)).toEqual({ start: 0, query: '新' })
  })

  it('中间的斜杠是正文（路径、日期那些）', () => {
    expect(commandQueryAt('路径是 C:/Users', 13)).toBeNull()
    expect(commandQueryAt('看这个 /文档', 6)).toBeNull()
  })

  it('片段里有空白就不是命令了', () => {
    expect(commandQueryAt('/新 对话', 5)).toBeNull()
  })

  it('按关键字过滤候选（大小写不敏感）', () => {
    expect(
      filterCommands(commands, '新').map((each) => {
        return each.id
      }),
    ).toEqual(['new-chat'])
    expect(filterCommands(commands, '')).toHaveLength(3)
    expect(
      filterCommands(commands, '目录').map((each) => {
        return each.id
      }),
    ).toEqual(['open-workspace'])
  })
})

describe('命令面板', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot> | undefined

  beforeEach(() => {
    // 命令表是模块级的常量：每次用例前把它的 mock 清空，否则上一条用例执行过
    // 的命令会被算到这一条头上。
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
    vi.unstubAllGlobals()
  })

  function mountInput(): HTMLTextAreaElement {
    act(() => {
      root?.render(<ChatInput members={[]} commands={commands} onSend={vi.fn()} />)
    })
    return container.querySelector('textarea') as HTMLTextAreaElement
  }

  it('输入 "/" 出现候选列表', () => {
    const input = mountInput()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, '/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const options = container.querySelectorAll('[role="option"]')
    expect(options.length).toBe(3)
  })

  it('按回车执行选中的那条命令，并清空输入框', () => {
    const input = mountInput()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, '/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(commands[0]?.run).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('')
  })

  it('没选中命令时，"/" 留在输入框里不被吞掉（也能正常当正文发出去）', () => {
    const onSend = vi.fn()
    act(() => {
      root?.render(<ChatInput members={[]} commands={[]} onSend={onSend} />)
    })
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, '/1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledWith('/1', undefined)
  })

  it('Esc 关掉命令菜单，不执行任何命令', () => {
    const input = mountInput()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, '/')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(commands[0]?.run).not.toHaveBeenCalled()
  })
})
