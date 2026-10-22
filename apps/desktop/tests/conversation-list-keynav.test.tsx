// @vitest-environment jsdom
/**
 * 会话列表的方向键导航（roving tabindex）。
 *
 * 此前每一行都是普通 button：300 条会话的列表要按 300 次 Tab 才走得到底。
 * 现在整张列表只占**一个** Tab 位，↑↓ 在行间走，Home/End 跳首尾——与通讯录
 * 头像选择器里已经写好的那套同一口径。
 *
 * 窗口化下的关键一条：焦点要落到**尚未渲染**的行时，先把它滚进窗口（它才存在），
 * 再聚焦——聚焦一个不存在的 DOM 节点是静默失败。
 *
 * @module @ryharness/desktop/tests/conversation-list-keynav
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
]

function conversation(id: string, title: string): Conversation {
  return {
    id,
    kind: 'direct',
    title,
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '',
  }
}

const conversations: Conversation[] = [
  conversation('c1', '第一条'),
  conversation('c2', '第二条'),
  conversation('c3', '第三条'),
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
    root?.render(<ConversationList conversations={conversations} agents={agents} activeId="c1" onSelect={() => {}} />)
  })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

/** 列表里的会话行按钮（按标题找）。 */
function rowOf(title: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.conversation-item-main')].find((button) => {
    return button.textContent?.includes(title)
  })
}

function press(key: string): void {
  const list = container.querySelector('.conversation-list') as HTMLElement
  act(() => {
    list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('会话列表的方向键导航', () => {
  it('整张列表只占一个 Tab 位', () => {
    const tabbable = [...container.querySelectorAll<HTMLButtonElement>('.conversation-item-main')].filter((button) => {
      return button.getAttribute('tabindex') === '0'
    })
    expect(tabbable).toHaveLength(1)
  })

  it('↓ 走到下一行，焦点真的落在那一行上', () => {
    const first = rowOf('第一条') as HTMLButtonElement
    act(() => {
      first.focus()
    })
    press('ArrowDown')
    expect(document.activeElement).toBe(rowOf('第二条'))
  })

  it('↑ 回到上一行', () => {
    const second = rowOf('第二条') as HTMLButtonElement
    act(() => {
      second.focus()
    })
    press('ArrowUp')
    expect(document.activeElement).toBe(rowOf('第一条'))
  })

  it('Home / End 跳首尾', () => {
    const second = rowOf('第二条') as HTMLButtonElement
    act(() => {
      second.focus()
    })
    press('End')
    expect(document.activeElement).toBe(rowOf('第三条'))
    press('Home')
    expect(document.activeElement).toBe(rowOf('第一条'))
  })

  it('走到边界不越界（不会跳到列表外面去）', () => {
    const first = rowOf('第一条') as HTMLButtonElement
    act(() => {
      first.focus()
    })
    press('ArrowUp')
    expect(document.activeElement).toBe(rowOf('第一条'))
  })
})
