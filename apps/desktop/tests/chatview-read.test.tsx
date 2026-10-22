// @vitest-environment jsdom
/**
 * 前台会话的未读语义。
 *
 * 服务端的 unreadCount 是「seq > lastReadSeq 的非用户消息条数」，而一条消息里连
 * 工具结果（正文是「〔tool〕名字: 结果」）都算数——一个 turn 里 agent 调五次工具、
 * 接三次力，角标就能涨到七八。可这些消息此刻正摆在用户眼前的这块屏幕上，它们不该
 * 被算成未读。压住角标只有一条路：渲染层持续把 lastReadSeq 推上去，而原先只在
 * 订阅建立时打过一次，整轮对话都不管。
 *
 * 这里钉住三件事：
 * 1. 落到当前活跃会话的新消息（发言、工具结果、接力、报错收尾）会补已读；
 * 2. 高频事件合并——一个 turn 只多一两个 HTTP，不是每条消息一次；
 * 3. 窗口不在前台时不清未读（IM 的常规口径，也是服务端「你有 N 条未读」与主动
 *    消息的事实来源；主进程决定要不要弹通知走的正是同一个 focus 判据），
 *    回到前台再补一次。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../renderer/src/App.tsx'
import type {
  AgentDef,
  ApiClient,
  Conversation,
  MessageRow,
  StampedWsEvent,
  SubscribeOptions,
  WsEvent,
} from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { getToasts, toast } from '../renderer/src/lib/toast.ts'
import { ConversationCache } from '../renderer/src/store.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 已读打点的合并窗口（ms）：一个 turn 里连发的十几条都该落在它里面。 */
const MERGE_MS = 800

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

function conversationOf(id: string): Conversation {
  return {
    id,
    kind: 'group',
    title: `小队 ${id}`,
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

/** 一条 agent 发言（服务端在推 message-done 之前已经把它落库了）。 */
function spoken(turnIndex: number): WsEvent {
  return { type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex }
}

interface Harness {
  api: ApiClient
  push: (event: WsEvent) => void
  /** 每次 POST /read 记一笔会话 id，按发生顺序。 */
  reads: string[]
}

/** ChatView 用到的 api 替身：未读相关的行为全部由测试驱动，调用次数本身就是断言。 */
function makeApi(options: { readFails?: boolean } = {}): Harness {
  const reads: string[] = []
  let seq = 0
  let onEvent: (event: StampedWsEvent) => void = () => {}
  const api = {
    base: 'http://127.0.0.1:1',
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
    messages: () => {
      return Promise.resolve({ messages: [] as MessageRow[] })
    },
    markRead: (conversationId: string) => {
      reads.push(conversationId)
      return options.readFails === true
        ? Promise.reject(new Error('服务没起来'))
        : Promise.resolve({ conversationId, lastReadSeq: 1 })
    },
    listDispatchEvents: () => {
      return Promise.resolve({ events: [] })
    },
    postMessage: () => {
      return Promise.resolve({ accepted: true })
    },
    cancelTurn: () => {
      return Promise.resolve({ cancelled: true })
    },
    subscribe: (
      _conversationId: string,
      handler: (event: StampedWsEvent) => void,
      _handlers: SubscribeOptions = {},
    ): (() => void) => {
      onEvent = handler
      return () => {
        onEvent = () => {}
      }
    },
  } as Partial<ApiClient> as ApiClient
  return {
    api,
    reads,
    push: (event) => {
      onEvent({ ...event, seq: ++seq })
    },
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom 没有真的窗口焦点（hasFocus 恒为 false），这里补成"用户正看着这块屏幕"。
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
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
    root.unmount()
  })
  container.remove()
  for (const item of getToasts()) toast.dismiss(item.id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 推进定时器并把随之落地的 Promise 一并放掉（打点是 setTimeout + 微任务两步）。 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await Promise.resolve()
  })
}

/** 宿主：像 App 那样按 conversationId 换桶，但不给 ChatView 加 key。 */
function Host(props: { cache: ConversationCache; id: string; api: ApiClient; onSeen?: () => void }): React.JSX.Element {
  return (
    <ChatView
      api={props.api}
      conversation={conversationOf(props.id)}
      agents={[agent]}
      bucket={props.cache.bucket(props.id)}
      {...(props.onSeen === undefined ? {} : { onSeen: props.onSeen })}
    />
  )
}

async function mountChat(props: { cache: ConversationCache; id: string; harness: Harness }): Promise<void> {
  await act(async () => {
    root.render(<Host cache={props.cache} id={props.id} api={props.harness.api} />)
  })
  await settle(0)
}

describe('正在看的会话：这一轮的发言不再涨未读', () => {
  it('agent 在当前会话落一条消息，就把这条会话标成已读', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    // 进会话那一次（订阅建立时就该清一次）。
    expect(harness.reads).toEqual(['c1'])

    act(() => {
      harness.push(spoken(1))
    })
    await settle(0)
    expect(harness.reads).toEqual(['c1', 'c1'])
  })

  it('工具结果、接力、报错收尾同样算新消息（它们在服务端也各占一条未读）', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    act(() => {
      harness.push({
        type: 'tool-result',
        conversationId: 'c1',
        senderId: 'ryen',
        callId: 't1',
        name: 'read_file',
        isError: false,
        content: 'ok',
      })
    })
    await settle(MERGE_MS * 2)
    act(() => {
      harness.push({
        type: 'dispatch',
        conversationId: 'c1',
        fromAgent: 'ryen',
        toAgent: '小码',
        reason: '接力',
        turnIndex: 1,
      })
    })
    await settle(MERGE_MS * 2)
    act(() => {
      harness.push({ type: 'error', conversationId: 'c1', message: '炸了', code: 'INTERNAL' })
    })
    await settle(MERGE_MS * 2)

    // 三类事件各补过一次；关键是这里**不是零**——原先整轮只有进会话那一次。
    expect(harness.reads.length).toBeGreaterThan(before)
    expect(
      harness.reads.every((id) => {
        return id === 'c1'
      }),
    ).toBe(true)
  })

  it('一个 turn 里连发的十几条合并掉：首个立刻发，窗口内的并进末尾那一次', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    act(() => {
      harness.push(spoken(1))
    })
    await settle(0)
    // 首个不等窗口：同一轮末尾那份清单刷新不能先于已读落地，否则角标会先涨一下。
    expect(harness.reads.length).toBe(before + 1)

    // 窗口内又落了两条：并进末尾那一次，不能一条一个 HTTP。
    act(() => {
      harness.push(spoken(2))
      harness.push(spoken(3))
    })
    await settle(MERGE_MS / 2)
    expect(harness.reads.length).toBe(before + 1)
    await settle(MERGE_MS)
    expect(harness.reads.length).toBe(before + 2)

    // 再来一轮：先让窗口整个过去，再落一条消息——此时该立刻发，不该再排尾随。
    await settle(MERGE_MS)
    act(() => {
      harness.push(spoken(4))
    })
    await settle(0)
    expect(harness.reads.length).toBe(before + 3)
  })

  it('打点失败不炸界面，下一条消息照样能再打一次', async () => {
    const harness = makeApi({ readFails: true })
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    act(() => {
      harness.push(spoken(1))
    })
    await settle(MERGE_MS * 2)
    act(() => {
      harness.push(spoken(2))
    })
    await settle(MERGE_MS * 2)

    expect(harness.reads.length).toBe(before + 2)
    expect(container.textContent).toContain('小队 c1')
  })
})

describe('窗口不在前台时不清未读', () => {
  it('失焦期间落下的消息留着未读，回到前台补一次', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => {
      harness.push(spoken(1))
      harness.push(spoken(2))
    })
    await settle(MERGE_MS * 3)
    // 看不见的时候清掉，服务端那条「你有 N 条未读」和左栏待办就没了。
    expect(harness.reads.length).toBe(before)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle(MERGE_MS * 2)
    // 回到前台：这几条已经摆在这块屏幕上了。
    expect(harness.reads.length).toBe(before + 1)
  })

  it('最小化（document 变 hidden）同样算不在前台', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    const hidden = { configurable: true, get: () => 'hidden' }
    Object.defineProperty(document, 'visibilityState', hidden)
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      act(() => {
        harness.push(spoken(1))
      })
      await settle(MERGE_MS * 2)
      expect(harness.reads.length).toBe(before)
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    }
    // 从托盘/最小化里回到前台：补一次。
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle(MERGE_MS * 2)
    expect(harness.reads.length).toBe(before + 1)
  })
})

describe('换会话与卸载', () => {
  it('切走时把窗口末尾那一次立刻发掉：这条已读不能因为手快点下一个会话作废', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    const before = harness.reads.length

    act(() => {
      harness.push(spoken(1))
    })
    await settle(0)
    act(() => {
      harness.push(spoken(2))
    })
    await settle(0)
    // 末尾那一次还挂在窗口里没发。
    expect(harness.reads.length).toBe(before + 1)

    const beforeSwitch = harness.reads.length
    await act(async () => {
      root.render(<Host cache={cache} id="c2" api={harness.api} />)
    })
    await settle(0)
    // 切走那一刻立刻补掉，而且补的是**旧**会话 c1（新会话自己会在进会话时打一次）。
    expect(harness.reads.slice(beforeSwitch)).toEqual(['c1', 'c2'])
  })

  it('切走之后再来的新会话事件不会打回旧会话', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    await mountChat({ cache, id: 'c1', harness })
    await act(async () => {
      root.render(<Host cache={cache} id="c2" api={harness.api} />)
    })
    await settle(0)
    harness.push({ ...spoken(9), conversationId: 'c2' })
    await settle(MERGE_MS * 2)
    expect(harness.reads[harness.reads.length - 1]).toBe('c2')
    expect(
      harness.reads.filter((id) => {
        return id === 'c1'
      }),
    ).toHaveLength(1)
  })

  it('本地归零只在真打过之后发生（壳那一侧拿到的是「已看见」而不是猜测）', async () => {
    const harness = makeApi()
    const cache = new ConversationCache()
    let seen = 0
    await act(async () => {
      root.render(
        <Host
          cache={cache}
          id="c1"
          api={harness.api}
          onSeen={() => {
            seen += 1
          }}
        />,
      )
    })
    await settle(0)
    const before = seen

    act(() => {
      harness.push(spoken(1))
    })
    await settle(0)
    expect(seen).toBeGreaterThan(before)

    // 失焦期间不归零：服务端那条数字还指着真实未读，本地不该先把它抹掉。
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => {
      harness.push(spoken(2))
    })
    await settle(MERGE_MS * 2)
    expect(seen).toBe(before + 1)
  })
})

// ---- 壳这一侧：角标不会再被服务端那个脏数字顶回来 ----

/** 主进程注入的地址；列表自建客户端时用的是 32100，两条路径因此可区分。 */
const HOST_BASE = 'http://127.0.0.1:4100'

/** 主进程把 API 地址挂在这个全局上（见 renderer/src/lib/boot.ts）。 */
interface HostWindow extends Window {
  __RYHARNESS_API_BASE__?: string
}

const roster: AgentDef[] = [
  { id: 'ryen', name: 'Ryen', avatar: 'cat', systemPrompt: 'p', provider: 'x', model: 'm', tools: [], isBuiltin: true },
]

/** 假 WebSocket：ChatView 一建订阅就往这里落一个，只记录建连与投递。 */
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
  emit(event: object): void {
    this.onmessage?.({ data: JSON.stringify({ ...event, seq: FakeWebSocket.instances.length }) })
  }
}

const realWebSocket = globalThis.WebSocket

function socketOf(conversationId: string): FakeWebSocket {
  const found = FakeWebSocket.instances.find((socket) => {
    return socket.url.includes(`conversationId=${conversationId}`)
  })
  if (found === undefined) throw new Error(`没有 ${conversationId} 的订阅`)
  return found
}

describe('左栏角标：正在说话的这一轮不会把角标顶上来', () => {
  /** 服务端那一侧的未读：/read 归零，agent 落一条消息 +1。 */
  let unread = 3
  /** agent 已经落库、正等着 WS 推出来的消息条数。 */
  let pending = 0

  beforeEach(() => {
    unread = 3
    pending = 0
    window.history.replaceState({}, '', '/')
    FakeWebSocket.instances = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    ;(window as HostWindow).__RYHARNESS_API_BASE__ = HOST_BASE
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname
      const method = init?.method ?? 'GET'
      const body = ((): unknown => {
        if (path === '/api/agents') return { agents: roster }
        if (path === '/api/agent-templates') return { templates: [] }
        if (path === '/api/providers') return { providers: [] }
        if (path === '/api/conversations' && method === 'GET') {
          return {
            conversations: [
              {
                id: 'c1',
                kind: 'direct',
                title: 'Ryen',
                memberAgentIds: ['ryen'],
                lastReadSeq: 0,
                createdAt: 1,
                updatedAt: 2,
                lastMessagePreview: '把周报整理好了',
                unreadCount: unread,
              },
            ],
          }
        }
        if (path.endsWith('/read')) {
          // 真实服务端在这一步把 lastReadSeq 推到最新，未读随之归零。
          unread = 0
          return { conversationId: 'c1', lastReadSeq: 1 }
        }
        if (path.endsWith('/messages')) return { messages: [] }
        if (path.endsWith('/dispatch')) return { events: [] }
        if (path.startsWith('/api/search')) return { results: [] }
        return {}
      })()
      return {
        ok: true,
        status: 200,
        json: () => {
          return Promise.resolve(body)
        },
      }
    })
  })

  afterEach(() => {
    window.history.replaceState({}, '', '/')
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket
    delete (window as HostWindow).__RYHARNESS_API_BASE__
  })

  it('对话中 agent 回的三条消息不会把角标顶回 2、3', async () => {
    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
    })
    await settle(MERGE_MS * 2)
    expect(container.querySelector('.unread-badge')?.textContent).toBe('3')

    // 点进这个会话：进会话即已读。
    const row = container.querySelector<HTMLButtonElement>('.conversation-item-main')
    if (row === null) throw new Error('会话列表没画出来')
    await act(async () => {
      row.click()
      await Promise.resolve()
    })
    await settle(MERGE_MS * 2)
    expect(container.querySelector('.unread-badge')).toBeNull()

    // 接下来这一轮：agent 连说三条。每条在服务端都落库、都算一条未读。
    for (let index = 0; index < 3; index++) {
      pending += 1
      unread += 1
      const socket = socketOf('c1')
      // 三件事分三次交付：只有真看到「生成中 → 生成完」这一下，壳才会重拉清单，
      // 而那正是角标会回来的时刻。
      act(() => {
        socket.emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 7 })
      })
      act(() => {
        socket.emit({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: `第 ${index + 1} 句` })
      })
      act(() => {
        socket.emit({ type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 7 })
      })
      await settle(MERGE_MS * 3)
      // 服务端那条未读被这一轮的已读打点压回 0，而不是留着等下一次刷新把它显示出来。
      expect(unread).toBe(0)
      expect(container.querySelector('.unread-badge')).toBeNull()
    }
    expect(pending).toBe(3)
  })
})
