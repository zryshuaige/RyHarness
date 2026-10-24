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
import { App, NEW_CHAT_EVENT, OPEN_CONVERSATION_EVENT } from '../renderer/src/App.tsx'
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
  title: '示例 · 三个人一起做季度报告',
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

function chipButton(prompt: string): HTMLButtonElement {
  // 任务卡的可读标题缩短了，真正填进输入框的那句留在 data-prompt 上：
  // 测试按「会填什么」找卡，而不是按卡片上恰好印了哪几个字找。
  const found = [...container.querySelectorAll<HTMLButtonElement>('.welcome-chip')].find((node) => {
    return node.dataset.prompt === prompt
  })
  if (found === undefined) throw new Error(`找不到任务卡：${prompt}`)
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

  it('收件人行摆明去向，默认只在单聊；小队要用户自己点进去', async () => {
    await renderWelcome()
    // 一排头像（每位助理一格，单聊选项）+ 另一端一枚小队胶囊 = 同一个决定的全部控件。
    // 按名字读头像排，而不是按整块 textContent —— 没头像的助理，头像里会先落一个
    // 首字，那不是名字的一部分。
    expect(
      [...container.querySelectorAll('.welcome-team-name')].map((node) => {
        return node.textContent
      }),
    ).toEqual(['Ryen', '小码', '小笔'])
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('.welcome-addressee [aria-pressed]')]
    expect(toggles).toHaveLength(4)
    expect(toggles[toggles.length - 1]?.textContent?.trim()).toBe('小队 · 3 人')
    // 默认必须是 Ryen（个人助理）而不是群发：不选任何东西时这句话只给一个人。
    expect(toggles[0]?.getAttribute('aria-pressed')).toBe('true')
    expect(toggles[toggles.length - 1]?.getAttribute('aria-pressed')).toBe('false')
    // 只有一个 agent 时没有小队可开，这格得是关的而不是点进去才发现。
    await act(async () => {
      root?.unmount()
    })
    await renderWelcome({ agents: [agents[0]!] })
    expect(container.querySelector<HTMLButtonElement>('.welcome-squad')?.disabled).toBe(true)
  })

  it('群场景的 chip 把去向画成头像，单聊场景画成 Ryen', async () => {
    await renderWelcome()
    // 两张小队任务各摆两个头像，一张单聊任务摆一个：点之前就知道发给谁。
    expect(
      chipButton('帮我做一份行业分析 PPT，小队一起上').querySelectorAll('.welcome-task-avatars .avatar'),
    ).toHaveLength(2)
    expect(chipButton('把我上次说的偏好讲给团队听').querySelectorAll('.welcome-task-avatars .avatar')).toHaveLength(2)
    expect(chipButton('帮我整理一份本周周报').querySelectorAll('.welcome-task-avatars .avatar')).toHaveLength(1)
    // 文案不许再说「群里还有另外两位」这种与去向无关的话：整屏都不许出现，
    // 而不是只查某一句（那行引导语已经连同整段说明一起退场了）。
    expect(container.textContent).not.toContain('群里还有另外两位')
  })

  it('点多 agent 的 chip：文案填进框、去向拨到小队，发送时带的也是小队', async () => {
    const sent: Array<[string, WelcomeTarget]> = []
    await renderWelcome({
      onSend: (text: string, target: WelcomeTarget) => {
        sent.push([text, target])
      },
    })
    await act(async () => {
      chipButton('帮我做一份行业分析 PPT，小队一起上').click()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')?.value).toBe(
      '帮我做一份行业分析 PPT，小队一起上',
    )
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')!.click()
      await Promise.resolve()
    })
    expect(sent).toEqual([['帮我做一份行业分析 PPT，小队一起上', { kind: 'group' }]])
  })

  it('点单聊 chip：去向回到单聊，发送时带的也是单聊', async () => {
    const sent: Array<[string, WelcomeTarget]> = []
    await renderWelcome({
      onSend: (text: string, target: WelcomeTarget) => {
        sent.push([text, target])
      },
    })
    await act(async () => {
      chipButton('帮我做一份行业分析 PPT，小队一起上').click()
      await Promise.resolve()
      chipButton('帮我整理一份本周周报').click()
      await Promise.resolve()
    })
    // 回到单聊 = 收件人行上 Ryen 那格重新亮起来，小队胶囊灭掉；不是另一对按钮。
    expect(container.querySelector('.welcome-squad')?.getAttribute('aria-pressed')).toBe('false')
    const ryen = [...container.querySelectorAll<HTMLButtonElement>('.welcome-team-member')].find((node) => {
      return node.textContent?.trim() === 'Ryen'
    })
    expect(ryen?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')!.click()
      await Promise.resolve()
    })
    expect(sent).toEqual([['帮我整理一份本周周报', { kind: 'direct' }]])
  })

  it('首屏层级：凭据卡排在输入框之前（硬前置不能放在页尾）', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WelcomeHome
          ryen={agents[0]}
          agents={agents}
          conversations={[{ ...directChat, unreadCount: 1 }]}
          // 没配凭据：凭据卡必须出现，且排在能打字之前。
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
    const order = [...container.querySelectorAll('.apikey-card, .welcome-compose, .welcome-recent, .welcome-chip')]
    const at = (selector: string): number => {
      return order.findIndex((node) => {
        return node.matches(selector)
      })
    }
    // 新用户前三分钟的自然路径必须是"先解决前置，再开口"，不是"先失败一次"。
    expect(at('.apikey-card')).toBeGreaterThanOrEqual(0)
    expect(at('.welcome-compose')).toBeGreaterThan(at('.apikey-card'))
    // 待办行与起步建议都排在输入 dock 之前：先让人看见有人在等、或有什么活可以起步，
    // 再把话打进框里；凭据卡仍然是这一切之前的硬前置。
    expect(at('.welcome-recent')).toBeGreaterThanOrEqual(0)
    expect(at('.welcome-recent')).toBeLessThan(at('.welcome-compose'))
    expect(at('.welcome-chip')).toBeLessThan(at('.welcome-compose'))
    expect(at('.welcome-recent')).toBeLessThan(at('.welcome-chip'))
    // 没有可用来源就别假装能聊：发送键是禁用的。
    expect(container.querySelector<HTMLButtonElement>('.send-btn')?.disabled).toBe(true)
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
    ;(window as unknown as Record<string, unknown>).__RYHARNESS_API_BASE__ = 'http://127.0.0.1:4200'
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = `${url.pathname}${url.search}`
      recorded.calls.push({ method, path, body: String(init?.body ?? '') })
      const body = ((): unknown => {
        if (path === '/api/agents') return { agents }
        if (path === '/api/agent-templates') return { templates: [] }
        if (path === '/api/providers') {
          // 首屏现在以「有没有可用来源」为硬前置：一个都没有时输入框与发送键是禁用的
          // （这正是本文件要验证的护栏），所以这里得有一家配好凭据的，测试才测得到
          // chip 的去向而不是被前置卡拦住。
          return { providers: [{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }] }
        }
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
        // 「我的」页的用量账单：那个用例会切到「我的」页，账单那块会真的去读。
        // 缺了这一条，替身回一个空对象，渲染层读不到 byConversation 就崩——这正是
        // 这次要修的那处（形状对不上要降级，不能整页白掉）。
        if (path.startsWith('/api/usage')) {
          return { byConversation: [], byProvider: [], totals: { input: 0, output: 0, total: 0 } }
        }
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
    delete (window as unknown as Record<string, unknown>).__RYHARNESS_API_BASE__
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

  it('点「帮我做一份行业分析 PPT，小队一起上」：建小队群并把这句话发进那个群（不是 Ryen 单聊）', async () => {
    await renderApp()
    await sendViaChip('帮我做一份行业分析 PPT，小队一起上')
    const posts = created()
    expect(posts).toHaveLength(1)
    const payload = JSON.parse(posts[0]!.body) as { kind: string; memberAgentIds: string[] }
    expect(payload.kind).toBe('group')
    expect(payload.memberAgentIds).toEqual(['ryen', 'coder', 'writer'])
    // 落点：新建的那个群，并且消息真的发进它了。
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('小队')
    expect(posted('new-1')).toHaveLength(1)
    expect(posted('new-1')[0]?.body).toContain('帮我做一份行业分析 PPT，小队一起上')
    expect(posted('c1')).toHaveLength(0)
  })

  it('已有小队群时直接复用，不再建第二个（示例会话不算「已存在的小队」）', async () => {
    // 把示例换成用户自己的小队群。
    recorded.conversations = [{ ...demoGroup, id: 'g9', title: '我们的小队' }, directChat]
    await renderApp()
    await sendViaChip('帮我做一份行业分析 PPT，小队一起上')
    expect(created()).toHaveLength(0)
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('我们的小队')
    expect(posted('g9')[0]?.body).toContain('帮我做一份行业分析 PPT，小队一起上')
  })

  it('示例会话不会被当成小队：群场景另起一个会话', async () => {
    await renderApp()
    await sendViaChip('帮我做一份行业分析 PPT，小队一起上')
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

  it('团队点了小码再发送：建的是与小码的单聊，不是 Ryen', async () => {
    await renderApp()
    const member = [...container.querySelectorAll<HTMLButtonElement>('.welcome-team-member')].find((node) => {
      return node.textContent?.includes('小码')
    })
    if (member === undefined) throw new Error('首屏团队里没有小码')
    await act(async () => {
      member.click()
      await Promise.resolve()
    })
    const textarea = container.querySelector<HTMLTextAreaElement>('.welcome-compose textarea')
    if (textarea === null) throw new Error('首屏没有输入框')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter === undefined) throw new Error('HTMLTextAreaElement.prototype.value 缺少 setter')
      setter.call(textarea, '帮我看一下这个报错')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.send-btn')?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    const posts = created()
    expect(posts).toHaveLength(1)
    const first = posts[0]
    if (first === undefined) throw new Error('没有创建会话的请求')
    const payload = JSON.parse(first.body) as { kind: string; agentId: string }
    expect(payload.kind).toBe('direct')
    expect(payload.agentId).toBe('coder')
    expect(posted('new-1')).toHaveLength(1)
    expect(posted('c1')).toHaveLength(0)
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
    // 收件人行在：托盘不再替用户点开与 Ryen 的单聊，头像排与小队胶囊都在。
    expect(container.querySelectorAll('.welcome-team-member').length).toBeGreaterThan(0)
    expect(container.querySelector('.welcome-squad')).not.toBeNull()
  })

  it('通知点击：事件带哪个会话 id 就切回聊天页并选中那条会话', async () => {
    await renderApp()
    // 先去别的页签：通知点下来时用户可能停在「我的」，不该只把窗口弹起来。
    const meTab = [...container.querySelectorAll<HTMLButtonElement>('.rail-tab')].find((node) => {
      return node.textContent?.includes('我的')
    })
    if (meTab === undefined) throw new Error('导航栏里没有「我的」页签')
    await act(async () => {
      meTab.click()
      await Promise.resolve()
    })
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: 'c1' }))
      await Promise.resolve()
    })
    expect(container.querySelector('.chat-header-info strong')?.textContent).toBe('Ryen')
    // 主进程的重试脚本拿这个标记当落地判据（见 desktop-resident 的脚本测试）。
    expect(document.documentElement.getAttribute('data-ryharness-open-conversation')).toBe('c1')
  })
})
