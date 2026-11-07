// @vitest-environment jsdom
/**
 * 「新对话」入口与上次会话恢复（2026-11-07 用户视角 debug F4/F5）：
 *
 * F4：会话打开后，窗口内没有任何回到欢迎页/开新对话的按钮——唯一入口是 Electron
 * 托盘菜单和 Ctrl+N，浏览器态是死路。现在列表头部有按钮，与托盘/Ctrl+N 走同一事件。
 * F5：重启/刷新后选中态丢了，落在欢迎页——「我在哪」是最基本的界面状态，跟着
 * localStorage 走；会话已删则静默留在欢迎页。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLastConversationId, NEW_CHAT_EVENT } from '../renderer/src/App.tsx'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'

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

const agents: AgentDef[] = []

const conversations: Conversation[] = [conversation('c1', '第一条'), conversation('c2', '第二条')]

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
  localStorage.clear()
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
})

describe('会话列表头部的「新对话」按钮', () => {
  it('传了 onNewChat 就渲染按钮，点击派发与托盘同一个事件', () => {
    let dispatched = 0
    const onEvent = (): void => {
      dispatched += 1
    }
    window.addEventListener(NEW_CHAT_EVENT, onEvent)
    try {
      act(() => {
        root?.render(
          <ConversationList
            conversations={conversations}
            agents={agents}
            activeId="c1"
            onSelect={() => {}}
            onNewChat={() => {
              window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))
            }}
          />,
        )
      })
      const button = container.querySelector<HTMLButtonElement>('.list-new-chat')
      expect(button).not.toBeNull()
      expect(button?.textContent).toContain('新对话')
      act(() => {
        button?.click()
      })
      expect(dispatched).toBe(1)
    } finally {
      window.removeEventListener(NEW_CHAT_EVENT, onEvent)
    }
  })

  it('没传 onNewChat 就不渲染（旧宿主不受影响）', () => {
    act(() => {
      root?.render(<ConversationList conversations={conversations} agents={agents} activeId="c1" onSelect={() => {}} />)
    })
    expect(container.querySelector('.list-new-chat')).toBeNull()
  })
})

describe('上次会话 id 的存取（loadLastConversationId）', () => {
  it('没存过返回 undefined；存过原样返回', () => {
    expect(loadLastConversationId()).toBeUndefined()
    localStorage.setItem('ryharness-active-conversation', 'conv-42')
    expect(loadLastConversationId()).toBe('conv-42')
  })

  it('空串按没存过处理（写侧用 removeSetting 清键，这里兜老数据）', () => {
    localStorage.setItem('ryharness-active-conversation', '')
    expect(loadLastConversationId()).toBeUndefined()
  })
})
