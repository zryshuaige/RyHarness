// @vitest-environment jsdom
/**
 * 交互 P0 的验收网：
 * 1) 停止生成失败不许假死（回滚 + 一句说明）；
 * 2) 会话 token 用量真的有 UI 消费；
 * 3) 欢迎页首条消息落在 WS 订阅建立之前（先订阅、后发送）；
 * 4) 建群的调度员只能选已勾选成员，不合法就不许建群；
 * 5) 头像选择器能选到品牌橘猫（回归护栏，实现见 ContactsPage.tsx）。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type { AgentDef, ApiClient, Conversation, MessageRow, UsageTotals, WsEvent } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { AvatarPicker, CreateGroupModal } from '../renderer/src/components/ContactsPage.tsx'
import { RightPanel } from '../renderer/src/components/RightPanel.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'
import { bucketOf, ChatStore, type ConversationBucket } from '../renderer/src/store.ts'
import { currentValue, listedValues, pickOption, selectTrigger, triggerLabel } from './select-dom.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent: AgentDef = {
  id: 'ryen',
  name: 'Ryen',
  avatar: 'cat',
  systemPrompt: '你是 Ryen。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: true,
}

const coder: AgentDef = {
  id: 'coder',
  name: 'CodeBot',
  avatar: 'cat',
  systemPrompt: '你是 CodeBot。',
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V3',
  tools: [],
  isBuiltin: false,
}

const writer: AgentDef = { ...coder, id: 'writer', name: '小笔' }

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

function historyRow(): MessageRow {
  return {
    id: 'm1',
    seq: 1,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '历史消息' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  vi.useFakeTimers()
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
      dispatchEvent: () => {
        return false
      },
    }
  })
  // toast 是模块级单例，清干净免得串到下一条用例。
  for (const item of getToasts()) toast.dismiss(item.id)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = undefined
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 受控 textarea 输入：走原生 setter + input 事件（React 受控组件的标准打法）。 */
function typeInto(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('停止生成失败：不许假死', () => {
  let store: ChatStore
  let bucket: ConversationBucket
  let push: (event: WsEvent) => void
  let cancelCalls: number

  function fakeApi(cancel: () => Promise<{ cancelled: boolean }>): ApiClient {
    return {
      messages: () => {
        return Promise.resolve({ messages: [historyRow()] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      postMessage: () => {
        return Promise.resolve({ accepted: true })
      },
      cancelTurn: () => {
        cancelCalls += 1
        return cancel()
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      subscribe: (_id: string, onEvent: (event: WsEvent) => void) => {
        push = onEvent
        return () => {}
      },
    } as unknown as ApiClient
  }

  async function render(cancel: () => Promise<{ cancelled: boolean }>): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(<ChatView api={fakeApi(cancel)} conversation={conversation} agents={[agent]} bucket={bucket} />)
      await Promise.resolve()
    })
    act(() => {
      push({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 1 })
      vi.advanceTimersByTime(50)
    })
  }

  function clickStop(): Promise<void> {
    return act(async () => {
      container.querySelector<HTMLButtonElement>('.stop-btn')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    store = new ChatStore()
    bucket = bucketOf(store)
    cancelCalls = 0
  })

  it('cancelTurn 失败：回滚到「生成中」并 toast 说明，绝不停在「已停止」', async () => {
    await render(() => {
      return Promise.reject(new Error('连接已断开'))
    })
    expect(container.querySelector('.stop-btn')).not.toBeNull()

    await clickStop()
    expect(cancelCalls).toBe(1)

    // 回滚：这一轮其实还在跑，界面必须回到"生成中"——停止按钮与打字指示器都回来。
    const stop = container.querySelector('.stop-btn')
    expect(stop).not.toBeNull()
    expect(stop?.className).not.toContain('is-leaving')
    expect(container.querySelector('.typing-indicator')).not.toBeNull()

    // 「已停止」的说法要退场掉：它已经不成立了。
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS)
    })
    expect(container.querySelector('.stopped-hint')).toBeNull()

    // 并且把原因说出来，不能静默。
    expect(getToasts().some((item) => item.kind === 'error' && item.text.includes('没能停止生成'))).toBe(true)
    expect(container.querySelector('.toast')?.textContent).toContain('没能停止生成')
    expect(container.querySelector('.chat-input-wrap .toast')).not.toBeNull()
  })

  it('cancelTurn 成功：仍然停在「已停止」，不发错误提示（不回归上一批的修法）', async () => {
    await render(() => {
      return Promise.resolve({ cancelled: true })
    })
    await clickStop()
    expect(container.querySelector('.stopped-hint')?.textContent).toContain('已停止')
    act(() => {
      vi.advanceTimersByTime(LEAVE_MS)
    })
    expect(container.querySelector('.stop-btn')).toBeNull()
    expect(getToasts().some((item) => item.kind === 'error')).toBe(false)
  })
})

describe('会话 token 用量：右栏一行带过', () => {
  async function renderPanel(usage: UsageTotals | 'fail'): Promise<void> {
    const api = {
      conversationDetail: () => {
        if (usage === 'fail') return Promise.reject(new Error('boom'))
        return Promise.resolve({ conversation, usage })
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
    } as unknown as ApiClient
    await act(async () => {
      root = createRoot(container)
      root.render(
        <RightPanel
          api={api}
          store={new ChatStore()}
          conversation={conversation}
          agents={[agent]}
          conversations={[conversation]}
          fileUrl={(name) => {
            return `/api/files/${name}`
          }}
          collapsed={false}
          onToggle={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('GET /api/conversations/:id 的 usage 真的被消费出来', async () => {
    await renderPanel({ inputTokens: 9100, outputTokens: 3300, totalTokens: 12400, messages: 5 })
    const label = [...container.querySelectorAll('dt')].map((node) => node.textContent)
    expect(label).toContain('本会话用量')
    const line = [...container.querySelectorAll('dd')].map((node) => node.textContent).join(' ')
    expect(line).toContain('1.2 万字')
    expect(line).toContain('9.1 千字')
    expect(line).toContain('3.3 千字')
  })

  it('还没有任何一轮用量时不占那一行；读失败也不报错、不挡其它信息', async () => {
    await renderPanel({ inputTokens: 0, outputTokens: 0, totalTokens: 0, messages: 0 })
    expect(container.textContent).not.toContain('本会话用量')
    act(() => {
      root?.unmount()
    })
    await renderPanel('fail')
    expect(container.textContent).not.toContain('本会话用量')
    // 资料卡照常在。
    expect(container.textContent).toContain('Ryen')
  })
})

describe('欢迎页首条消息：先订阅、后发送', () => {
  it('ChatView：订阅建立之后才 postMessage，且用户消息立刻上屏', async () => {
    const order: string[] = []
    const posted: string[] = []
    let done = 0
    const api = {
      messages: () => {
        order.push('messages')
        return Promise.resolve({ messages: [historyRow()] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      postMessage: (_id: string, text: string) => {
        order.push('post')
        posted.push(text)
        return Promise.resolve({ accepted: true, streamSeq: 7 })
      },
      cancelTurn: () => {
        return Promise.resolve({ cancelled: true })
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      subscribe: () => {
        order.push('subscribe')
        return () => {}
      },
    } as unknown as ApiClient
    const store = new ChatStore()
    const bucket = bucketOf(store)
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ChatView
          api={api}
          conversation={conversation}
          agents={[agent]}
          bucket={bucket}
          pendingSend={{ conversationId: 'c1', text: '帮我整理本周周报' }}
          onPendingSendDone={() => {
            done += 1
          }}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    // 关键顺序：订阅在发送之前。反过来的话这一轮事件全落在订阅建立之前。
    expect(order.indexOf('subscribe')).toBeLessThan(order.indexOf('post'))
    expect(posted).toEqual(['帮我整理本周周报'])
    expect(done).toBe(1)
    // 用户消息本地即刻可见（不等服务端往返）。
    expect(container.textContent).toContain('帮我整理本周周报')
    // turnIndex 跟着历史走：历史在 turn 0，这条就是新一轮 turn 1。
    expect(store.getSnapshot().messages[0]?.turnIndex).toBe(1)
  })

  it('别处来的会话不消费这条待发消息（conversationId 对不上就不发）', async () => {
    const posted: string[] = []
    const api = {
      messages: () => {
        return Promise.resolve({ messages: [] })
      },
      markRead: () => {
        return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
      },
      listDispatchEvents: () => {
        return Promise.resolve({ events: [] })
      },
      postMessage: (_id: string, text: string) => {
        posted.push(text)
        return Promise.resolve({ accepted: true })
      },
      fileUrl: (name: string) => {
        return `/api/files/${name}`
      },
      subscribe: () => {
        return () => {}
      },
    } as unknown as ApiClient
    await act(async () => {
      root = createRoot(container)
      root.render(
        <ChatView
          api={api}
          conversation={conversation}
          agents={[agent]}
          bucket={bucketOf(new ChatStore())}
          pendingSend={{ conversationId: 'other', text: '不该发出去' }}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(posted).toEqual([])
  })
})

/** 假 WebSocket：只记录"客户端建了连接"这个时点。 */
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

describe('App：欢迎页发出的第一句话', () => {
  const NEW_ID = 'c-new'
  const realWebSocket = globalThis.WebSocket
  const created: Conversation = {
    id: NEW_ID,
    kind: 'direct',
    title: 'Ryen',
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 10,
    updatedAt: 10,
  }

  beforeEach(() => {
    // 真计时器：这条用例要走完整的 fetch 往返。
    vi.useRealTimers()
    window.history.replaceState({}, '', '/?api=http://127.0.0.1:32100')
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket
  })

  it('整条链路：建会话 → 建订阅 → 才 POST；回复事件接得住，消息不丢', async () => {
    const log: string[] = []
    let hasConversation = false
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = url.pathname
      log.push(`${method} ${path}`)
      const reply = (body: unknown): Response =>
        ({
          ok: true,
          status: 200,
          json: () => {
            return Promise.resolve(body)
          },
        }) as unknown as Response
      if (path === '/api/agents') return reply({ agents: [agent] })
      if (path === '/api/agent-templates') return reply({ templates: [] })
      if (path === '/api/providers') {
        return reply({
          providers: [{ id: 'siliconflow', displayName: 'SiliconFlow', apiKeyConfigured: true, models: [] }],
        })
      }
      if (path === '/api/conversations' && method === 'POST') {
        hasConversation = true
        return reply({ conversation: created })
      }
      if (path === '/api/conversations') return reply({ conversations: hasConversation ? [created] : [] })
      if (path === `/api/conversations/${NEW_ID}/messages` && method === 'POST') {
        return reply({ accepted: true, streamSeq: 3 })
      }
      if (path === `/api/conversations/${NEW_ID}/messages`) return reply({ messages: [] })
      if (path === `/api/conversations/${NEW_ID}/read`) return reply({ conversationId: NEW_ID, lastReadSeq: 0 })
      if (path === `/api/conversations/${NEW_ID}/dispatch`) return reply({ events: [] })
      if (path === `/api/conversations/${NEW_ID}`) {
        return reply({
          conversation: created,
          usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200, messages: 2 },
        })
      }
      return reply({})
    })

    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 欢迎页首屏
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    typeInto(textarea!, '帮我整理一份本周周报')

    FakeWebSocket.instances.length = 0
    log.length = 0
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // 用户这句话上屏了，而且落进了新会话。
    expect(container.textContent).toContain('帮我整理一份本周周报')
    const postIndex = log.findIndex((entry) => entry.startsWith('POST /api/conversations/'))
    expect(postIndex).toBeGreaterThanOrEqual(0)
    // WS 建连发生在 POST 之前：先订阅，回复事件才接得住。
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0)
    expect(FakeWebSocket.instances[0]?.url).toContain(NEW_ID)

    // 服务端随后下发的这一轮事件，走的正是刚建好的那条订阅。
    // store 的通知有 40ms 合并窗口，这里用真计时器等它落地。
    await act(async () => {
      FakeWebSocket.instances[0]!.open()
      FakeWebSocket.instances[0]!.emit({
        type: 'message-start',
        conversationId: NEW_ID,
        senderId: 'ryen',
        senderName: 'Ryen',
        turnIndex: 0,
        seq: 1,
      })
      FakeWebSocket.instances[0]!.emit({
        type: 'text-delta',
        conversationId: NEW_ID,
        senderId: 'ryen',
        text: '周报我先按「本周完成 / 风险」两段起。',
        seq: 2,
      })
      FakeWebSocket.instances[0]!.emit({
        type: 'message-done',
        conversationId: NEW_ID,
        senderId: 'ryen',
        turnIndex: 0,
        seq: 3,
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 60)
      })
    })
    expect(container.textContent).toContain('周报我先按「本周完成 / 风险」两段起。')
    // 右栏把这一会话的 token 用量消费出来了。
    expect(container.textContent).toContain('本会话用量')
  })
})

describe('建群：调度员只能是已勾选的成员', () => {
  let submitted: { memberAgentIds: string[]; dispatcherAgentId: string; title: string } | undefined

  async function renderModal(): Promise<void> {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <CreateGroupModal
          agents={[agent, coder, writer]}
          onSubmit={(input) => {
            submitted = input
            return Promise.resolve()
          }}
          onClose={() => {}}
        />,
      )
      await Promise.resolve()
    })
  }

  function checkbox(index: number): HTMLInputElement {
    return container.querySelectorAll<HTMLInputElement>('.member-checks input[type="checkbox"]')[index]!
  }
  /** 调度员那一格的下拉触发器（自绘下拉，不再是原生 `<select>`）。 */
  function dispatcher(): HTMLButtonElement {
    return selectTrigger(container, '调度员')
  }
  function createButton(): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => {
      return node.textContent === '创建'
    })!
  }

  it('初始只有已勾选成员出现在下拉里；取消勾选调度员会同步改选剩下的成员', async () => {
    await renderModal()
    // 默认勾了 Ryen。
    expect(checkbox(0).checked).toBe(true)
    expect(currentValue(container, '调度员')).toBe('ryen')
    expect(listedValues(container, '调度员')).toEqual(['ryen'])

    // 取消勾选调度员本人：下拉只剩还没勾的人，state 必须跟着走。
    // 这时没人可派，触发器显示的是占位说明而不是一个空框（原生 <select> 会退回空白）。
    act(() => {
      checkbox(0).click()
    })
    expect(triggerLabel(container, '调度员')).toBe('先勾选成员')
    expect(dispatcher().disabled).toBe(true)
    expect(createButton().disabled).toBe(true)

    // 勾上 CodeBot：调度员落到第一个已勾成员，建群按钮解禁。
    act(() => {
      checkbox(1).click()
    })
    expect(listedValues(container, '调度员')).toEqual(['coder'])
    expect(currentValue(container, '调度员')).toBe('coder')
    expect(createButton().disabled).toBe(false)

    await act(async () => {
      createButton().click()
      await Promise.resolve()
    })
    expect(submitted?.dispatcherAgentId).toBe('coder')
    expect(submitted?.memberAgentIds).toEqual(['coder'])
  })

  it('勾三个成员时，下拉只列这三个（不可能选到没勾的人）', async () => {
    await renderModal()
    act(() => {
      checkbox(1).click()
      checkbox(2).click()
    })
    expect(listedValues(container, '调度员')).toEqual(['ryen', 'coder', 'writer'])
    // 用户可以改调度员。
    pickOption(container, '调度员', 'writer')
    expect(triggerLabel(container, '调度员')).toBe('小笔')
    expect(currentValue(container, '调度员')).toBe('writer')
  })

  it('一个成员都不勾时不许建群，下拉说明为什么', async () => {
    await renderModal()
    act(() => {
      checkbox(0).click()
    })
    expect(createButton().disabled).toBe(true)
    expect(container.textContent).toContain('先勾选成员')
    expect(dispatcher().disabled).toBe(true)
  })
})

describe('头像选择器：品牌橘猫可达（回归护栏）', () => {
  it('橘猫是第一格且用的是 Cat 母版，不是首字母色块', () => {
    const html = renderToStaticMarkup(<AvatarPicker value="dog" onChange={() => {}} />)
    // 这一屏只列动物立绘 + 吉祥物（人像插画族已移出，否则三套画风同排）；
    // 顺序仍是品牌橘猫 → 立绘 → DiceBear。
    expect(html.indexOf('title="橘猫（RyHarness 品牌）"')).toBeLessThan(
      html.indexOf('title="吉祥物：随机生成的彩色表情脸'),
    )
    expect(html).toContain('avatar-cat')
    expect(html).toContain('<img class="cat cat-circle"')
  })
})
