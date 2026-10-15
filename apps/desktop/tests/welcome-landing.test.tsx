// @vitest-environment jsdom
/**
 * 入口诚实：欢迎页的建议 chip 与「发给谁」去���、首屏的信息层级，以及多 agent 场景
 * 真的落进群会话（含托盘「新对话」把它带回这页）。
 *
 * 断联判据：网络请求的路径与请求体，以及会话头部的标题——文案写着「我们三个」却只
 * 落 Ryen 单聊，正是这里要钉死的那类假入口。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App, NEW_CHAT_EVENT } from '../renderer/src/App.tsx'
import type { AgentDef, Conversation } from '../renderer/src/api.ts'
import type { WelcomeTarget } from '../renderer/src/components/WelcomeHome.tsx'
import { WelcomeHome } from '../renderer/src/components/WelcomeHome.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
  { id: 'coder', name: '小码', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
  { id: 'writer', name: '小笔', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: false },
]

/** 首启演示会话（主进程种出来的），三人小队。 */
const demoGroup: Conversation = {
  id: 'demo-1',
  kind: 'group',
  title: '示例 · 三个人一起定晚饭',
  memberAgentIds: ['ryen', 'coder', 'writer'],
  dispatcherAgentId: 'ryen',
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 2,
  lastMessagePreview: '那就定周三晚',
}

const directChat: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 0,
  createdAt: 1,
  updatedAt: 3,
  lastMessagePreview: '周报写好了',
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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

function chipButton(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.welcome-chip')].find((node) => {
    return node.textContent?.includes(text)
  })
  if (found === undefined) throw new Error(`找不到 chip：${text}`)
  return found
}

describe('欢迎页：去向写在脸上，chip 点了就拨到该去的方向', () => {
  async function renderWelcome(extras: Record<string, unknown> = {}): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agents[0]}
          agents={agents}
          conversations={[demoGroup, directChat]}
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }]}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={() => {}}
          onOpenConversation={() => {}}
          {...extras}
        />,
      )
      await Promise.resolve()
    })
  }

  it('「跟 Ryen 聊 / 开个小队」两格摆明，默认只在单聊', async () => {
    await renderWelcome()
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.welcome-chips [aria-pressed]')]
    expect(
      buttons.map((node) => {
        return node.textContent?.trim()
      }),
    ).toEqual(['跟 Ryen 聊', '开个小队（3 人）'])
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false')
    // 只有一个 agent 时没有小队可开，这格得是关的而不是点进去才发现。
    await act(async () => {
      root?.unmount()
    })
    await renderWelcome({ agents: [agents[0]!] })
    expect(container.querySelector<HTMLButtonElement>('.welcome-chips [aria-pressed="false"]')?.disabled).toBe(true)
  })

  it('群场景的 chip 标着「小队」，单聊场景标着 Ryen', async () => {
    await renderWelcome()
    expect(chipButton('我们三个定下周去哪吃').textContent).toContain('小队')
    expect(chipButton('把我上次说的偏好讲给团队听').textContent).toContain('小队')
    expect(chipButton('帮我整理一份本周周报').textContent).toContain('Ryen')
    // 文案不许再说「群里还有另外两位」这种与去向无关的话。
    expect(container.querySelector('.welcome-sub')?.textContent).not.toContain('群里还有另外两位')
  })

  it('点多 agent 的 chip：文案填进框、去向拨到小队，发送时带的也是小队', async () => {
    const sent: Array<[string, WelcomeTarget]> = []
    await renderWelcome({
      onSend: (text: string, target: WelcomeTarget) => {
        sent.push([text, target])
      },
    })
    await act(async () => {
      chipButton('我们三个定下周去哪吃').click()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')?.value).toBe(
      '我们三个定下周去哪吃',
    )
    expect(container.querySelector('.welcome-chips [aria-pressed="true"]')?.textContent).toContain('开个小队')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')!.click()
      await Promise.resolve()
    })
    expect(sent).toEqual([['我们三个定下周去哪吃', { kind: 'group' }]])
  })

  it('点单聊 chip：去向回到单聊，发送时带的也是单聊', async () => {
    const sent: Array<[string, WelcomeTarget]> = []
    await renderWelcome({
      onSend: (text: string, target: WelcomeTarget) => {
        sent.push([text, target])
      },
    })
    await act(async () => {
      chipButton('我们三个定下周去哪吃').click()
      await Promise.resolve()
      chipButton('帮我整理一份本周周报').click()
      await Promise.resolve()
    })
    expect(container.querySelector('.welcome-chips [aria-pressed="true"]')?.textContent).toContain('跟 Ryen 聊')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')!.click()
      await Promise.resolve()
    })
    expect(sent).toEqual([['帮我整理一份本周周报', { kind: 'direct' }]])
  })

  it('首屏层级：输入框与最近会话排在凭据卡与场景 chips 之前', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agents[0]}
          agents={agents}
          conversations={[demoGroup, directChat]}
          // 没配凭据：凭据卡必须出现，且不能把首屏顶穿。
          providers={[{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: false, models: [] }]}
          onSaveApiKey={() => {
            return Promise.resolve()
          }}
          onSend={() => {}}
          onOpenConversation={() => {}}
        />,
      )
      await Promise.resolve()
    })
    const order = [...container.querySelectorAll('.welcome-compose, .welcome-recent, .apikey-card, .welcome-chip')]
    const at = (selector: string): number => {
      return order.findIndex((node) => {
        return node.matches(selector)
      })
    }
    expect(at('.welcome-compose')).toBeGreaterThanOrEqual(0)
    expect(at('.welcome-recent')).toBeGreaterThan(at('.welcome-compose'))
    expect(at('.apikey-card')).toBeGreaterThan(at('.welcome-recent'))
    expect(at('.welcome-chip')).toBeGreaterThan(at('.welcome-recent'))
  })
})

describe('壳：多 agent 场景真的落进群会话', () => {
  /** 假 WebSocket：切进会话后 ChatView 立刻建订阅，这里只记录。 */
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
  }

  interface Recorded {
    calls: Array<{ method: string; path: string; body: string }>
    conversations: Conversation[]
  }

  let recorded: Recorded
  const realWebSocket = globalThis.WebSocket
  let seq = 0

  beforeEach(() => {
    seq = 0
    FakeWebSocket.instances = []
    recorded = { calls: [], conversations: [demoGroup, directChat] }
    ;(window as unknown as Record<string, unknown>).__RYAGENT_API_BASE__ = 'http://127.0.0.1:4200'
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = `${url.pathname}${url.search}`
      recorded.calls.push({ method, path, body: String(init?.body ?? '') })
      const body = ((): unknown => {
        if (path === '/api/agents') return { agents }
        if (path === '/api/agent-templates') return { templates: [] }
        if (path === '/api/providers') return { providers: [] }
        if (path === '/api/conversations' && method === 'GET') return { conversations: recorded.conversations }
        if (path === '/api/conversations' && method === 'POST') {
          seq += 1
          const input_ = JSON.parse(String(init?.body ?? '{}')) as {
            kind: string
            memberAgentIds?: string[]
            dispatcherAgentId?: string
            title?: string
            agentId?: string
          }
          const created: Conversation = {
            id: `new-${seq}`,
            kind: input_.kind === 'group' ? 'group' : 'direct',
            title: input_.title ?? input_.agentId ?? '群聊',
            memberAgentIds: input_.memberAgentIds ?? [input_.agentId ?? 'ryen'],
            ...(input_.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: input_.dispatcherAgentId }),
            lastReadSeq: 0,
            createdAt: 10,
            updatedAt: 10,
          }
          recorded.conversations = [created, ...recorded.conversations]
          return { conversation: created }
        }
        if (path.endsWith('/messages') && method === 'GET') return { messages: [] }
        if (path.endsWith('/messages') && method === 'POST') return { accepted: true, streamSeq: 0 }
        if (path.endsWith('/read')) return { conversationId: 'x', lastReadSeq: 0 }
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
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket
    delete (window as unknown as Record<string, unknown>).__RYAGENT_API_BASE__
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

  /** 点群 chip → 把填好的那句话发出去。 */
  async function sendViaChip(text: string): Promise<void> {
    await act(async () => {
      chipButton(text).click()
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const created = (): Recorded['calls'][number][] => {
    return recorded.calls.filter((call) => {
      return call.method === 'POST' && call.path === '/api/conversations'
    })
  }

  const posted = (conversationId: string): Recorded['calls'][number][] => {
    return recorded.calls.filter((call) => {
      return call.method === 'POST' && call.path === `/api/conversations/${conversationId}/messages`
    })
  }

  it('点「我们三个定下周去哪吃」：建小队群并把这句话发进那个群（不是 Ryen 单聊）', async () => {
    await renderApp()
    await sendViaChip('我们三个定下周去哪吃')
    const posts = created()
    expect(posts).toHaveLength(1)
    const payload = JSON.parse(posts[0]!.body) as { kind: string; memberAgentIds: string[] }
    expect(payload.kind).toBe('group')
    expect(payload.memberAgentIds).toEqual(['ryen', 'coder', 'writer'])
    // 落点：新建的那个群，并且消息真的发进它了。
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('小队')
    expect(posted('new-1')).toHaveLength(1)
    expect(posted('new-1')[0]?.body).toContain('我们三个定下周去哪吃')
    expect(posted('c1')).toHaveLength(0)
  })

  it('已有小队群时直接复用，不再建第二个（示例会话不算「已存在的小队」）', async () => {
    // 把示例换成用户自己的小队群。
    recorded.conversations = [{ ...demoGroup, id: 'g9', title: '我们的小队' }, directChat]
    await renderApp()
    await sendViaChip('我们三个定下周去哪吃')
    expect(created()).toHaveLength(0)
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('我们的小队')
    expect(posted('g9')[0]?.body).toContain('我们三个定下周去哪吃')
  })

  it('示例会话不会被当成小队：群场景另起一个会话', async () => {
    await renderApp()
    await sendViaChip('我们三个定下周去哪吃')
    expect(created()).toHaveLength(1)
    expect(posted('demo-1')).toHaveLength(0)
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('小队')
  })

  it('单聊 chip：复用与 Ryen 的会话，不发 POST 建群', async () => {
    await renderApp()
    await sendViaChip('帮我整理一份本周周报')
    expect(created()).toHaveLength(0)
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('Ryen')
    expect(posted('c1')[0]?.body).toContain('帮我整理一份本周周报')
  })

  it('托盘「新对话」：派发事件即回到欢迎页，让用户自己选跟谁聊', async () => {
    await renderApp()
    // 先切进一个会话（托盘点新对话时用户多半正停在某个会话里）
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.conversation-item-main')!.click()
      await Promise.resolve()
    })
    expect(container.querySelector('.welcome')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))
      await Promise.resolve()
    })
    expect(container.querySelector('.welcome')).not.toBeNull()
    // 两格去向都在：托盘不再替用户点开与 Ryen 的单聊。
    expect(container.textContent).toContain('跟 Ryen 聊')
    expect(container.textContent).toContain('开个小队')
  })
})
