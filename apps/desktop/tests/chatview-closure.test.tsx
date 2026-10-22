// @vitest-environment jsdom
/**
 * 对话闭环：搜索命中定位（around 游标）、发送失败的重试入口、错误条可读化、聊天区窗口化。
 *
 * 全部走真组件：ChatView 的滚动/窗口/定位逻辑都在 effect 与 render 里，只有 api 与
 * fetch 是替身（服务端与网络在这里没有可测的边界价值）。
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDef, ApiClient, Conversation, MessageRow, WsEvent } from '../renderer/src/api.ts'
import { ChatView } from '../renderer/src/components/ChatView.tsx'
import { LEAVE_MS } from '../renderer/src/lib/useLeaving.ts'
import { bucketOf, ChatStore, type ConversationBucket } from '../renderer/src/store.ts'

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

const conversation: Conversation = {
  id: 'c1',
  kind: 'direct',
  title: 'Ryen',
  memberAgentIds: ['ryen'],
  lastReadSeq: 1,
  createdAt: 1,
  updatedAt: 2,
}

/** 一条历史消息行（seq 从 1 起，每轮一条）。 */
function row(id: string, seq: number, text = '历史消息'): MessageRow {
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

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let store: ChatStore
let bucket: ConversationBucket
/** 由测试驱动的 WS 事件泵。 */
let push: (event: WsEvent) => void
/** postMessage 的调用记录与行为（默认成功）。 */
let sent: string[]
let postBehavior: () => Promise<{ accepted: boolean }>
/** 首屏历史（默认一条）。 */
let initialHistory: MessageRow[]
/** 向上翻页（before 游标）的应答；缺省就回首屏那份。 */
let pageReply: (opts: { limit?: number; before?: number }) => MessageRow[]
/** around 请求的 URL 记录 + 应答。 */
let aroundCalls: string[]
let aroundReply: () => { ok: boolean; body: unknown }

function fakeApi(): ApiClient {
  return {
    base: 'http://api.test',
    messages: (_id: string, opts: { limit?: number; before?: number } = {}) => {
      const rows = opts.before === undefined ? initialHistory : pageReply(opts)
      return Promise.resolve({ messages: rows })
    },
    markRead: () => {
      return Promise.resolve({ conversationId: 'c1', lastReadSeq: 1 })
    },
    listDispatchEvents: () => {
      return Promise.resolve({ events: [] })
    },
    postMessage: (_id: string, text: string) => {
      sent.push(text)
      return postBehavior()
    },
    cancelTurn: () => {
      return Promise.resolve({ cancelled: true })
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

async function render(props: { onNavigate?: (target: string) => void } = {}): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} bucket={bucket} {...props} />)
    await Promise.resolve()
  })
}

/** 受控 textarea 输入：走原生 setter + input 事件，光标置于末尾。 */
function typeText(value: string): void {
  const node = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(node, value)
    node.setSelectionRange(value.length, value.length)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter(): void {
  act(() => {
    container
      .querySelector('textarea')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

/** 把一轮 WS 事件与 store 的 40ms 合并通知一起推进。 */
function emit(event: WsEvent): void {
  act(() => {
    push(event)
    vi.advanceTimersByTime(50)
  })
}

/** 推进定时器并把落在微任务里的 Promise 落地（定位、fetch 回包）。 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByText(selector: string, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(selector)].find((node) => {
    return node.textContent?.trim() === text || node.textContent?.includes(text) === true
  })
  if (found === undefined) throw new Error(`找不到按钮：${text}`)
  return found
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  store = new ChatStore()
  bucket = bucketOf(store)
  sent = []
  postBehavior = () => {
    return Promise.resolve({ accepted: true })
  }
  initialHistory = [row('m1', 1)]
  pageReply = () => {
    return initialHistory
  }
  aroundCalls = []
  aroundReply = () => {
    return { ok: true, body: { messages: [row('m1', 1), row('m42', 42), row('m43', 43)] } }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input)
      aroundCalls.push(url)
      const reply = aroundReply()
      return Promise.resolve({
        ok: reply.ok,
        status: reply.ok ? 200 : 404,
        json: () => {
          return Promise.resolve(reply.body)
        },
      })
    }),
  )
  // jsdom 没有 scrollIntoView：定位是否被调用由测试自己断言在桩上。
  Element.prototype.scrollIntoView = vi.fn()
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
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('搜索命中定位（around 游标）', () => {
  it('命中不在已加载页里：向服务端要 around 窗口，插进流里并滚过去高亮', async () => {
    await render()
    // 首屏只有 m1；命中 m42 显然不在里面。
    expect(container.querySelector('[data-message-id="m42"]')).toBeNull()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'c1', messageId: 'm42' } }),
      )
      await Promise.resolve()
    })

    expect(aroundCalls).toHaveLength(1)
    expect(aroundCalls[0]).toContain('around=m42')
    expect(aroundCalls[0]).toContain('/api/conversations/c1/messages')
    await settle(1000)

    const node = container.querySelector('[data-message-id="m42"]')
    expect(node).not.toBeNull()
    expect(node?.classList.contains('is-search-hit')).toBe(true)
    expect(node?.scrollIntoView).toHaveBeenCalled()
    // 定位之后不再贴着底部：新消息不该把用户从这一条上拽走。
    expect(container.querySelector('.jump-latest')).not.toBeNull()
  })

  it('命中已在本地流里时不再发请求（不为已经在眼前的消息打服务端）', async () => {
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'c1', messageId: 'm1' } }),
      )
      await Promise.resolve()
    })
    expect(aroundCalls).toEqual([])
    await settle(1000)
    expect(container.querySelector('[data-message-id="m1"]')?.classList.contains('is-search-hit')).toBe(true)
  })

  it('别的会话的定位事件不理（切会话时旧会话的命中不该拉到这里）', async () => {
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'other', messageId: 'm42' } }),
      )
      await Promise.resolve()
    })
    expect(aroundCalls).toEqual([])
  })

  it('服务端说没有这条消息：如实告诉用户"找不到了"，不假装定位成功也不甩锅服务', async () => {
    aroundReply = () => {
      return { ok: false, body: { error: 'message not found' } }
    }
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'c1', messageId: 'gone' } }),
      )
      await Promise.resolve()
    })
    await settle(1000)
    expect(container.querySelector('.toast')?.textContent).toContain('这条消息已经不在了')
    expect(container.querySelector('[data-message-id="gone"]')).toBeNull()
  })

  it('窗口与已加载页之间留了空洞时补齐：从命中往下滚不该看见"对话少了一段"', async () => {
    // 首屏是最新一页（seq 100），命中的 around 窗口在 40..42 —— 中间是空的。
    initialHistory = [row('m100', 100)]
    aroundReply = () => {
      return { ok: true, body: { messages: [row('m40', 40), row('m41', 41), row('m42', 42)] } }
    }
    const bridgeCalls: number[] = []
    pageReply = (opts) => {
      const before = opts.before ?? 0
      bridgeCalls.push(before)
      // 服务端语义：seq < before 的最新 limit 条。
      const from = Math.max(1, before - 50)
      const rows: MessageRow[] = []
      for (let seq = from; seq < before; seq++) rows.push(row(`m${seq}`, seq))
      return rows
    }
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'c1', messageId: 'm42' } }),
      )
      await Promise.resolve()
    })
    await settle(1000)

    // 空洞用既有 before 游标补：从已加载页最早处往回翻，翻到接上窗口为止。
    expect(bridgeCalls).toEqual([100, 50])

    const seqs = [...container.querySelectorAll('[data-message-id]')]
      .map((node) => {
        return Number(node.getAttribute('data-message-id')?.slice(1))
      })
      .sort((a, b) => {
        return a - b
      })
    // 窗口化只渲染一段，但这段必须连续（没有缺号），且确实补进了窗口之后的消息。
    expect(seqs).toContain(42)
    expect(
      seqs.some((seq) => {
        return seq > 42
      }),
    ).toBe(true)
    for (let index = 1; index < seqs.length; index++) {
      expect(seqs[index]! - seqs[index - 1]!).toBe(1)
    }
  })
})

describe('发送失败要有重试入口', () => {
  it('发不出去的气泡标出失败态，并带一个重发同一轮的重试按钮', async () => {
    postBehavior = () => {
      return Promise.reject(new Error('fetch failed'))
    }
    await render()
    typeText('帮我看看这个')
    pressEnter()
    // 120ms：store 的重绘是 40ms 合并窗口（见 NOTIFY_INTERVAL_MS）。回执的失败是
    // promise 微任务，落点可能正好压在窗口边界上——边界那一侧要再等一个合并窗口，
    // 否则这条断言量的就是「回执落在窗口的哪一相位」，而不是「界面最终有没有失败态」。
    await settle(120)

    // 气泡还在，但它不是"已送达"：红条之外还要在这条消息上自己说清楚。
    const failed = container.querySelector('.chat-hint')
    expect(failed?.textContent).toContain('发送失败')
    expect(failed?.querySelector('button')?.textContent).toBe('重试')
    // 红条说的是人话，不是 fetch failed。
    expect(container.querySelector('.error-banner')?.textContent).toContain('这条消息没发出去')

    // 点重试：同一条消息重发（不是追加一条新消息），成功后才算送达。
    postBehavior = () => {
      return Promise.resolve({ accepted: true })
    }
    act(() => {
      failed!.querySelector<HTMLButtonElement>('button')!.click()
    })
    await settle(120)
    expect(sent).toEqual(['帮我看看这个', '帮我看看这个'])
    expect(container.querySelector('.chat-hint')).toBeNull()
    // 重试没有多出一条消息：仍是原来那一条用户气泡。
    expect(container.querySelectorAll('.bubble-row.from-user')).toHaveLength(1)
    expect(container.querySelector('.bubble-row.from-user')?.textContent).toContain('帮我看看这个')
    // 重试成功不该留下上一轮的错误横幅（退场动画走完即卸载）。
    await settle(LEAVE_MS + 10)
    expect(container.querySelector('.error-banner')).toBeNull()
  })

  it('store 里分得清「已送达」与「发送失败」', () => {
    const key = store.addUserMessage('在吗', 0)
    expect(store.getSnapshot().messages[0]?.delivery).toBe('pending')
    store.setUserMessageDelivery(key, 'failed')
    expect(store.getSnapshot().messages[0]?.delivery).toBe('failed')
    store.setUserMessageDelivery(key, 'sent')
    expect(store.getSnapshot().messages[0]?.delivery).toBe('sent')
    // 状态没变就不重绘整条流。
    const before = store.getSnapshot()
    store.setUserMessageDelivery(key, 'sent')
    expect(store.getSnapshot()).toBe(before)
  })

  it('错误条上的「重试这一轮」重发最后一条用户消息（模型侧失败时的重试）', async () => {
    await render()
    typeText('第一条')
    pressEnter()
    await settle()
    expect(sent).toEqual(['第一条'])
    emit({ type: 'error', conversationId: 'c1', message: '429 慢一点', code: 'RATE_LIMIT' })

    act(() => {
      buttonByText('.error-banner button', '重试这一轮').click()
    })
    await settle()
    expect(sent).toEqual(['第一条', '第一条'])
  })
})

describe('错误条可读化', () => {
  it('凭据类故障说人话、指向模型供应商，并把英文原文从界面上摘掉', async () => {
    const navigated: string[] = []
    await render({
      onNavigate: (target) => {
        navigated.push(target)
      },
    })
    emit({
      type: 'error',
      conversationId: 'c1',
      code: 'MISSING_CREDENTIAL',
      message: '@ryharness/llm-openai: provider "siliconflow" needs its API key in the RYHARNESS_KEY_SILICONFLOW variable',
    })
    const banner = container.querySelector('.error-banner')
    expect(banner?.textContent).toContain('API Key')
    expect(banner?.textContent).not.toContain('RYHARNESS_KEY')
    expect(banner?.textContent).not.toContain('@ryharness/llm-openai')

    act(() => {
      buttonByText('.error-banner button', '去我的 → 模型供应商').click()
    })
    expect(navigated).toEqual(['me'])
  })

  it('宿主没接导航时，动作退化成 ryharness:navigate 窗口事件', async () => {
    await render()
    emit({ type: 'error', conversationId: 'c1', code: 'NOT_FOUND', message: 'model_not_found: qwen-max' })
    const seen: unknown[] = []
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent<{ target?: string }>).detail)
    }
    window.addEventListener('ryharness:navigate', listener)
    act(() => {
      buttonByText('.error-banner button', '去通讯录改 agent').click()
    })
    window.removeEventListener('ryharness:navigate', listener)
    expect(seen).toEqual([{ target: 'contacts' }])
  })

  it('认不出的故障：仍然说人话，并把原文留给开发者', async () => {
    await render()
    emit({ type: 'error', conversationId: 'c1', code: 'UPSTREAM', message: '上游超时' })
    const banner = container.querySelector('.error-banner')
    expect(banner?.textContent).toContain('这一轮没跑起来')
    expect(banner?.textContent).toContain('上游超时')
  })

  it('认不出的故障：原文折进「详情」，不与红条第一行挤在一起', async () => {
    await render()
    emit({
      type: 'error',
      conversationId: 'c1',
      code: 'SOMETHING_NEW',
      message: 'scheduler queue stalled at depth 3',
    })
    const banner = container.querySelector('.error-banner')
    expect(banner).not.toBeNull()
    // 第一眼是人话 + 下一步。
    const visible = banner?.querySelector('strong')?.textContent ?? ''
    expect(visible).toBe('这一轮没跑起来。')
    expect(visible).not.toContain('scheduler queue')
    // 原文在折叠的「详情」里（与 HistoryFailure 同一套 affordance，默认不带 open）。
    const details = banner?.querySelector('details')
    expect(details).not.toBeNull()
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('详情')
    expect(details?.querySelector('code')?.textContent).toContain('scheduler queue stalled at depth 3')
  })
})

describe('聊天区窗口化', () => {
  /** 40 轮（超过窗口化门槛），每轮一条消息。 */
  const long = Array.from({ length: 40 }, (_, index) => {
    return row(`m${index + 1}`, index + 1)
  })

  it('长会话只渲染窗口：上下哨兵撑住滚动条，最新那几条照常在', async () => {
    initialHistory = long
    await render()
    const blocks = container.querySelectorAll('.turn-block')
    expect(blocks.length).toBeGreaterThan(0)
    // 40 轮不可能一次性全在 DOM 里。
    expect(blocks.length).toBeLessThan(40)
    // 贴底打开会话时窗口在末尾：最新那条必须在（否则用户以为消息没到）。
    expect(container.querySelector('[data-message-id="m40"]')).not.toBeNull()
    // 上哨兵把被截掉的上方内容撑起来。
    const sentinels = [...container.querySelectorAll<HTMLElement>('.chat-col > div[aria-hidden="true"]')]
    expect(sentinels.length).toBeGreaterThan(0)
    expect(
      sentinels.some((node) => {
        return Number.parseInt(node.style.height, 10) > 0
      }),
    ).toBe(true)
  })

  it('短会话不窗口化：一次全渲染，行为与此前一致', async () => {
    initialHistory = long.slice(0, 10)
    await render()
    expect(container.querySelectorAll('.turn-block')).toHaveLength(10)
    expect(container.querySelector('.chat-col > div[aria-hidden="true"]')).toBeNull()
  })

  it('流式新消息到达时窗口跟着往下走（贴底的人不会错过新回复）', async () => {
    initialHistory = long
    await render()
    emit({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 40 })
    emit({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: '新回复' })
    emit({ type: 'message-done', conversationId: 'c1', senderId: 'ryen', turnIndex: 40 })
    expect(container.textContent).toContain('新回复')
    // 仍然只渲染一个窗口，没有因为流式追加退回全量渲染。
    expect(container.querySelectorAll('.turn-block').length).toBeLessThan(41)
  })

  it('定位命中落在窗口之外时，先把窗口挪过去再滚（否则"点了没反应"）', async () => {
    initialHistory = long
    await render()
    expect(container.querySelector('[data-message-id="m3"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ryharness:scroll-to-message', { detail: { conversationId: 'c1', messageId: 'm3' } }),
      )
      await Promise.resolve()
    })
    // 命中已在本地流里（首屏就是这 40 条），不该再打服务端。
    expect(aroundCalls).toEqual([])
    await settle(1000)
    const hit = container.querySelector('[data-message-id="m3"]')
    expect(hit).not.toBeNull()
    expect(hit?.scrollIntoView).toHaveBeenCalled()
  })
})
