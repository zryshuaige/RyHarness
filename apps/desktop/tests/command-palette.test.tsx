// @vitest-environment jsdom
/**
 * 全局命令面板：Cmd+K 打开、输入过滤、↑↓ 走位、Enter 执行、Esc 关闭。
 *
 * 命令表复用 `/` 面板那份（由 App 构建），这里只验面板本身的过滤与键盘走位——
 * 「任何页面按一下就能找到并触发本机动作」是这个面板存在的全部理由。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../renderer/src/components/CommandPalette.tsx'
import type { Command } from '../renderer/src/lib/commands.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root !== undefined) {
    act(() => {
      root?.unmount()
    })
    root = undefined
  }
  container.remove()
  document.body.innerHTML = ''
})

/** 造一小组命令 + 记录各条被跑过几次。 */
function scaffold(open = true) {
  const runs = { newChat: 0, theme: 0, vibe: 0 }
  const commands: Command[] = [
    {
      id: 'new-chat',
      label: '新对话',
      hint: 'Ctrl+N',
      run: () => {
        runs.newChat += 1
      },
    },
    {
      id: 'theme-dark',
      label: '切到深色主题',
      run: () => {
        runs.theme += 1
      },
    },
    {
      id: 'tab-vibe',
      label: '切到 RyVibe',
      hint: 'Ctrl+2',
      run: () => {
        runs.vibe += 1
      },
    },
  ]
  const onClose = vi.fn()
  root = createRoot(container)
  act(() => {
    root?.render(<CommandPalette open={open} commands={commands} onClose={onClose} />)
  })
  return { runs, onClose }
}

function input(): HTMLInputElement {
  const node = container.querySelector<HTMLInputElement>('.command-palette-input')
  if (node === null) throw new Error('找不到 .command-palette-input')
  return node
}

function items(): HTMLLIElement[] {
  return [...container.querySelectorAll<HTMLLIElement>('.command-palette-item')]
}

function type(value: string): void {
  const node = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(name: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

describe('CommandPalette', () => {
  it('关闭时不渲染任何东西', () => {
    scaffold(false)
    expect(container.querySelector('.command-palette')).toBeNull()
  })

  it('打开：渲染对话框与全部命令，第一项默认高亮', () => {
    scaffold()
    expect(container.querySelector('.command-palette')?.getAttribute('role')).toBe('dialog')
    expect(items()).toHaveLength(3)
    expect(items()[0]?.classList.contains('is-active')).toBe(true)
    expect(items()[0]?.textContent).toContain('新对话')
  })

  it('输入过滤命令（大小写不敏感包含匹配）', () => {
    scaffold()
    type('主题')
    expect(items()).toHaveLength(1)
    expect(items()[0]?.textContent).toContain('切到深色主题')
  })

  it('没有匹配时显示空态', () => {
    scaffold()
    type('不存在的命令')
    expect(items()).toHaveLength(0)
    expect(container.querySelector('.command-palette-empty')?.textContent).toContain('没有匹配')
  })

  it('↓ 移高亮、Enter 执行并关闭', () => {
    const { runs, onClose } = scaffold()
    key('ArrowDown')
    expect(items()[1]?.classList.contains('is-active')).toBe(true)
    key('Enter')
    expect(runs.theme).toBe(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc 关闭', () => {
    const { onClose } = scaffold()
    key('Escape')
    expect(onClose).toHaveBeenCalled()
  })

  it('点命令项执行并关闭', () => {
    const { runs, onClose } = scaffold()
    act(() => {
      items()[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(runs.vibe).toBe(1)
    expect(onClose).toHaveBeenCalled()
  })
})
