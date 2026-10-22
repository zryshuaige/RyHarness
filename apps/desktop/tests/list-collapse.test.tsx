// @vitest-environment jsdom
/**
 * 左栏（会话列表）可折叠。
 *
 * 样式表里 `.list-panel.is-collapsed` 与 `.list-panel-toggle` 早就写好了
 * ——连"折叠键必须是 .list-panel 的直接子节点、放进 .list-panel-header 会被
 * 收起态的 visibility:hidden 一起藏掉"这件事都写在注释里。缺的只是那个
 * 按钮本身：窄窗口下左栏被媒体查询挤窄（1199px / 1040px 两档），用户**没有
 * 任何办法**把宽度还给聊天区，而右栏的孪生控件一直好使。
 *
 * 这里钉住三件事：键渲染出来了、键是 .list-panel 的直接子节点（收起后仍在场，
 * 展得开）、以及收起态跟着用户走（localStorage）。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadListCollapsed } from '../renderer/src/App.tsx'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import { ConversationList } from '../renderer/src/components/ConversationList.tsx'

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
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 列表里有一处按 matchMedia 判窄屏：没有这个桩，jsdom 直接抛。
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
  vi.unstubAllGlobals()
})

function render(collapsed: boolean, onToggleCollapsed: () => void): void {
  act(() => {
    root?.render(
      <aside className={collapsed ? 'list-panel is-collapsed' : 'list-panel'}>
        <ConversationList
          conversations={conversations}
          agents={agents}
          activeId="c1"
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onSelect={() => {}}
        />
      </aside>,
    )
  })
}

describe('左栏折叠键', () => {
  it('渲染出来了，展开态写「收起」', () => {
    render(false, () => {})
    const button = container.querySelector('.list-panel-toggle')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('收起会话列表')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
  })

  it('收起态写「展开」，且键仍在场（展得开）', () => {
    render(true, () => {})
    const button = container.querySelector('.list-panel-toggle')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('展开会话列表')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
  })

  it('键是 .list-panel 的直接子节点（塞进 header 会被收起态一起藏掉）', () => {
    render(false, () => {})
    const panel = container.querySelector('.list-panel')
    const button = container.querySelector('.list-panel-toggle')
    expect(button?.parentElement).toBe(panel)
    expect(button?.closest('.list-panel-header')).toBeNull()
  })

  it('点它就通知宿主切换', () => {
    const onToggle = vi.fn()
    render(false, onToggle)
    const button = container.querySelector('.list-panel-toggle') as HTMLButtonElement
    act(() => {
      button.click()
    })
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('宿主没给 onToggleCollapsed 时不渲染这个键（不做一个点不动的死控件）', () => {
    act(() => {
      root?.render(
        <aside className="list-panel">
          <ConversationList conversations={conversations} agents={agents} activeId="c1" onSelect={() => {}} />
        </aside>,
      )
    })
    expect(container.querySelector('.list-panel-toggle')).toBeNull()
  })
})

describe('左栏收起态的持久化', () => {
  it('没有记录时默认展开（左栏是主导航，不像右栏那样默认收起）', () => {
    expect(loadListCollapsed()).toBe(false)
  })

  it('存过就以用户的选择为准', () => {
    localStorage.setItem('ryharness-list-collapsed', '1')
    expect(loadListCollapsed()).toBe(true)
    localStorage.setItem('ryharness-list-collapsed', '0')
    expect(loadListCollapsed()).toBe(false)
  })

  it('localStorage 不可用时退回展开，不抛错', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('denied')
    }
    try {
      expect(loadListCollapsed()).toBe(false)
    } finally {
      Storage.prototype.getItem = original
    }
  })
})
