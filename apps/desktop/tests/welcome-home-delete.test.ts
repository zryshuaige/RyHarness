// @vitest-environment jsdom
/**
 * 欢迎页删示例会话：文案说的是真话，删完左栏不留僵尸行。
 *
 * 修掉的那两处：
 * - 提示写着"删不回来"，而后端删的是**软删**（消息还在库里，restore 端点一直在），
 *   这是一句骗人的话；
 * - 删完之后左栏还留着那一行——点进去是 404，用户以为没删干净。
 *
 * @module @ryharness/desktop/tests/welcome-home-delete
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, Conversation, ProviderInfo } from '../renderer/src/api.ts'
import { setApiToken } from '../renderer/src/api.ts'
import { type ConversationApi, ConversationList } from '../renderer/src/components/ConversationList.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
]

/** 主进程 seedFirstLaunchDemo 种出来的首启演示会话。 */
function demoConversation(id: string): Conversation {
  return {
    id,
    kind: 'group',
    title: '示例 · Ryen（总管）、工程师、管家一起做季度报告',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    lastMessagePreview: '报告已经放进工作区，结论先行。',
  }
}

/** 首屏渲染用的 props：凭据齐全、有那条示例会话。 */
function welcomeProps(conversations: Conversation[]) {
  return {
    ryen: undefined,
    agents: [] as AgentDef[],
    conversations,
    providers: [
      { id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] },
    ] as ProviderInfo[],
    onSaveApiKey: () => {
      return Promise.resolve()
    },
    onSend: () => {},
    onOpenConversation: () => {},
  }
}

/** 左栏那份列表用的假接口：这一条用例走的是欢迎页的删除通道。 */
function fakeApi(): ConversationApi {
  return {
    patchConversation: () => {
      return Promise.resolve({ conversation: undefined })
    },
    deleteConversation: () => {
      return Promise.resolve({ deleted: '' })
    },
    restoreConversation: () => {
      return Promise.resolve({ conversation: undefined })
    },
  }
}

let welcomeContainer: HTMLDivElement
let listContainer: HTMLDivElement
let welcomeRoot: Root | undefined
let listRoot: Root | undefined
const fetchMock = vi.fn()

beforeEach(() => {
  window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100&token=token-demo')
  setApiToken('token-demo')
  welcomeContainer = document.createElement('div')
  listContainer = document.createElement('div')
  document.body.appendChild(welcomeContainer)
  document.body.appendChild(listContainer)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
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
    welcomeRoot?.unmount()
    listRoot?.unmount()
  })
  welcomeRoot = undefined
  listRoot = undefined
  welcomeContainer.remove()
  listContainer.remove()
  vi.unstubAllGlobals()
  setApiToken('')
  for (const item of getToasts()) toast.dismiss(item.id)
})

/** 首屏与左栏一起挂上：左栏那份列表是同一份数据，删完之后它得跟着变。 */
function render(conversation: Conversation): void {
  act(() => {
    welcomeRoot = createRoot(welcomeContainer)
    welcomeRoot.render(createElement(WelcomeHome, welcomeProps([conversation])))
    listRoot = createRoot(listContainer)
    listRoot.render(
      createElement(ConversationList, {
        conversations: [conversation],
        agents,
        activeId: undefined,
        api: fakeApi(),
        onSelect: () => {},
      }),
    )
  })
}

/** 点首屏那个删除键。 */
async function clickDelete(): Promise<void> {
  const button = welcomeContainer.querySelector<HTMLButtonElement>('.welcome-demo-clear')
  if (button === null) throw new Error('首屏没有删除示例的按键')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('删示例会话：说的是真话', () => {
  it('提示里没有"删不回来"这类绝对化断言，写的是能撤销', async () => {
    render(demoConversation('demo-copy'))
    const html = welcomeContainer.innerHTML
    expect(html).not.toContain('删不回来')
    expect(html).not.toContain('不能恢复')
    expect(html).not.toContain('永久删除')
    // 删除键自己把话说清楚：删了还能撤销回来
    const button = welcomeContainer.querySelector<HTMLButtonElement>('.welcome-demo-clear')
    expect(button?.getAttribute('title')).toContain('撤销')

    await clickDelete()
    const texts = getToasts()
      .map((item) => {
        return item.text
      })
      .join('|')
    expect(texts).toContain('撤销')
    expect(texts).not.toContain('删不回来')
  })

  it('删完给一个带「撤销」的提示（软删，消息还在库里）', async () => {
    render(demoConversation('demo-undo-toast'))
    await clickDelete()
    const undo = getToasts().find((item) => {
      return item.action?.label === '撤销'
    })
    expect(undo).toBeDefined()
    // 撤销是真的能点的：它去服务端把软删标记清掉
    await act(async () => {
      undo?.action?.run()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const restoreCall = fetchMock.mock.calls.find((call) => {
      return String(call[0]).includes('/restore')
    })
    expect(restoreCall).toBeDefined()
  })
})

describe('删示例会话：左栏不留僵尸行', () => {
  it('删完那一行从左栏消失（不能留一行点进去 404 的会话）', async () => {
    render(demoConversation('demo-zombie'))
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(1)
    await clickDelete()
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(0)
  })

  it('撤销之后那一行又回来', async () => {
    render(demoConversation('demo-back'))
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(1)
    await clickDelete()
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(0)
    const undo = getToasts().find((item) => {
      return item.action?.label === '撤销'
    })
    expect(undo).toBeDefined()
    await act(async () => {
      undo?.action?.run()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(1)
  })

  it('没删成功时不许把那一行悄悄摘掉（不许装成已经删了）', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 })
    render(demoConversation('demo-failed'))
    await clickDelete()
    expect(listContainer.querySelectorAll('.conversation-item')).toHaveLength(1)
    expect(welcomeContainer.querySelector('.welcome-demo-clear')).not.toBeNull()
  })
})
