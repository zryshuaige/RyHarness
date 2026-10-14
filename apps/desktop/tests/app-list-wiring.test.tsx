// @vitest-environment jsdom
/**
 * 壳与列表的接线：会话列表必须用宿主 App 持有的 ApiClient，而不是自己 new 一个
 * （否则置顶/静音/删除绕过壳的刷新与错误处理），操作成功后要让宿主整表重拉，
 * 搜索命中跳转也要经壳把目标会话摆到台面上。
 *
 * 断联判据用「地址」而不是「有没有发请求」：壳的地址来自主进程注入的
 * __RYAGENT_API_BASE__，列表自建客户端时回落到 resolveApiBase() 的默认端口
 * （32100）。两者不同，所以只认壳那条地址。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type { AgentDef, Conversation, SearchResultRow } from '../renderer/src/api.ts'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 主进程注入的地址；列表自建客户端时用的是 32100，两条路径因此可区分。 */
const HOST_BASE = 'http://127.0.0.1:4100'

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  { id: 'coder', name: '小码', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
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
    memberAgentIds: ['coder'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 3,
    lastMessagePreview: '脚本写好了',
    unreadCount: 2,
  },
]

const hits: SearchResultRow[] = [
  {
    conversationId: 'c2',
    conversationTitle: '小码',
    messageId: 'm-7',
    snippet: '这个脚本在周报里提到过',
    agentId: 'coder',
    createdAt: 300,
  },
]

/** 假 WebSocket：列表点中命中后 ChatView 会立刻建订阅，这里只记录建连。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  close(): void {}
  open(): void {
    this.onopen?.()
  }
  emit(event: object): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined
let requestLog: string[]
const realWebSocket = globalThis.WebSocket

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  requestLog = []
  FakeWebSocket.instances = []
  window.history.replaceState({}, '', '/')
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  ;(window as unknown as Record<string, unknown>).__RYAGENT_API_BASE__ = HOST_BASE
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
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = `${url.pathname}${url.search}`
    requestLog.push(`${method} ${url.origin}${path}`)
    const body = ((): unknown => {
      if (path === '/api/agents') return { agents }
      if (path === '/api/agent-templates') return { templates: [] }
      if (path === '/api/providers') return { providers: [] }
      if (path === '/api/conversations') return { conversations }
      if (path.startsWith('/api/search')) return { results: hits }
      if (path.endsWith('/messages')) return { messages: [] }
      if (path.endsWith('/read')) return { conversationId: 'c2', lastReadSeq: 0 }
      if (path.endsWith('/dispatch')) return { events: [] }
      return {}
    })()
    return {
      ok: true,
      status: 200,
      json: () => {
        return Promise.resolve(body)
      },
    } as unknown as Response
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
  ;(globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket
  delete (window as unknown as Record<string, unknown>).__RYAGENT_API_BASE__
  window.history.replaceState({}, '', '/')
})

async function renderApp(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<App />)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 搜索框是防抖的：推进定时器再等一次刷新落地。 */
async function search(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('.search-box')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => {
      setTimeout(resolve, 260)
    })
    await Promise.resolve()
  })
}

function countOf(entry: string): number {
  return requestLog.filter((line) => {
    return line === entry
  }).length
}

describe('会话列表走宿主的 ApiClient', () => {
  it('全文搜索打在主进程注入的那个地址上，不是列表自建的默认端口', async () => {
    await renderApp()
    await search('周报')
    expect(requestLog).toContain(`GET ${HOST_BASE}/api/search?q=%E5%91%A8%E6%8A%A5`)
    // 自建客户端那条路会打 32100；一次都不许出现
    expect(
      requestLog.some((line) => {
        return line.includes('127.0.0.1:32100')
      }),
    ).toBe(false)
  })

  it('置顶之后宿主整表重拉（onChanged 不是摆设）', async () => {
    await renderApp()
    expect(countOf(`GET ${HOST_BASE}/api/conversations`)).toBe(1)
    const row = container.querySelectorAll<HTMLElement>('.conversation-item')[0]!
    await act(async () => {
      row.querySelector<HTMLButtonElement>('.conversation-more')!.click()
    })
    const menu = container.querySelector<HTMLElement>('.conversation-item-menu')!
    await act(async () => {
      ;[...menu.querySelectorAll('button')]
        .find((node) => {
          return node.textContent?.trim() === '置顶'
        })!
        .click()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // PATCH 打在宿主地址上，且成功后壳把整张表重新拉了一遍
    expect(
      requestLog.some((line) => {
        return line.startsWith(`PATCH ${HOST_BASE}/api/conversations/c1`)
      }),
    ).toBe(true)
    expect(countOf(`GET ${HOST_BASE}/api/conversations`)).toBe(2)
  })
})

describe('搜索命中跳转经壳切会话', () => {
  it('点命中：壳把目标会话切到台面上，并抛出定位事件', async () => {
    await renderApp()
    const jumped: string[] = []
    const listener = (event: Event): void => {
      jumped.push((event as CustomEvent<{ conversationId: string }>).detail.conversationId)
    }
    window.addEventListener('ryagent:scroll-to-message', listener)
    try {
      await search('周报')
      const hit = container.querySelector<HTMLButtonElement>('.search-hit')!
      expect(hit.textContent).toContain('这个脚本在周报里提到过')
      await act(async () => {
        hit.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      // 壳把目标会话摆到台面上：聊天视图挂的是命中所在的 c2（搜索列表还开着，
      // 所以判据在聊天区头部，不在列表行的 is-active）
      expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('小码')
      // 聊天视图随即挂载并建订阅——命中是真的能落到那条消息上
      expect(
        FakeWebSocket.instances.some((socket) => {
          return socket.url.includes('c2')
        }),
      ).toBe(true)
      expect(jumped).toEqual(['c2'])
    } finally {
      window.removeEventListener('ryagent:scroll-to-message', listener)
    }
  })
})
