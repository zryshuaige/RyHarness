// @vitest-environment jsdom
/**
 * 聊天区的滚动仲裁：上滚脱离贴底、流式续写不回拽、滚回底部恢复跟随、翻页前插不跳。
 *
 * 真机上量到的病根有两条，都在这里钉住：
 * 1. **scroll 事件被当成用户滚动**——程序化写 scrollTop 与浏览器夹取都会派发 scroll，
 *    于是长会话往上一滚，scrollTop 在 10107/11525/12522 之间死循环，用户看到的是
 *    「滚不动」。规则：只有真实输入（滚轮/触摸/按下）之后的 scroll 事件才允许改贴底。
 * 2. **浏览器自带的滚动锚定**——Chromium 默认 overflow-anchor: auto，会在上哨兵高度
 *    变化时把视口拽回去，与本组件自己的锚定（窗口补偿 + 翻页还原）互相打架，把视口
 *    卡死在离底部几千像素处。jsdom 没有布局，量不出来，只能钉住那条声明（见文末）。
 *
 * jsdom 没有布局，所以滚动容器的几何换成受控桩，并且刻意照着浏览器的三条行为做：
 * scrollHeight 按 DOM 结构算（上下哨兵 + 已渲染的 turn 块）、写越界的 scrollTop 会被
 * 夹回合法范围、写入会**异步派发 scroll 事件**。少了最后一条，「程序化位移触发滚动
 * 事件」这条因果链在测试里根本不存在，测的就不是真出问题的那条路径。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
// 路径走 fs 而不是 URL：jsdom 环境会把全局 URL 换成 whatwg 实现，import.meta.url
// 在它那儿解析不出 file: 协议（与 design-system.test.tsx 同一处坑）。
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AgentDef,
  ApiClient,
  type Conversation,
  type MessageRow,
  type StampedWsEvent,
  type WsEvent,
} from '../renderer/src/api.ts'
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

/** 一条历史消息行：每 seq 一轮（窗口化按轮算）。 */
function row(seq: number): MessageRow {
  return {
    id: `m${seq}`,
    seq,
    conversationId: 'c1',
    senderType: seq % 2 === 0 ? 'user' : 'agent',
    senderId: seq % 2 === 0 ? undefined : 'ryen',
    contentBlocks: [{ type: 'text', text: `第 ${seq} 条` }],
    mentions: [],
    turnIndex: seq - 1,
    createdAt: 1000 + seq,
  }
}

/** 首屏一页（服务端一页 50 条）：比窗口化门槛高，窗口化与触顶翻页都得上场。 */
const FIRST_PAGE = Array.from({ length: 50 }, (_, index) => {
  return row(index + 1)
})
/** 往回翻一页的 50 条。 */
const EARLIER_PAGE = Array.from({ length: 50 }, (_, index) => {
  return row(index - 49)
})

/**
 * jsdom 没有布局：一个 turn 块按固定高度算（只看块数，不看真实像素）。
 *
 * 这个高度**刻意远大于**组件里的每轮估算（约 88px）：真实气泡有长有短，一条十行的
 * 方案就够把一轮顶到几百像素。估算偏低时，「滚动位置 ÷ 每轮高度」换算出的轮号会虚高，
 * 窗口一路塌到最后一条——内容骤缩，浏览器把越界的 scrollTop 夹回底部，用户刚往上滚
 * 就被拽回最下面（真机症状）。组件现在改用量出来的真实高度，窗口始终盖得住视口，
 * 于是这里用多大的行高都该滚得动。
 */
const TURN_BLOCK_PX = 400
/** 可视高度固定，滚动距离全靠内容高度变化。 */
const VIEWPORT_PX = 480

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let store: ChatStore
let bucket: ConversationBucket
let push: (event: WsEvent) => void
let earlierCalls: (number | undefined)[]
/** 前插发生前一刻的内容高度：视口还原就该按这个差值把 scrollTop 推下去。 */
let heightBeforePrepend: number
/** 测试自己掌握的帧队列（见 flushFrames）。 */
let frameQueue: [number, FrameRequestCallback][]
let frames: Set<number>
let frameSeq: number
/** scrollTop 的写入次数：合帧的效果就量在它身上。 */
let scrollWrites: number

/** 滚动容器的受控几何。 */
interface Scroller {
  node: HTMLElement
  /** 当前 scrollTop（可写：模拟用户滚动 / 程序化位移）。 */
  top: number
  /** 浏览器允许的最大 scrollTop。 */
  max(): number
  height(): number
  /** 内容又高了一点（流式把一行行字写出来 / 图片加载完）。 */
  grow(px: number): void
  /** 布局后按浏览器那样把越界的 scrollTop 夹回去（夹取同样会派发 scroll 事件）。 */
  clamp(): void
}

let scroller: Scroller

function installScroller(node: HTMLElement): Scroller {
  let scrollTop = 0
  let extra = 0
  /** 内容高度 = 上下哨兵 + 已渲染的 turn 块（与真实布局同一套结构）。 */
  const height = (): number => {
    const col = node.querySelector('.chat-col')
    if (col === null) return 0
    let total = 0
    for (const child of Array.from(col.children)) {
      const element = child as HTMLElement
      if (element.getAttribute('aria-hidden') === 'true') total += Number.parseFloat(element.style.height || '0')
      else if (element.classList.contains('turn-block')) total += TURN_BLOCK_PX
    }
    return total + extra
  }
  const box: Scroller = {
    node,
    get top() {
      return scrollTop
    },
    set top(value: number) {
      node.scrollTop = value
    },
    max: () => {
      return Math.max(0, height() - VIEWPORT_PX)
    },
    height,
    grow: (px: number) => {
      extra += px
    },
    clamp: () => {
      // 浏览器在布局后夹取：内容变矮时 scrollTop 会被拉回合法范围，并派发 scroll。
      const next = Math.min(box.max(), Math.max(0, scrollTop))
      if (next === scrollTop) return
      scrollTop = next
      scrollWrites += 1
      window.setTimeout(() => {
        node.dispatchEvent(new Event('scroll'))
      }, 0)
    },
  }
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: VIEWPORT_PX })
  Object.defineProperty(node, 'scrollHeight', {
    configurable: true,
    get: () => {
      return height()
    },
  })
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: () => {
      return scrollTop
    },
    set: (value: number) => {
      // 浏览器会把越界的 scrollTop 夹回 [0, scrollHeight - clientHeight]，夹取同样会
      // 派发 scroll 事件——正是这一下把「跟着底部」的状态又判了回去。
      const next = Math.min(box.max(), Math.max(0, value))
      if (next === scrollTop) return
      scrollTop = next
      scrollWrites += 1
      window.setTimeout(() => {
        node.dispatchEvent(new Event('scroll'))
      }, 0)
    },
  })
  return box
}

/**
 * 真 ApiClient + 只桩 ChatView 真正用到的那几个方法：整份接口替身既要跟着类型走，
 * 又会把「这个测试到底依赖哪几个方法」糊掉。
 */
function fakeApi(): ApiClient {
  const api = new ApiClient('http://api.test')
  vi.spyOn(api, 'messages').mockImplementation((_id, opts = {}) => {
    if (opts.before === undefined) return Promise.resolve({ messages: FIRST_PAGE })
    earlierCalls.push(opts.before)
    // 请求发出时 DOM 还是旧的：这一刻的高度就是视口还原的基准。
    heightBeforePrepend = scroller.height()
    return Promise.resolve({ messages: EARLIER_PAGE })
  })
  vi.spyOn(api, 'markRead').mockResolvedValue({ conversationId: 'c1', lastReadSeq: 1 })
  vi.spyOn(api, 'listDispatchEvents').mockResolvedValue({ events: [] })
  vi.spyOn(api, 'postMessage').mockResolvedValue({ accepted: true })
  vi.spyOn(api, 'cancelTurn').mockResolvedValue({ cancelled: true })
  vi.spyOn(api, 'fileUrl').mockImplementation((name: string) => {
    return `/api/files/${name}`
  })
  vi.spyOn(api, 'subscribe').mockImplementation((_id, onEvent) => {
    // 服务端会给每条事件附一个每会话单调递增的 seq（渲染层据此查断线缺口），
    // 测试里补一个：这里量的就是它收到的那份形状。
    let seq = 0
    push = (event: WsEvent) => {
      seq += 1
      onEvent({ ...event, seq } as StampedWsEvent)
    }
    return () => {}
  })
  return api
}

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<ChatView api={fakeApi()} conversation={conversation} agents={[agent]} bucket={bucket} />)
    await Promise.resolve()
  })
  const node = container.querySelector<HTMLElement>('.chat-scroll')
  if (node === null) throw new Error('聊天区没渲染出来')
  scroller = installScroller(node)
  await settle(20)
}

/** 推进定时器 + 冲掉排队的 rAF 回调（跟随底部的写入合在帧里）+ 落地微任务。 */
async function settle(ms = 60): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
  // 布局落定后浏览器会把越界的 scrollTop 夹回去（内容变矮时），夹取也会派发 scroll。
  scroller.clamp()
  await act(async () => {
    flushFrames()
    vi.advanceTimersByTime(1)
    await Promise.resolve()
  })
}

/**
 * 冲掉这一帧里排队的 rAF 回调（每帧一次，逐 token 的合帧就靠它量得出来）。
 *
 * rAF 由测试自己掌握而不是交给计时器：这样「一帧里连来 8 个 token」才造得出来——
 * 跟随底部的写入必须合到一帧一次，而不是每来一个 token 同步写一次 scrollTop。
 */
function flushFrames(): void {
  const queued = frameQueue.splice(0, frameQueue.length)
  for (const [id, callback] of queued) {
    frames.delete(id)
    callback(performance.now())
  }
}

/** 用户真的滚了一下：先打输入标记，再让浏览器那样派发 scroll。 */
async function userScrollTo(top: number): Promise<void> {
  await act(async () => {
    scroller.node.dispatchEvent(new WheelEvent('wheel', { deltaY: top - scroller.top, bubbles: true }))
    scroller.top = top
    await Promise.resolve()
  })
  await settle()
}

/** 内容又长高了一点：流式写出一行字、或一条图片气泡加载完。 */
async function grow(px: number): Promise<void> {
  await act(async () => {
    scroller.grow(px)
    await Promise.resolve()
  })
}

beforeEach(() => {
  // performance 也一起假：滚动仲裁里「离上次用户输入过了多久」量的是它，量真时间的话
  // 断言就成了竞速（用例快慢一变，红绿就跟着变）。
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
      'performance',
    ],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  store = new ChatStore()
  bucket = bucketOf(store)
  earlierCalls = []
  heightBeforePrepend = 0
  scrollWrites = 0
  frameQueue = []
  frames = new Set<number>()
  frameSeq = 0
  // rAF 交给测试掌握：合帧这件事只有在「一帧内来多个 token」时才量得出来。
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frameSeq += 1
    frames.add(frameSeq)
    frameQueue.push([frameSeq, callback])
    return frameSeq
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    frames.delete(id)
    const index = frameQueue.findIndex((frame) => {
      return frame[0] === id
    })
    if (index >= 0) frameQueue.splice(index, 1)
  })
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

describe('滚动仲裁', () => {
  it('用户上滚立即脱离贴底：之后的内容变化不再把他拽回底部', async () => {
    await render()
    // 打开会话时贴着底部。
    expect(scroller.top).toBe(scroller.max())

    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)
    expect(scroller.top).toBe(up)
    // 「跳至最新」出现 = 已经脱离贴底。
    expect(container.querySelector('.jump-latest')).not.toBeNull()

    // 内容变高（又来了一条消息）不该拽视口。
    await grow(300)
    await settle()
    expect(scroller.top).toBe(up)
  })

  it('真实高度远超估算：窗口不会塌到最后一条（塌了内容骤缩，视口就被夹回底部）', async () => {
    await render()
    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)
    // 塌了的标志：窗口只剩最后一条，页面看着像空了。
    expect(container.querySelectorAll('.turn-block').length).toBeGreaterThan(1)
    // 位置还在用户放的地方：没被夹回底部。
    expect(scroller.top).toBe(up)
    expect(scroller.top).toBeLessThan(scroller.max())
  })

  it('浏览器夹取 scrollTop 造成的滚动不改贴底状态（真机上就是这一步把人锁死在底部）', async () => {
    await render()
    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)

    // 窗口化把渲染内容换小、内容整体变矮：浏览器把越界的 scrollTop 夹回来并派发
    // scroll。旧实现把这个事件当成用户滚动 → 此刻距底为 0 → 判回贴底 → 对齐 effect
    // 随即再写一次 scrollTop，于是 scrollTop 在几个值之间永远来回。
    await act(async () => {
      scroller.node.scrollTop = 10_000_000
      await Promise.resolve()
    })
    await settle(400)

    // 夹取之后仍然是「用户在上翻」的语义：按钮还在，继续上滚也走得动。
    expect(container.querySelector('.jump-latest')).not.toBeNull()
    const further = up - 400
    await userScrollTo(further)
    expect(scroller.top).toBe(further)
  })

  it('程序化位移引起的滚动事件不改贴底状态（输入不是用户给的，就不该改判）', async () => {
    await render()
    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)
    expect(container.querySelector('.jump-latest')).not.toBeNull()
    // 越过「用户输入有效期」（组件里是 300ms）：用户已经停手，此刻到来的滚动事件
    // 都不是他给的。
    await settle(400)

    // 窗口化在贴底态下只渲染末尾一屏，内容会塌到视口之下，浏览器把 scrollTop 夹到
    // 底部——这一刻随 scroll 事件量到的距底距离是 0。旧实现把它当成「用户滚到了底」，
    // 于是判回贴底、对齐 effect 随即再写一次 scrollTop，循环就此合上：真机上就是
    // scrollTop 在 10107/11525/12522 之间永远来回、气泡数在 1 与 25 之间反复重排。
    await act(async () => {
      scroller.node.scrollTop = scroller.max()
      await Promise.resolve()
    })
    // 两趟推进：第一趟把滚动事件与随后的退场计时器排上，第二趟走完退场动画。
    await settle(LEAVE_MS + 10)
    await settle(LEAVE_MS + 10)

    // 贴底状态本身没被改（判据看桶里的锚点，不看退场动画里的按钮）。
    expect(bucket.getView().scroll.atBottom).toBe(false)
    expect(container.querySelector('.jump-latest')).not.toBeNull()
  })

  it('流式继续输出时不上拽视口：每个 token 只让内容变高，视口原地不动', async () => {
    await render()
    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)

    for (let i = 0; i < 12; i++) {
      await act(async () => {
        push({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 50 })
        push({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: `第 ${i} 个 token` })
        vi.advanceTimersByTime(20)
        await Promise.resolve()
      })
      await settle(20)
      await grow(30)
      expect(scroller.top).toBe(up)
    }
  })

  it('流式的一帧里连来多个 token：跟随只写一次 scrollTop（合帧，不是逐 token 同步写）', async () => {
    await render()
    await userScrollTo(scroller.max() - 50)
    await settle()
    scrollWrites = 0

    // 一帧之内（不冲帧）连来 8 个 token：store 会合帧通知，但 effect 仍会跑多次。
    await act(async () => {
      for (let i = 0; i < 8; i++) {
        push({ type: 'text-delta', conversationId: 'c1', senderId: 'ryen', text: `第 ${i} 个 token` })
        scroller.grow(20)
        vi.advanceTimersByTime(45)
        await Promise.resolve()
      }
    })
    // 逐 token 同步写滚动的话，这里已经是 8 次强制布局；合帧后这一帧只写一次。
    await act(async () => {
      flushFrames()
      await Promise.resolve()
    })
    expect(scrollWrites).toBeLessThanOrEqual(1)
    expect(scroller.top).toBe(scroller.max())
  })

  it('用户自己滚回底部就恢复跟随：之后的新 token 继续被跟随', async () => {
    await render()
    await userScrollTo(Math.round(scroller.max() / 2))
    expect(container.querySelector('.jump-latest')).not.toBeNull()

    // 距底 < 100px：重新进入跟随态（「跳至最新」走完退场动画后卸载）。
    const target = scroller.max() - 50
    await userScrollTo(target)
    await settle(LEAVE_MS + 10)
    expect(container.querySelector('.jump-latest')).toBeNull()

    // 新 token 到达（内容随它变高）：视口被跟到新的底部。
    await act(async () => {
      push({ type: 'message-start', conversationId: 'c1', senderId: 'ryen', senderName: 'Ryen', turnIndex: 50 })
      scroller.grow(400)
      vi.advanceTimersByTime(20)
      await Promise.resolve()
    })
    await settle()
    expect(scroller.top).toBe(scroller.max())
  })

  it('触顶自动翻页前插后视口稳定：用户看到的那条消息不跳', async () => {
    await render()
    const up = Math.round(scroller.max() / 2)
    await userScrollTo(up)
    // 滚到顶：自动翻页（before 游标）被触发，前插 50 条。
    await userScrollTo(100)
    await settle(200)
    expect(earlierCalls).toEqual([1])

    // 视口只允许被「内容上方长高」这一次性推下去，且推的量正好等于高度差。
    // 用近似比较而不是精确相等：每轮高度现在是**量出来的**（不是估的整数），高度差
    // 带着浮点尾数，精确相等会让这条用例被 1e-11 的误差顶红。
    const growth = scroller.height() - heightBeforePrepend
    expect(growth).toBeGreaterThan(0)
    expect(scroller.top).toBeCloseTo(100 + growth, 5)

    // 继续上滚仍然是用户说了算：不被回拽。
    await userScrollTo(300)
    expect(scroller.top).toBe(300)
  })

  it('翻页还原不会把自己判回贴底（否则翻一页就又「滚不动」）', async () => {
    await render()
    await userScrollTo(100)
    await settle(200)
    expect(earlierCalls).toEqual([1])

    // 前插把视口推到了离底很远的位置：仍然是「用户在上翻」的语义。
    expect(scroller.top).toBeLessThan(scroller.max())
    expect(container.querySelector('.jump-latest')).not.toBeNull()
  })
})

describe('滚动容器的 CSS 约定', () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/src/styles.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  it('.chat-scroll 关掉浏览器自带的滚动锚定：锚定是 ChatView 自己的活，两套不能同时干', () => {
    // 真机 A/B：默认 auto 时往上一滚就卡死在 11099（1000+ 次 scroll 事件里视口不动），
    // 关掉后同样的操作一路滚到 0 并加载完 5 页历史。
    const rule = css.match(/\.chat-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/overflow-anchor:\s*none/)
  })

  it('也不给 .chat-scroll 设 scroll-behavior：流式跟随必须即时', () => {
    const rule = css.match(/\.chat-scroll\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toMatch(/scroll-behavior:\s*smooth/)
  })
})
