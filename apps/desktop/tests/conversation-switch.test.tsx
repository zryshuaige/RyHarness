// @vitest-environment jsdom
/**
 * 切会话与断口续接的三条底线：
 *
 * 1. **切会话不丢东西**：草稿（输入了没发的字）、滚动锚点、已加载历史都留在自己的桶里；
 *    切回来一个请求都不重发。
 * 2. **切会话不整棵重挂**：聊天区不卸载（消息区不被清空重来），也不因为换桶重拉历史。
 * 3. **断口续接**：断线缺口只补「之后」的那几条，不是 `reset()` + 重拉整页。
 *
 * 另外钉住两条支撑它们的能力：会话桶的冷热窗口（有上界、有草稿的桶不先被丢）与
 * 订阅者级节流（每个订阅者各自的窗口，不是全店一个 40ms）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentDef,
  ApiClient,
  Conversation,
  MessageRow,
  StampedWsEvent,
  SubscribeOptions,
  WsEvent,
} from '../renderer/src/api.ts'
import { ChatInput } from '../renderer/src/components/ChatInput.tsx'
import { ChatView, fetchSince } from '../renderer/src/components/ChatView.tsx'
import { createBoundedCache, MAX_RENDERED_ROWS } from '../renderer/src/lib/windowed.ts'
import {
  bucketOf,
  ChatStore,
  ConversationBucket,
  ConversationCache,
  MAX_CACHED_CONVERSATIONS,
} from '../renderer/src/store.ts'

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

function conversationOf(id: string): Conversation {
  return {
    id,
    kind: 'direct',
    title: `会话 ${id}`,
    memberAgentIds: ['ryen'],
    lastReadSeq: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

function row(id: string, seq: number, text = '历史'): MessageRow {
  return {
    id,
    seq,
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text }],
    mentions: [],
    turnIndex: seq - 1,
    createdAt: 1000 + seq,
  }
}

/** ChatView 用到的 api 替身：全部由测试驱动，调用次数本身就是断言的一部分。 */
interface Harness {
  api: ApiClient
  push: (event: WsEvent) => void
  gap: () => void
  status: (next: 'open' | 'reconnecting') => void
  messageCalls: { limit?: number; before?: number }[]
}

function makeApi(options: { pages?: Map<string, MessageRow[]> } = {}): Harness {
  const messageCalls: { limit?: number; before?: number }[] = []
  let seq = 0
  let onEvent: (event: StampedWsEvent) => void = () => {}
  let onStatus: (status: 'open' | 'reconnecting') => void = () => {}
  let onGap: () => void = () => {}
  const api = {
    base: 'http://127.0.0.1:1',
    fileUrl: (name: string) => {
      return `/api/files/${name}`
    },
    messages: (conversationId: string, query: { limit?: number; before?: number } = {}) => {
      messageCalls.push(query)
      const all = options.pages?.get(conversationId) ?? []
      const before = query.before ?? Number.POSITIVE_INFINITY
      const rows = all.filter((item) => {
        return (item.seq ?? 0) < before
      })
      return Promise.resolve({ messages: rows.slice(-(query.limit ?? 50)) })
    },
    markRead: () => {
      return Promise.resolve({ conversationId: 'c1', lastReadSeq: 0 })
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
      handlers: SubscribeOptions = {},
    ): (() => void) => {
      onEvent = handler
      onStatus = handlers.onStatus ?? (() => {})
      onGap = handlers.onGap ?? (() => {})
      return () => {
        onEvent = () => {}
      }
    },
  } as Partial<ApiClient> as ApiClient
  return {
    api,
    messageCalls,
    push: (event) => {
      // 测试里的事件不带 seq（服务端握手后才补），这里补一个让它成为合法的事件。
      onEvent({ ...event, seq: ++seq })
    },
    gap: () => {
      onGap()
    },
    status: (next) => {
      onStatus(next)
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
      ...(query === '' ? {} : {}),
    }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await Promise.resolve()
  })
}

/** 宿主：像 App 那样按 conversationId 换桶，但**不给 ChatView 加 key**。 */
function Host(props: { cache: ConversationCache; id: string; api: ApiClient }): React.JSX.Element {
  return (
    <ChatView
      api={props.api}
      conversation={conversationOf(props.id)}
      agents={[agent]}
      bucket={props.cache.bucket(props.id)}
    />
  )
}

function composer(): HTMLTextAreaElement {
  const node = container.querySelector('textarea')
  if (node === null) throw new Error('找不到输入框')
  return node
}

function typeInto(node: HTMLTextAreaElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(node, text)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('切会话：草稿与历史留在自己的桶里', () => {
  it('打了一半的字切走再切回来还在，且切回来不重拉历史', async () => {
    const harness = makeApi({ pages: new Map([['c1', [row('m1', 1, 'c1 的历史')]]]) })
    const cache = new ConversationCache()
    await act(async () => {
      root.render(<Host cache={cache} id="c1" api={harness.api} />)
    })
    await settle(0)
    expect(container.textContent).toContain('c1 的历史')

    typeInto(composer(), '还没发出去的那句')
    expect(cache.bucket('c1').getView().draft).toBe('还没发出去的那句')

    // 切到另一个会话：输入框空了，但 c1 的草稿没被覆盖。
    await act(async () => {
      root.render(<Host cache={cache} id="c2" api={harness.api} />)
    })
    await settle(0)
    expect(composer().value).toBe('')
    expect(cache.bucket('c1').getView().draft).toBe('还没发出去的那句')

    // 切回来：字还在，历史是缓存里那份（一个请求都没多发）。
    const before = harness.messageCalls.length
    await act(async () => {
      root.render(<Host cache={cache} id="c1" api={harness.api} />)
    })
    await settle(0)
    expect(composer().value).toBe('还没发出去的那句')
    expect(container.textContent).toContain('c1 的历史')
    expect(harness.messageCalls.length).toBe(before)
  })

  it('每个会话各记各的滚动锚点（贴底与否、位置）', async () => {
    const cache = new ConversationCache()
    cache.bucket('c1').patch({ scroll: { top: 900, height: 600, atBottom: false } })
    cache.bucket('c2').patch({ scroll: { top: 0, height: 0, atBottom: true } })
    expect(cache.bucket('c1').getView().scroll.top).toBe(900)
    expect(cache.bucket('c2').getView().scroll.atBottom).toBe(true)
    // 切来切去各自的值不串台。
    expect(cache.bucket('c2').getView().scroll.top).toBe(0)
    expect(cache.bucket('c1').getView().scroll.top).toBe(900)
  })
})

describe('断口续接：补之后的那几条，不整页重载', () => {
  it('fetchSince 只取 lastSeq 之后的行；一条都没缺就返回空', async () => {
    const rows = [row('m1', 1), row('m2', 2), row('m3', 3)]
    const seen: { limit?: number; before?: number }[] = []
    const api = {
      messages: (_id: string, query: { limit?: number; before?: number } = {}) => {
        seen.push(query)
        const before = query.before ?? Number.POSITIVE_INFINITY
        return Promise.resolve({ messages: rows.filter((item) => (item.seq ?? 0) < before) })
      },
    } as Partial<ApiClient> as ApiClient

    expect(await fetchSince(api, 'c1', 2)).toHaveLength(1)
    expect(seen[0]?.before).toBeUndefined()
    // 已是最新：没有新行，调用方据此什么都不做（不必清屏重来）。
    expect(await fetchSince(api, 'c1', 3)).toEqual([])
  })

  it('缺口有多深就翻几页，翻到接上已有历史为止', async () => {
    const all: MessageRow[] = []
    for (let seq = 1; seq <= 250; seq++) all.push(row(`m${seq}`, seq))
    const api = {
      messages: (_id: string, query: { limit?: number; before?: number } = {}) => {
        const before = query.before ?? Number.POSITIVE_INFINITY
        return Promise.resolve({ messages: all.filter((item) => (item.seq ?? 0) < before).slice(-(query.limit ?? 50)) })
      },
    } as Partial<ApiClient> as ApiClient

    const fresh = await fetchSince(api, 'c1', 100)
    // 100..250 里，缺的是 101 起；总量 150 条。
    expect(fresh).toHaveLength(150)
    expect(fresh[0]?.seq).toBe(101)
  })

  it('断口到达时：已渲染的消息一条不丢，半截的气泡就地收口，补上的行并进来', async () => {
    const history = [row('m1', 1, '第一条'), row('m2', 2, '第二条')]
    const harness = makeApi({ pages: new Map([['c1', history]]) })
    const cache = new ConversationCache()
    await act(async () => {
      root.render(<Host cache={cache} id="c1" api={harness.api} />)
    })
    await settle(0)

    // 断线那一刻正有半句话在写：message-done 不会再来。
    act(() => {
      harness.push({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 2 })
      harness.push({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '半句' })
    })
    await settle(60)
    expect(container.textContent).toContain('半句')

    // 缺口期间服务端又多落了两条（seq 3/4）。
    const bucket = cache.bucket('c1')
    const store = bucket.store
    const historyBefore = bucket.getView().history.length
    history.push(row('m3', 3, '断线期间写的'), row('m4', 4, '断线期间写的第二句'))
    await act(async () => {
      harness.gap()
    })
    await settle(0)

    // 续接的关键：已有的一条没被 reset 掉，缺的两条补上了。
    expect(container.textContent).toContain('第一条')
    expect(container.textContent).toContain('第二条')
    expect(container.textContent).toContain('断线期间写的')
    // 补上的是历史里缺的那两行（不是流式快照——缺口期间服务端落库的行从历史来）。
    expect(bucket.getView().history.length).toBeGreaterThan(historyBefore)
    // 半截那条被收口：不再停在 done=false（否则输入区永远显示"生成中"）。
    expect(store.getSnapshot().messages.every((message) => message.done)).toBe(true)
    expect(store.getSnapshot().typing).toEqual({})
  })
})

describe('会话桶的冷热窗口', () => {
  it('同一个 id 拿到的永远是同一个桶；超过上界按最久未用逐出', () => {
    const cache = new ConversationCache()
    const first = cache.bucket('c1')
    expect(cache.bucket('c1')).toBe(first)
    for (let i = 0; i < MAX_CACHED_CONVERSATIONS; i++) cache.bucket(`c${i}`)
    expect(cache.size).toBe(MAX_CACHED_CONVERSATIONS)
    // 再多一个：最久没碰的那个（c0）被丢。
    cache.bucket('extra')
    expect(cache.size).toBe(MAX_CACHED_CONVERSATIONS)
    expect(cache.bucket('c0')).not.toBe(first)
  })

  it('有草稿的桶最后才被逐出（用户正在写的话比省几 MB 内存贵）', () => {
    const cache = new ConversationCache()
    cache.bucket('c0').setDraft('写了一半')
    for (let i = 1; i < MAX_CACHED_CONVERSATIONS; i++) cache.bucket(`c${i}`)
    const draft = cache.bucket('c0')
    cache.bucket('extra')
    // 草稿还在窗口里，被挤出去的是没草稿的那些。
    expect(cache.bucket('c0')).toBe(draft)
    expect(draft.getView().draft).toBe('写了一半')
  })

  it('被逐出的桶连同它的定时器与订阅一起停掉（不留下孤儿）', () => {
    const cache = new ConversationCache()
    const bucket = cache.bucket('c0')
    let notified = 0
    bucket.store.subscribe(() => {
      notified += 1
    })
    for (let i = 1; i < MAX_CACHED_CONVERSATIONS; i++) cache.bucket(`c${i}`)
    for (let i = 0; i < MAX_CACHED_CONVERSATIONS + 2; i++) cache.bucket(`more-${i}`)
    // c0 已经被挤出窗口：dispose 过，订阅者不再被叫醒。
    bucket.store.apply({
      type: 'message-start',
      conversationId: 'c0',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 0,
    })
    expect(notified).toBe(0)
  })

  it('agent 名单对已缓存与新建的桶都生效（流式气泡里的名字要正确）', () => {
    const cache = new ConversationCache()
    const old = cache.bucket('c1')
    cache.setAgentNames(new Map([['ryen', '橘猫管家']]))
    old.store.apply({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'ryen', turnIndex: 0 })
    expect(old.store.getSnapshot().messages[0]?.senderName).toBe('橘猫管家')
    const fresh = cache.bucket('c2')
    fresh.store.apply({
      type: 'message-start',
      conversationId: 'c2',
      senderId: 'ryen',
      senderName: 'ryen',
      turnIndex: 0,
    })
    expect(fresh.store.getSnapshot().messages[0]?.senderName).toBe('橘猫管家')
  })

  it('patch 逐字段比身份：值没变不通知（滚动与输入都是高频路径）', () => {
    const bucket = bucketOf(new ChatStore())
    let notified = 0
    bucket.subscribe(() => {
      notified += 1
    })
    const anchor = bucket.getView().scroll
    // 滚动是每帧都在走的路径：新对象但值一样（scroll 逐字段比），不该惊动订阅者。
    bucket.patch({ scroll: { ...anchor, height: anchor.height } })
    bucket.patch({ stopped: false })
    expect(notified).toBe(0)
    bucket.patch({ scroll: { ...anchor, top: 120, atBottom: false } })
    expect(notified).toBe(1)
    bucket.setDraft('a')
    bucket.setDraft('a')
    expect(notified).toBe(2)
  })
})

describe('createBoundedCache（窗口化的另一处用武之地）', () => {
  it('命中即刷新，逐出按最久未用', () => {
    const evicted: string[] = []
    const cache = createBoundedCache<string, { id: string }>(2, {
      onEvict: (value) => {
        evicted.push(value.id)
      },
    })
    const a = cache.require('a', () => {
      return { id: 'a' }
    })
    cache.require('b', () => {
      return { id: 'b' }
    })
    cache.require('a', () => {
      throw new Error('命中时不应重建')
    })
    cache.require('c', () => {
      return { id: 'c' }
    })
    expect(evicted).toEqual(['b'])
    expect(
      cache.require('a', () => {
        throw new Error('不该被逐出')
      }),
    ).toBe(a)
    expect(cache.size).toBe(2)
  })

  it('全在保命名单里时仍然守住上界（宁可丢最久未用的）', () => {
    const cache = createBoundedCache<string, { keep: boolean }>(2, {
      protected: (value) => value.keep,
    })
    cache.require('a', () => {
      return { keep: true }
    })
    cache.require('b', () => {
      return { keep: true }
    })
    cache.require('c', () => {
      return { keep: true }
    })
    expect(cache.size).toBe(2)
    expect(cache.has('a')).toBe(false)
  })
})

describe('订阅者级节流', () => {
  it('每个订阅者各自的窗口：面板 200ms 不被每 40ms 的 token 带着醒', () => {
    const store = new ChatStore()
    let fast = 0
    let slow = 0
    store.subscribe(() => {
      fast += 1
    })
    store.subscribeThrottled(() => {
      slow += 1
    }, 200)

    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    for (let i = 0; i < 50; i++) {
      store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: `字${i}` })
    }
    vi.advanceTimersByTime(40)
    // 基础档照旧合并（fast 明显少于事件数），慢的那位只在窗口边界醒。
    expect(fast).toBeGreaterThan(0)
    expect(fast).toBeLessThan(store.metrics().events)
    expect(slow).toBeLessThanOrEqual(2)
    vi.advanceTimersByTime(400)
    expect(slow).toBeGreaterThanOrEqual(1)
  })

  it('退订后不再被通知，排队的通知也会被撤掉', () => {
    const store = new ChatStore()
    let calls = 0
    const off = store.subscribeThrottled(() => {
      calls += 1
    }, 500)
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    vi.advanceTimersByTime(40)
    const seen = calls
    off()
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: 'x' })
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(seen)
  })

  it('dispose 之后 store 不再通知任何人（逐出会话桶时会走这里）', () => {
    const store = new ChatStore()
    let calls = 0
    store.subscribeThrottled(() => {
      calls += 1
    }, 100)
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    vi.advanceTimersByTime(40)
    const seen = calls
    store.dispose()
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: 'x' })
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(seen)
  })
})

describe('ChatStore.sealIncomplete', () => {
  it('把没写完的消息收口并清掉 typing（断口与中止共用这条路）', () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    expect(store.getSnapshot().typing.ryen).toBe(1)
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '半句' })
    store.sealIncomplete()
    expect(store.getSnapshot().messages[0]?.done).toBe(true)
    expect(store.getSnapshot().typing).toEqual({})
    // 已经收口过再收一次是幂等的：不多一次重绘。
    const before = store.metrics().flushes
    store.sealIncomplete()
    expect(store.metrics().flushes).toBe(before)
  })
})

describe('ChatInput 不再跟着消息流每帧重渲染', () => {
  it('ChatInput 是 memo 组件，且 props 身份不变时不重渲染（输入框 ref 会重设 style.height）', async () => {
    // 结构：memo 化是「跟着重渲染不重排」的前提，写死免得哪天有人去掉 memo。
    expect(typeof ChatInput).toBe('object')

    const harness = makeApi()
    const cache = new ConversationCache()
    await act(async () => {
      root.render(<Host cache={cache} id="c1" api={harness.api} />)
    })
    await settle(0)

    const node = composer()
    let mutations = 0
    const observer = new MutationObserver((records) => {
      mutations += records.length
    })
    observer.observe(node, { attributes: true, attributeFilter: ['style'] })
    // 先确认探针本身是有效的：此刻手动改一次 style，必须能被记到。
    node.style.height = '42px'
    await act(async () => {
      await Promise.resolve()
    })
    mutations += observer.takeRecords().length
    expect(mutations).toBeGreaterThan(0)
    // 先让「这一轮开始」这一次必要的重渲染发生（停止按钮要出现）。
    act(() => {
      harness.push({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    })
    await settle(200)
    mutations += observer.takeRecords().length
    mutations = 0

    // 然后是一串 token：消息区在重绘，输入框一步都不该动。
    act(() => {
      for (let i = 0; i < 20; i++) {
        harness.push({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: `字${i}` })
      }
    })
    await settle(200)
    mutations += observer.takeRecords().length
    observer.disconnect()
    // 输入框的 ref 每次渲染都会重设 textarea 的 style.height：所以「一次重渲染都没有」
    // 就是「memo 真的挡住了」。草稿也必须还在（memo 不等于丢内容）。
    expect(mutations).toBe(0)
    expect(composer().value).toBe('')
    // 窗口化本身仍然在工作（顺带钉住这个常量的语义没被改坏）。
    expect(MAX_RENDERED_ROWS).toBeGreaterThan(0)
  })
})

describe('桶的类型出口', () => {
  it('bucketOf 把外部已有的 store 包成桶（流式状态是同一个）', () => {
    const store = new ChatStore()
    const bucket = bucketOf(store)
    expect(bucket.store).toBe(store)
    const other = new ConversationBucket('x')
    expect(other.id).toBe('x')
  })
})
