// @vitest-environment jsdom
/**
 * 删除会话的撤销。
 *
 * 删除是最容易手滑的一下——列表行尾那个键就在三像素外。服务端删的是**软删**
 * （只打标记，消息还在库里），所以删除之后给一次反悔的机会：toast 上挂一个
 * 「撤销」，点了会话回到列表。
 *
 * @module @ryharness/desktop/tests/delete-undo
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import type { ConversationApi } from '../renderer/src/components/ConversationList.tsx'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
]

const conversations: Conversation[] = [
  {
    id: 'c1',
    kind: 'direct',
    title: '周报',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '把周报整理好了',
  },
  {
    id: 'c2',
    kind: 'direct',
    title: '小码',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 3,
    lastMessagePreview: '脚本写好了',
  },
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
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.unstubAllGlobals()
})

function buttonByText(text: string, scope: ParentNode): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((button) => {
    return button.textContent?.trim() === text
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

describe('删除会话可以撤销', () => {
  it('删完给一个带「撤销」的提示，撤销后这行回到列表', async () => {
    const restored: string[] = []
    const api: ConversationApi = {
      deleteConversation: (id) => {
        return Promise.resolve({ deleted: id })
      },
      restoreConversation: (id) => {
        restored.push(id)
        return Promise.resolve({ conversation: undefined })
      },
    }
    await act(async () => {
      root?.render(
        <ConversationList conversations={conversations} agents={agents} activeId="c1" api={api} onSelect={() => {}} />,
      )
      await Promise.resolve()
    })
    // 打开第一行的行尾菜单 → 点删除 → 确认。
    act(() => {
      const row = container.querySelectorAll<HTMLElement>('.conversation-item')[0] as HTMLElement
      row.querySelector<HTMLButtonElement>('.conversation-more')?.click()
    })
    act(() => {
      buttonByText('删除', container.querySelectorAll('.conversation-item')[0] as HTMLElement).click()
    })
    await act(async () => {
      buttonByText('确认删除', container.querySelector('[role="dialog"]') as HTMLElement).click()
      await Promise.resolve()
    })
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(1)

    const undo = getToasts().find((item) => {
      return item.text.includes('会话已删除')
    })
    expect(undo).toBeDefined()
    expect(undo?.action?.label).toBe('撤销')

    await act(async () => {
      undo?.action?.run()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(restored).toEqual(['c1'])
    expect(container.querySelectorAll('.conversation-item')).toHaveLength(2)
  })
})
