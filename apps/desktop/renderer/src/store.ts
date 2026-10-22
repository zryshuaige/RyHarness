/**
 * 轻量会话状态 store：React hooks + useSyncExternalStore。
 * 把 WS 事件流折叠成 UI 状态（消息、流式增量、工具行、产物卡片、接力链、输入中）。
 *
 * 性能约定（整个流式渲染的地基，勿破坏）：
 * 1. **结构共享**：任何一次变更只拷贝「数组本身 + 受影响的那一条消息 + 它的
 *    parts 链」，未受影响的消息与部件保持同一引用。memo 比较器依赖这一点。
 * 2. **version 计数**：每条消息带一个自增版本号，parts/done 变化即自增；UI 层
 *    的相等判断只需比 version（O(1)），不需要序列化。
 * 3. **key 稳定**：message-done 只翻 done 位，不换 key —— 否则 React 卸载重建
 *    整棵子树（重新 lex、DOM 重建、滚动跳变）。
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { MessageRow, WsEvent } from './api.ts'
import { clearDraft, loadDraft, saveDraft } from './lib/drafts.ts'
import { formatSize } from './lib/format.ts'
import { createBoundedCache } from './lib/windowed.ts'
// 启动埋点挂在这个模块上：它是渲染层入口（App.tsx）一定会加载的第一个自有模块，
// 埋点因此从应用启动的第一行代码就开始计，不需要改入口文件。
import './lib/boot-trace.ts'

/** 消息内的一个展示部件。 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      arguments: string
      status: 'running' | 'done'
      isError?: boolean
      /**
       * 工具返回的正文（tool-result 事件的 `content`）。
       *
       * 此前这里只记 status/isError，等于把「agent 到底做了什么、错在哪」整段丢进
       * 垃圾桶：气泡只剩一行「已读文件」。过程可见性是这类产品的信任来源，正文必须
       * 留着；历史消息的 tool 部件没有正文（服务端另存了 〔tool〕 行），故为可选。
       */
      content?: string
    }
  | { kind: 'file'; callId: string; name: string; size: number; mime: string }

/**
 * 用户消息的送达状态。
 *
 * 本地插入的用户气泡与"服务端收下了"是两件事：回执没回来之前它只是屏幕上的一行字。
 * 把这个区别留在 store 里（而不是各自记一份 ref），重发、切换会话、重连补齐之后
 * 才不会出现"发失败的气泡长得跟已送达一模一样"。
 */
export type MessageDelivery =
  /** 已发出，服务端尚未确认。 */
  | 'pending'
  /** 服务端已收下（202 回执）。 */
  | 'sent'
  /** 发出失败，消息没到服务端。 */
  | 'failed'

export interface UiMessage {
  /** React key：流式期间分配后保持不变，message-done 也不换（避免整泡 remount）。 */
  key: string
  senderType: 'user' | 'agent' | 'system'
  senderId: string
  senderName: string
  turnIndex: number
  /** 服务端消息序号（历史消息有；用于向上分页的 before 游标）。 */
  seq?: number
  /** 消息时间（历史消息有；流式消息省略）。 */
  createdAt?: number
  parts: MessagePart[]
  /** 已完整落库（message-done）。 */
  done: boolean
  /**
   * 这条是 agent 主动发来的（服务端每日的回顾，见 apps/server/src/proactive.ts），
   * 不是用户问出来的。UI 据此加「主动找你」的标识——它与用户消息长得一样，就等于
   * 「我什么时候问过这句」这件事在界面上消失了。
   */
  proactive?: boolean
  /** 用户消息的送达状态；agent 消息与历史消息不带（历史天然已落库）。 */
  delivery?: MessageDelivery
  /**
   * 历史里的一轮失败（内核落库的 `[error:CODE] 原文`）。
   *
   * 它不是某个 agent 说的话，而是那一轮没跑起来的记录；UI 据此把它画成失败提示条，
   * 而不是一个普通的 agent 气泡。原文保留在 code/message 里供展开查看，不删除历史。
   */
  failure?: { code: string; message: string }
  /**
   * 内容版本号：store 每次改动该消息的 parts/done 自增，供 memo 比较器 O(1) 判断。
   * 由 store 维护；历史消息（ChatView 的 fromHistory）没有此字段，按 0 处理。
   */
  version?: number
}

/**
 * 用户侧附件的落库元数据，与 file_produce 的产物卡片同构（name/size/mime）：
 * 字节由附件通道落进工作区产物目录，卡片只带元数据，渲染层据此渲染文件消息。
 */
export interface MessageAttachment {
  name: string
  size: number
  mime: string
}

/**
 * 用户消息发往服务端的正文。附件以一行 [附件] 记述带出去：服务端消息体只有
 * 文本字段，agent 侧要看到「有个可读文件落在工作区产物目录」，就得在这里
 * 把文件名与体量说出来，而不是指望前端把字节塞进正文。
 */
export function composeMessageText(text: string, attachments: readonly MessageAttachment[] = []): string {
  const trimmed = text.trim()
  if (attachments.length === 0) return trimmed
  const lines = attachments.map((file) => {
    return `[附件] ${file.name}（${formatSize(file.size)}，${file.mime}）`
  })
  return [trimmed, ...lines]
    .filter((line) => {
      return line.length > 0
    })
    .join('\n')
}

/**
 * 主动消息的内容块标记（与服务端 apps/server/src/proactive.ts 同一约定）。
 *
 * 服务端把它作为独立于 text 的一个块写进消息：正文仍是干净的全文（模型那边只取
 * text 块），而渲染层凭这个块认出「这条是它自己主动说的」。
 */
export const PROACTIVE_BLOCK_TYPE = 'proactive'

/** 这条历史消息是不是 Ryen 主动发来的（服务端每日的回顾）。 */
export function isProactiveRow(row: MessageRow): boolean {
  return row.contentBlocks.some((block) => {
    return block.type === PROACTIVE_BLOCK_TYPE
  })
}

export interface RelayItem {
  fromAgent?: string
  toAgent: string
  reason: string
  turnIndex: number
}

/** 会话产物（右栏「本会话产物」列表项）。 */
export interface ArtifactItem {
  callId: string
  name: string
  size: number
  mime: string
}

export interface ChatSnapshot {
  messages: UiMessage[]
  relays: RelayItem[]
  /** senderId → 正在生成中的消息数。 */
  typing: Record<string, number>
  /** 有消息在排队等待上一 turn 结束。 */
  queueing: boolean
  error?: { message: string; code: string }
}

const EMPTY: ChatSnapshot = { messages: [], relays: [], typing: {}, queueing: false }

/**
 * 基础重绘节流窗口：连续流式事件在窗口内合并成一次重绘（≈25fps）。
 *
 * 这是**下限而不是上限**：{@link ChatStore.subscribeThrottled} 允许每个订阅者各自把窗口
 * 调大（面板类订阅者不需要 25fps），但没有订阅者能快过它——store 只在最前沿刷一次，
 * 一条 token 事件就重绘整棵树从来不是我们要的形态。
 */
const NOTIFY_INTERVAL_MS = 40

/**
 * 订阅者自己的节流状态（见 {@link ChatStore.subscribeThrottled}）。
 *
 * 为什么每个订阅者各存一份而不是全局一份：消息区要在 25fps 里出字，右栏的接力链与
 * 输入区的按钮不——它们跟着同一个 tick 重渲染纯属白花（AI SDK 的 `useChat` 也是把
 * `throttle` 做成 per-consumer 选项而不是全局常量）。
 */
interface SubscriberState {
  /** 该订阅者的窗口（ms）；不超过 {@link NOTIFY_INTERVAL_MS} 时跟随基础档。 */
  throttleMs: number
  /** 已排队的通知（未到窗口时）。 */
  timer?: ReturnType<typeof setTimeout>
  /** 上次真正通知到该订阅者的时间。 */
  lastFlushAt?: number
}

/**
 * 索引上界：一个会话在册几千条消息时，下面两张索引表也会长到几千条。
 * key 本身带 turn 序号 / 消息 id（`stream:<sender>:<turn>`、`user:<时间戳>:<序>`、
 * `hist:<消息 id>`），丢掉历史条目只可能挡下一次「同 key 撞车」，而那需要系统时间
 * 倒流才会发生；callId 同理。故按插入顺序丢最旧的，内存占用与会话长度脱钩。
 */
const MAX_LIVE_KEYS = 512
const MAX_CALL_INDEX = 256

/** Map/Set 都按插入顺序迭代：超上界就丢最旧的，直到落回上界内。 */
function trimIndex<K>(index: Map<K, unknown> | Set<K>, max: number): void {
  while (index.size > max) {
    const oldest = index.keys().next()
    if (oldest.done === true) return
    index.delete(oldest.value)
  }
}

/**
 * message-done 按 sender 兜底收口的现场（键对不上时才产生）。
 *
 * 为什么要有它：兜底分支本来就是「键算不出来时猜一条」，猜错的后果分两种——猜中无事，
 * 猜错要么该收的没收（光标长亮），要么把**进行中的一轮**提前关掉（后续 delta 被丢弃）。
 * 两件事都不抛错、界面上只是一段话不见了，只有把当时的候选记下来才查得动。
 */
export interface DoneFallback {
  senderId: string
  /** message-done 声称的轮次。 */
  turnIndex: number
  /** 被当作候选的那条气泡（键与轮次都记上：键对不上本身就是判据）。 */
  candidateKey: string
  candidateTurnIndex: number
  /** sealed = 已就地收口；rejected = 轮次差太远，护栏拒收。 */
  outcome: 'sealed' | 'rejected'
}

/** 流式链路的本地度量（排障「为什么卡」时先看这组数字；只在本地内存里，不外发）。 */
export interface StoreMetrics {
  /** 已 apply 的 WS 事件数。 */
  events: number
  /** 实际触发订阅者的重绘次数（远小于事件数 = 节流在起作用）。 */
  flushes: number
  /** 最近一次重绘的耗时（毫秒，含所有订阅者）。 */
  lastFlushMs: number
  /** 快照里的消息条数。 */
  messages: number
  /** 快照里的部件总数（text/tool/file 合计）。 */
  parts: number
  /**
   * error 事件把在流式气泡就地收口的次数。
   *
   * 真实供应商失败（429/超时/流中断/CONTEXT_WINDOW_EXCEEDED）时服务端只发 error、
   * 不发 message-done，这条计数非零就说明「用户看到的那轮是靠收口才停的」——不是正常
   * 收口路径，属排障第一眼要看的一格。
   */
  sealedOnError: number
  /** message-done 键对不上、按 sender 兜底收口的次数（含同轮第二次发言的 key 后缀不匹配）。 */
  doneFallbacks: number
  /** 兜底候选的轮次差太远而**没有**收口的次数（护栏生效，非零说明有轮次漂移）。 */
  doneFallbackRejected: number
  /** 最近一次兜底的现场（收口或拒收都记）。 */
  lastDoneFallback?: DoneFallback
}

/** 一条消息内文本部件的累积写入辅助（纯函数：绝不改传入的数组）。 */
function appendText(parts: readonly MessagePart[], text: string): MessagePart[] {
  const last = parts[parts.length - 1]
  if (last !== undefined && last.kind === 'text') {
    // 只新建末尾这一个部件，前面的部件引用保持不变（结构共享）。
    const next = parts.slice(0, -1)
    next.push({ kind: 'text', text: last.text + text })
    return next
  }
  return [...parts, { kind: 'text', text }]
}

/** 定点改一条消息：version 自增，其余字段原样带过（其余消息引用不变）。 */
function withParts(message: UiMessage, parts: MessagePart[]): UiMessage {
  return { ...message, parts, version: (message.version ?? 0) + 1 }
}

/** 数组浅拷贝后替换一个下标（其余元素保持同一引用）。 */
function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const next = items.slice()
  next[index] = value
  return next
}

/**
 * 工具结果正文的截断上限。
 *
 * 一条 shell_exec 能回几 MB stdout，全量塞进每条消息的 parts 会把会话快照撑大到重绘
 * 卡顿；超出只保留头尾（报错通常在尾部），中间明确写出省略了多少字——过程可见只需要
 * "看到发生了什么"，不需要全文搬运。
 */
const TOOL_CONTENT_LIMIT = 8000

/**
 * **历史**工具正文的截断上限（比实时链路短得多）。
 *
 * 历史正文只增不减：往上翻页就一路往渲染层的快照里塞。工具行默认是折叠的，
 * 那 8KB 正文在用户点开之前根本不显示——纯粹占着内存。10 万条会话的实测：按 8KB
 * 存是 200MB，按 2KB 存是 50MB。实时链路仍然留 8KB（那一轮用户正要看着它出来）。
 */
const HISTORY_TOOL_CONTENT_LIMIT = 2000

/**
 * 工具结果正文的截断（实时链路与历史回放共用同一个上限）。
 *
 * 历史路径也要走这道：一条历史工具结果动辄几 MB，按条塞进快照会让打开三天前的会话
 * 就先卡一下，而它展示时本来就会被 {@link TOOL_DETAIL_LIMIT} 再收一道。
 */
export function clipToolContent(content: string): string {
  return clipToolContentTo(content, TOOL_CONTENT_LIMIT)
}

/** 历史路径用的更短截断（见 {@link HISTORY_TOOL_CONTENT_LIMIT}）。 */
export function clipHistoryToolContent(content: string): string {
  return clipToolContentTo(content, HISTORY_TOOL_CONTENT_LIMIT)
}

function clipToolContentTo(content: string, limit: number): string {
  if (content.length <= limit) return content
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  const dropped = content.length - limit
  return `${content.slice(0, head)}\n…（中间省略 ${dropped} 字）…\n${content.slice(content.length - tail)}`
}

/**
 * 失败工具结果的落库标记块（服务端 @ryharness/session 的 coordinator 写上）。
 *
 * 与 {@link PROACTIVE_BLOCK_TYPE} 同一个约定：渲染层不 import 内核那一侧（内核入口会把
 * node:sqlite 拖进浏览器包），字面量在这里复述，两边由
 * `apps/desktop/tests/tool-history.test.ts` 的 parity 用例锁住。
 */
export const TOOL_ERROR_BLOCK_TYPE = 'tool-error'

/** 这条历史行是不是一条失败的工具结果。 */
export function isToolErrorRow(row: { contentBlocks: { type: string }[] }): boolean {
  return row.contentBlocks.some((block) => {
    return block.type === TOOL_ERROR_BLOCK_TYPE
  })
}

/**
 * 回执超时的降级窗口。
 *
 * 断网、服务没起来、代理挂着不动时 fetch 可能一直不 settle，那条用户气泡就会永远停在
 * "发送中"——一个永远不会自己消失的谎。超过这个窗口还没回执就按失败算：宁可让用户
 * 重发一次，也不要一个转不出来的圈。
 */
export const DELIVERY_TIMEOUT_MS = 15_000

/**
 * message-done 按 sender 兜底收口时允许的轮次漂移（见 {@link ChatStore.apply} 的
 * message-done 分支）。1 是有依据的：轮次按会话单调递增，一轮里所有事件共用同一个
 * turnIndex，能差出 1 的只有「服务端某一端先自增了一轮」；差出 2 往上的那条 done 基本
 * 是上一轮的迟到事件，收口它等于把进行中的一轮提前关掉。
 */
const DONE_TURN_TOLERANCE = 1

/**
 * 「用户消息没发出去」专用的错误码，由渲染层自造（见 ChatView.deliver 的 catch）。
 *
 * 它和「这一轮跑挂了」不是一回事——供应商/内核给的码里没有 HTTP（见
 * packages/llm/openai 的错误码表），而 POST 失败时服务端压根没收到这条消息：别的
 * agent 那一轮还在正常跑，稍后照常发 message-done。拿它去收口在流式的气泡，等于把
 * 别人正在说的话拦腰截断（后续 delta 被迫另起一个气泡）。所以这条错误只记横幅。
 */
const SEND_FAILED_CODE = 'HTTP'

/** emit 的补丁：字段缺省即保持原值；`error` 显式传 undefined 表示清除。 */
interface SnapshotPatch {
  messages?: UiMessage[]
  relays?: RelayItem[]
  typing?: Record<string, number>
  queueing?: boolean
  error?: { message: string; code: string } | undefined
  /** 仅当为 true 时才允许把 error 清成 undefined。 */
  clearError?: boolean
}

export class ChatStore {
  private snapshot: ChatSnapshot = EMPTY
  private listeners = new Set<() => void>()
  /** 与 {@link listeners} 一一对应的节流状态；节流窗口存在订阅者自己身上。 */
  private readonly subscriberStates = new Map<() => void, SubscriberState>()
  private agentNames = new Map<string, string>()

  // ---- 索引：把「每次事件扫全量」降为 O(1) ----
  /** 全部在册 key（分配流式 key 时防重）；按插入顺序截到 {@link MAX_LIVE_KEYS}。 */
  private readonly liveKeys = new Set<string>()
  /** stream key → 消息下标。 */
  private readonly streamKeyIndex = new Map<string, number>()
  /** senderId → 正在流式写入的消息下标（miss 或已 done 时回退倒扫）。 */
  private readonly streamingIndex = new Map<string, number>()
  /** callId → 含该 callId 的消息下标（tool-result 定点更新）；截到 {@link MAX_CALL_INDEX}。 */
  private readonly callIndex = new Map<string, number[]>()
  /** 还在等回执的用户消息 → 降级定时器（见 {@link DELIVERY_TIMEOUT_MS}）。 */
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 产物缓存：artifactsVersion 不变时返回同一数组身份（右栏直接复用）。 */
  private artifactsVersion = 0
  private artifactsCache: { version: number; list: ArtifactItem[] } | undefined

  /** 已 apply 的事件数与重绘次数（度量，不参与渲染决策）。 */
  private events = 0
  private flushes = 0
  private lastFlushMs = 0
  /** error 分支收口过在流式气泡的次数；兜底收口 / 被护栏拒掉的次数与最近一次现场。 */
  private sealedOnError = 0
  private doneFallbacks = 0
  private doneFallbackRejected = 0
  private lastDoneFallback: DoneFallback | undefined

  /** 诊断快照：排障「为什么卡」时先看这组数字。 */
  metrics(): StoreMetrics {
    let parts = 0
    for (const message of this.snapshot.messages) parts += message.parts.length
    return {
      events: this.events,
      flushes: this.flushes,
      lastFlushMs: this.lastFlushMs,
      messages: this.snapshot.messages.length,
      parts,
      sealedOnError: this.sealedOnError,
      doneFallbacks: this.doneFallbacks,
      doneFallbackRejected: this.doneFallbackRejected,
      ...(this.lastDoneFallback === undefined ? {} : { lastDoneFallback: this.lastDoneFallback }),
    }
  }

  setAgentNames(names: Map<string, string>): void {
    this.agentNames = names
  }

  private nameOf(senderId: string, fallback?: string): string {
    if (senderId === 'user') return '我'
    return this.agentNames.get(senderId) ?? fallback ?? senderId
  }

  subscribe = (listener: () => void): (() => void) => {
    return this.addListener(listener, 0)
  }

  /**
   * 带自己节流窗口的订阅。
   *
   * `throttleMs` 是**这个订阅者**的重绘上限，不是全店统一档：共享同一个 store 的组件
   * 可以各要各的（消息区 0 = 跟随基础档，右栏可以要 200ms）。共享 Chat 的不同组件看到
   * 不同节奏的快照，正是 AI SDK `useChat` 的 `throttle` 语义。
   */
  subscribeThrottled = (listener: () => void, throttleMs: number): (() => void) => {
    return this.addListener(listener, throttleMs)
  }

  private addListener(listener: () => void, throttleMs: number): () => void {
    this.listeners.add(listener)
    this.subscriberStates.set(listener, { throttleMs: Math.max(0, throttleMs) })
    return () => {
      const state = this.subscriberStates.get(listener)
      if (state?.timer !== undefined) clearTimeout(state.timer)
      this.subscriberStates.delete(listener)
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ChatSnapshot => {
    return this.snapshot
  }

  /** 通知节流：40ms 合并连续事件（流式 token 批量重绘，报告 §5）。 */
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  private lastFlushAt: number | undefined

  /**
   * 通知节流：40ms 合并连续事件（流式 token 批量重绘，报告 §5）。
   * 前沿立即刷：空闲后到达的第一个事件（用户按下回车、气泡起头）当场重绘，
   * 不白等一个 40ms 窗口——否则每轮开头都有一个肉眼可见的"没反应"。
   */
  private notify(): void {
    const now = Date.now()
    if (this.notifyTimer !== undefined) return
    if (this.lastFlushAt !== undefined && now - this.lastFlushAt < NOTIFY_INTERVAL_MS) {
      this.notifyTimer = setTimeout(
        () => {
          this.notifyTimer = undefined
          this.flush()
        },
        NOTIFY_INTERVAL_MS - (now - this.lastFlushAt),
      )
      return
    }
    this.flush()
  }

  private flush(): void {
    const now = Date.now()
    this.lastFlushAt = now
    const startedAt = now
    for (const listener of this.listeners) {
      const state = this.subscriberStates.get(listener)
      if (state === undefined) continue
      this.notifyOne(state, listener)
    }
    this.flushes += 1
    this.lastFlushMs = Date.now() - startedAt
  }

  /** 通知一个订阅者：窗口内就排一次尾随通知，窗口外立即（前沿不延迟）。 */
  private notifyOne(state: SubscriberState, listener: () => void): void {
    if (state.throttleMs <= NOTIFY_INTERVAL_MS) {
      listener()
      return
    }
    if (state.timer !== undefined) return
    const now = Date.now()
    const wait = state.lastFlushAt === undefined ? 0 : state.throttleMs - (now - (state.lastFlushAt ?? now))
    if (wait <= 0) {
      state.lastFlushAt = now
      listener()
      return
    }
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.lastFlushAt = Date.now()
      listener()
    }, wait)
  }

  /**
   * 彻底停掉这个 store：定时器与订阅者一起清掉。
   *
   * 会话桶被逐出缓存时必须走这里，否则三件东西跟着泄漏：未决的通知定时器、回执降级
   * 定时器（每个「发送中」的用户气泡一个 15s 的 setTimeout），以及还在监听流式事件的订阅者。
   */
  dispose(): void {
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = undefined
    }
    for (const state of this.subscriberStates.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
    }
    this.subscriberStates.clear()
    this.listeners.clear()
    this.clearDeliveryTimers()
  }

  private emit(patch: SnapshotPatch): void {
    const prev = this.snapshot
    const error = patch.clearError === true ? undefined : (patch.error ?? prev.error)
    const next: ChatSnapshot = {
      messages: patch.messages ?? prev.messages,
      relays: patch.relays ?? prev.relays,
      typing: patch.typing ?? prev.typing,
      queueing: patch.queueing ?? prev.queueing,
      ...(error === undefined ? {} : { error }),
    }
    this.snapshot = next
    this.notify()
  }

  reset(): void {
    this.snapshot = EMPTY
    this.liveKeys.clear()
    this.streamKeyIndex.clear()
    this.streamingIndex.clear()
    this.callIndex.clear()
    this.clearDeliveryTimers()
    this.artifactsVersion += 1
    this.artifactsCache = undefined
    this.notify()
  }

  /**
   * 把此刻仍在流式写入（done=false）的消息就地收口并清掉 typing，**返回**补丁。
   *
   * 与 {@link sealIncomplete} 分成两半是因为 error 分支要把收口和错误横幅放进同一次
   * emit：先收口再弹红条等于让它们晚一帧才一起到位，而这一帧里光标还在闪。
   * 没东西可收时返回 undefined（调用方据此跳过重绘）。
   */
  private sealInflightPatch(): { messages: UiMessage[]; typing: Record<string, number> } | undefined {
    let changed = false
    const messages = this.snapshot.messages.map((message) => {
      if (message.done) return message
      changed = true
      return { ...message, done: true, version: (message.version ?? 0) + 1 }
    })
    // 已经是空的就不换身份：否则一次「什么都没收」的 error 会凭空重绘整棵消息树。
    const typing = Object.keys(this.snapshot.typing).length === 0 ? this.snapshot.typing : {}
    if (!changed && typing === this.snapshot.typing) return undefined
    return { messages, typing }
  }

  /**
   * 把没写完的流式消息就地收口（断口续接与用户中止之后用）。
   *
   * 两条路都不会再有 message-done：断线缺口按定义丢了那条事件，用户中止时服务端只补一条
   * ABORTED 错误。不收口的话，气泡永远停在 done=false——输入区的停止按钮亮着、光标一直闪，
   * 而实际上这一轮已经没人再往里写了。
   */
  sealIncomplete(): void {
    const patch = this.sealInflightPatch()
    if (patch === undefined) return
    this.emit(patch)
  }

  /**
   * 会话产物（file 部件）——右栏与消息列表共用的单一 selector。
   * 产物没变时返回同一数组身份，避免右栏每个 token 重扫全量 parts。
   */
  artifacts(): ArtifactItem[] {
    const cached = this.artifactsCache
    if (cached !== undefined && cached.version === this.artifactsVersion) return cached.list
    const list: ArtifactItem[] = []
    for (const message of this.snapshot.messages) {
      for (const part of message.parts) {
        if (part.kind === 'file') {
          list.push({ callId: part.callId, name: part.name, size: part.size, mime: part.mime })
        }
      }
    }
    this.artifactsCache = { version: this.artifactsVersion, list }
    return list
  }

  /** 清除错误横幅（下一轮/重发也会自动清除）。 */
  clearError(): void {
    if (this.snapshot.error === undefined) return
    this.emit({ clearError: true })
  }

  /** 加载历史调度事件（打开会话时一次性灌入）。 */
  setDispatchHistory(
    events: readonly { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[],
  ): void {
    this.emit({
      relays: events.map((event) => {
        return {
          ...(event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent }),
          toAgent: event.toAgent,
          reason: event.reason,
          turnIndex: event.turnIndex,
        }
      }),
    })
  }

  /** 折叠一条 WS 事件。 */
  apply(event: WsEvent): void {
    this.events += 1
    switch (event.type) {
      case 'message-start': {
        if (event.senderId === 'user') {
          // 用户消息行由发送方本地插入（send 时），这里只补 agent 的。
          return
        }
        // 新一轮开始：上一条错误横幅过期（同一次 emit 里清掉）。
        const key = this.allocateStreamingKey(event.senderId, event.turnIndex)
        const messages = this.snapshot.messages
        const message: UiMessage = {
          key,
          senderType: 'agent',
          senderId: event.senderId,
          senderName: this.nameOf(event.senderId, event.senderName),
          turnIndex: event.turnIndex,
          parts: [],
          done: false,
          version: 0,
          // 主动开口的那一轮（每日回顾）：气泡上方要有「它 主动找你」那一行。
          // 历史里的同一条消息靠 content_blocks 的标记块认出（isProactiveRow），
          // 实时这条靠事件上的标记——两处认的是同一件事，缺一个就会「刷新一次
          // 标识就没了」。
          ...(event.proactive === true ? { proactive: true } : {}),
        }
        const index = messages.length
        this.trackKey(key)
        this.streamKeyIndex.set(key, index)
        this.streamingIndex.set(event.senderId, index)
        this.emit({
          messages: [...messages, message],
          typing: { ...this.snapshot.typing, [event.senderId]: (this.snapshot.typing[event.senderId] ?? 0) + 1 },
          clearError: true,
        })
        return
      }
      case 'text-delta': {
        const target = this.streamingWriteTarget(event.senderId)
        const message = target.messages[target.index]
        if (message === undefined) return
        // 首个字到达即视为「已经在说话」：此刻气泡里正在出字，同一个 sender
        // 头上再挂一行「正在输入」是自相矛盾的。message-done 里的递减照旧兜底，
        // 且对已清空的键是幂等的（减到 0 就删，不会减出负数）。
        const typing = { ...this.snapshot.typing }
        delete typing[event.senderId]
        this.emit({
          messages: replaceAt(target.messages, target.index, withParts(message, appendText(message.parts, event.text))),
          typing,
        })
        return
      }
      case 'tool-call-start': {
        const target = this.streamingWriteTarget(event.senderId)
        const message = target.messages[target.index]
        if (message === undefined) return
        this.indexCall(event.callId, target.index)
        this.emit({
          messages: replaceAt(
            target.messages,
            target.index,
            withParts(
              message,
              message.parts.concat({
                kind: 'tool',
                callId: event.callId,
                name: event.name,
                arguments: event.arguments,
                status: 'running',
              }),
            ),
          ),
          typing: this.typingForNewBubble(event.senderId, target.opened),
        })
        return
      }
      case 'tool-result': {
        // O(1)：callId → 消息下标，不再遍历全量消息 × 全量 parts。
        const indices = this.callIndex.get(event.callId)
        if (indices === undefined || indices.length === 0) return
        let messages = this.snapshot.messages
        for (const index of indices) {
          const message = messages[index]
          if (message === undefined) continue
          const partIndex = message.parts.findIndex((part) => {
            return part.kind === 'tool' && part.callId === event.callId
          })
          if (partIndex < 0) continue
          const parts = message.parts.slice()
          parts[partIndex] = {
            ...(parts[partIndex] as Extract<MessagePart, { kind: 'tool' }>),
            status: 'done',
            isError: event.isError,
            // 结果正文留在这条消息里（见 MessagePart.content）：折叠时丢掉它，气泡就只剩
            // 一行「已读文件」，用户无从判断 agent 做了什么、错在哪。
            content: clipToolContent(event.content),
          }
          messages = replaceAt(messages, index, withParts(message, parts))
        }
        if (messages === this.snapshot.messages) return
        this.emit({ messages })
        return
      }
      case 'produce-card': {
        const target = this.streamingWriteTarget(event.senderId)
        const message = target.messages[target.index]
        if (message === undefined) return
        this.indexCall(event.callId, target.index)
        this.artifactsVersion += 1
        this.emit({
          messages: replaceAt(
            target.messages,
            target.index,
            withParts(
              message,
              message.parts.concat({
                kind: 'file',
                callId: event.callId,
                name: event.card.name,
                size: event.card.size,
                mime: event.card.mime,
              }),
            ),
          ),
          typing: this.typingForNewBubble(event.senderId, target.opened),
        })
        return
      }
      case 'dispatch': {
        this.emit({
          relays: this.snapshot.relays.concat({
            ...(event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent }),
            toAgent: event.toAgent,
            reason: event.reason,
            turnIndex: event.turnIndex,
          }),
        })
        return
      }
      case 'message-done': {
        // key 保持不变：只翻 done 位（换 key 会让 React 整泡卸载重建）。
        const key = this.streamingKey(event.senderId, event.turnIndex)
        let index = this.streamKeyIndex.get(key)
        let sealedKey = key
        if (index === undefined) {
          /**
           * 兜底：按 sender 收口它此刻仍在流式的那条气泡。
           *
           * 键对不上有三种可能——服务端某一端的 turnIndex 漂了；同一 sender 本轮的
           * **第二次发言**没有 message-start、key 走了 `#2` 后缀（群聊接力 A→B→C→A 就是
           * 这种，见 {@link streamingWriteTarget}）；或气泡是先走断口续接补回、key 落在
           * hist 命名空间上。不做兜底的后果是光标永远闪、停止按钮永远亮。
           *
           * 但兜底是「猜」，猜错的方向不对称：把进行中的一轮提前关掉，它后面的
           * text-delta 会被迫另起一个气泡，一句话被切成两段。所以候选轮次与这条
           * message-done 声称的轮次差超过 {@link DONE_TURN_TOLERANCE} 时宁可不收，
           * 只把现场记进 {@link StoreMetrics.doneFallbackRejected}（宁可光标多闪一会，
           * 也不截断正在说话的那一轮）。差得不多（服务端某一端漂一轮）才照收，
           * 两种结局都记进 lastDoneFallback。
           */
          const candidate = this.findStreamingIndex(event.senderId)
          const message = candidate < 0 ? undefined : this.snapshot.messages[candidate]
          if (candidate >= 0 && message !== undefined) {
            const drift = message.turnIndex - event.turnIndex
            const fallback: DoneFallback = {
              senderId: event.senderId,
              turnIndex: event.turnIndex,
              candidateKey: message.key,
              candidateTurnIndex: message.turnIndex,
              outcome: Math.abs(drift) <= DONE_TURN_TOLERANCE ? 'sealed' : 'rejected',
            }
            this.lastDoneFallback = fallback
            if (fallback.outcome === 'sealed') {
              this.doneFallbacks += 1
              index = candidate
              sealedKey = message.key
            } else {
              this.doneFallbackRejected += 1
            }
          }
        }
        let messages = this.snapshot.messages
        if (index !== undefined) {
          const message = messages[index]
          this.streamKeyIndex.delete(sealedKey)
          if (this.streamingIndex.get(event.senderId) === index) this.streamingIndex.delete(event.senderId)
          if (message !== undefined) {
            messages = replaceAt(messages, index, { ...message, done: true, version: (message.version ?? 0) + 1 })
          }
        }
        // 兜底清 typing：键可能已在首个 text-delta 就被摘掉，这里对缺失的键
        // 同样只是「减到 0 即删」，重复到达不会减出负数。
        const typing = { ...this.snapshot.typing }
        const remaining = (typing[event.senderId] ?? 1) - 1
        if (remaining <= 0) delete typing[event.senderId]
        else typing[event.senderId] = remaining
        this.emit({ messages, typing, queueing: false })
        return
      }
      case 'queued': {
        this.emit({ queueing: true })
        return
      }
      case 'error': {
        /**
         * 一轮失败 = 整轮结束：服务端此后不会再补 message-done（AgentLoop 出错即返回；
         * 调度器里任一成员 failed 也 break 掉整条接力链，见 packages/group/src/dispatcher.ts）。
         * 而 error 事件不带 senderId，所以只能按「此刻仍在流式的那几条」收口。
         *
         * 此前这里只写错误横幅，于是红条弹出、气泡光标继续闪、停止按钮与秒表长亮，
         * onTurnEnd 永不触发——用户看到的是「报错了但还在生成」。已完成的旧气泡不受影响
         * （{@link sealInflightPatch} 只动 done=false 的）。
         *
         * 唯一例外是 {@link SEND_FAILED_CODE}：那是「消息没发出去」，那一轮根本没开始。
         */
        const sealed = event.code === SEND_FAILED_CODE ? undefined : this.sealInflightPatch()
        if (sealed === undefined) {
          this.emit({ error: { message: event.message, code: event.code } })
          return
        }
        this.sealedOnError += 1
        this.emit({ ...sealed, error: { message: event.message, code: event.code } })
        return
      }
      default:
        return
    }
  }

  /**
   * 本地插入用户消息（发送即上屏，不等 WS）。附件按 file 部件上屏，与产物卡片同一条渲染通道。
   *
   * 返回这条消息的 key：送达状态要等 HTTP 回执（202 / 失败）才知道，发起方拿着 key
   * 回填 {@link MessageDelivery}，UI 才能把"没发出去"和"已送达"画成两样。
   */
  addUserMessage(text: string, turnIndex: number, attachments: readonly MessageAttachment[] = []): string {
    // 重发即视为新一轮：清掉上一条错误横幅。
    const messages = this.snapshot.messages
    const stamp = Date.now()
    const parts: MessagePart[] = text.length > 0 ? [{ kind: 'text', text }] : []
    attachments.forEach((file, index) => {
      parts.push({
        kind: 'file',
        callId: `user-file:${stamp}:${index}`,
        name: file.name,
        size: file.size,
        mime: file.mime,
      })
    })
    const message: UiMessage = {
      key: `user:${stamp}:${messages.length}`,
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex,
      parts,
      done: true,
      delivery: 'pending',
      version: 0,
    }
    this.trackKey(message.key)
    this.emit({ messages: [...messages, message], clearError: true })
    this.armDeliveryTimeout(message.key)
    return message.key
  }

  /** 给一条"发送中"的气泡上发条：超时没等到回执就降级成失败（见 {@link DELIVERY_TIMEOUT_MS}）。 */
  private armDeliveryTimeout(key: string): void {
    this.clearDeliveryTimeout(key)
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(key)
      this.setUserMessageDelivery(key, 'failed')
    }, DELIVERY_TIMEOUT_MS)
    this.deliveryTimers.set(key, timer)
  }

  private clearDeliveryTimeout(key: string): void {
    const timer = this.deliveryTimers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.deliveryTimers.delete(key)
  }

  private clearDeliveryTimers(): void {
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
  }

  /**
   * 回填一条用户消息的送达状态（202 回来时 / 发失败时 / 重发时）。
   *
   * 只认用户消息：历史消息从库里读出来就已送达（没有该字段，按 sent 算），agent
   * 消息不经过这条通道。状态没变则不 emit——回执与重试常常在同一次交互里连着到，
   * 为一个等于的字段重绘整条流是白花。
   */
  setUserMessageDelivery(key: string, delivery: MessageDelivery): void {
    const index = this.snapshot.messages.findIndex((message) => {
      return message.key === key
    })
    const message = this.snapshot.messages[index]
    if (index < 0 || message === undefined || message.senderType !== 'user') return
    if ((message.delivery ?? 'sent') === delivery) return
    // 降级计时器跟着状态走：回执到了就撤掉，重发回到 pending 就重新计时。
    if (delivery === 'pending') this.armDeliveryTimeout(key)
    else this.clearDeliveryTimeout(key)
    this.emit({
      messages: replaceAt(this.snapshot.messages, index, {
        ...message,
        delivery,
        version: (message.version ?? 0) + 1,
      }),
    })
  }

  /** 登记一条在册消息 key，并守住 {@link MAX_LIVE_KEYS} 上界。 */
  private trackKey(key: string): void {
    this.liveKeys.add(key)
    trimIndex(this.liveKeys, MAX_LIVE_KEYS)
  }

  private streamingKey(senderId: string, turnIndex: number): string {
    return `stream:${senderId}:${turnIndex}`
  }

  /** 分配一个未被占用的流式 key（同一 sender/turn 重复 start 时加后缀防 React key 冲突）。 */
  private allocateStreamingKey(senderId: string, turnIndex: number): string {
    const base = this.streamingKey(senderId, turnIndex)
    if (!this.liveKeys.has(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`
      if (!this.liveKeys.has(candidate)) return candidate
    }
  }

  private indexCall(callId: string, index: number): void {
    const list = this.callIndex.get(callId)
    if (list === undefined) this.callIndex.set(callId, [index])
    else if (!list.includes(index)) list.push(index)
    trimIndex(this.callIndex, MAX_CALL_INDEX)
  }

  /** 找 sender 正在流式写入的消息下标：命中缓存 O(1)，失效时倒扫一次并回填。 */
  private findStreamingIndex(senderId: string): number {
    const messages = this.snapshot.messages
    const cached = this.streamingIndex.get(senderId)
    if (cached !== undefined && messages[cached] !== undefined && !messages[cached]!.done) return cached
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!
      if (message.senderId === senderId && !message.done && message.senderType === 'agent') {
        this.streamingIndex.set(senderId, i)
        return i
      }
    }
    return -1
  }

  /**
   * 流式写入的落点：sender 此刻那条气泡，**没有就新开一条**（`opened` 为真）。
   *
   * 群聊接力允许 A→B→C→A（loop-guard 只挡上一个与上上个），而服务端的 message-start
   * 每个 sender 每轮只补一次（apps/server/src/app.ts 的 ensureStart）——A 的第二段发言是
   * 没有 message-start 的。此前这条路径直接 return（index<0），A 那段的 text-delta /
   * tool-call-start / produce-card 全被静默丢弃：屏幕上凭空少一段，刷新后服务端落库的
   * 那段又冒出来，看起来像「界面自己吞了话」。
   *
   * 新气泡沿用 sender 上一条发言的轮次与昵称，取不到就落在快照当前最大轮次上；key 走
   * {@link allocateStreamingKey} 的 `#2` 后缀，React key 与 streamKeyIndex 都不冲突。
   * 返回的 `messages` 可能是新数组（刚追加了气泡），下标对旧消息仍然有效——调用方用
   * {@link replaceAt} 定点改写即可，不用自己再拼一次。
   */
  private streamingWriteTarget(senderId: string): {
    messages: readonly UiMessage[]
    index: number
    opened: boolean
  } {
    const live = this.findStreamingIndex(senderId)
    if (live >= 0) return { messages: this.snapshot.messages, index: live, opened: false }
    const previous = this.lastMessageOf(senderId)
    const turnIndex = Math.max(previous?.turnIndex ?? 0, this.latestTurnIndex())
    const key = this.allocateStreamingKey(senderId, turnIndex)
    const message: UiMessage = {
      key,
      senderType: 'agent',
      senderId,
      senderName: this.nameOf(senderId, previous?.senderName),
      turnIndex,
      parts: [],
      done: false,
      version: 0,
    }
    const messages = [...this.snapshot.messages, message]
    const index = messages.length - 1
    this.trackKey(key)
    this.streamKeyIndex.set(key, index)
    this.streamingIndex.set(senderId, index)
    return { messages, index, opened: true }
  }

  /**
   * 没有 message-start 就新起一条气泡时的 typing 补丁。
   *
   * 新气泡等于「这一轮刚开」，所以得补上 message-start 本该挂上的那个「正在输入」，
   * 否则同轮别的 sender 正在打字、唯独它凭空冒泡。text-delta 那条不需要：气泡里已经在
   * 出字，typing 由该分支直接删掉 sender 键。
   */
  private typingForNewBubble(senderId: string, opened: boolean): Record<string, number> | undefined {
    if (!opened) return undefined
    return { ...this.snapshot.typing, [senderId]: (this.snapshot.typing[senderId] ?? 0) + 1 }
  }

  /** sender 最近一条消息（第二轮发言沿用它的昵称与轮次）。 */
  private lastMessageOf(senderId: string): UiMessage | undefined {
    const messages = this.snapshot.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message !== undefined && message.senderId === senderId) return message
    }
    return undefined
  }

  /** 快照里最大的轮次：没见过 message-start 的 sender 的发言归到这一轮。 */
  private latestTurnIndex(): number {
    let latest = 0
    for (const message of this.snapshot.messages) {
      if (message.turnIndex > latest) latest = message.turnIndex
    }
    return latest
  }
}

/** Hook：订阅 store（整个快照）。 */
export function useChat(store: ChatStore): ChatSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** Hook：订阅某个会话桶的界面状态（切会话 = 换订阅对象，组件本身不卸载）。 */
export function useConversationView(bucket: ConversationBucket): ConversationViewState {
  return useSyncExternalStore(bucket.subscribe, bucket.getView)
}

// ---- 订阅者级切片与节流 ----

/**
 * 只订阅自己真正用到的那部分快照，并自带节流窗口。
 *
 * 两个问题一起解决：
 * 1. **切片**：右栏只用 `relays`、输入区只用「是否在生成」，却跟着每 40ms 收到一份
 *    messages 变化的快照——整棵树为一件与自己无关的事重渲染。切片让它们只在自己那份
 *    变了的时候重渲染（select 的结果按输入快照缓存，身份稳定，React 才不会判定成新值）。
 * 2. **节流**：`throttleMs` 是这个订阅者自己的上限（AI SDK `useChat` 的 `throttle`）。
 *
 * select 必须**纯**且对同一份输入返回等价结果——它会在每次通知时被调用，也可能一次通知
 * 里被 React 连问两次（缓存未命中时）。
 */
export function useChatSlice<T>(store: ChatStore, select: (snapshot: ChatSnapshot) => T, throttleMs = 0): T {
  const selectRef = useRef(select)
  // 渲染期同步而不是放进 effect：切换 selector 时第一次渲染就该用新的那个，
  // 否则会拿旧 selector 的结果渲染一帧再改回来（闪一下旧切片）。
  selectRef.current = select
  const cacheRef = useRef<{ input: ChatSnapshot; output: T } | undefined>(undefined)
  const subscribe = useMemo(() => {
    return (listener: () => void): (() => void) => {
      return store.subscribeThrottled(listener, throttleMs)
    }
  }, [store, throttleMs])
  const getSnapshot = useCallback((): T => {
    const input = store.getSnapshot()
    const cached = cacheRef.current
    if (cached !== undefined && cached.input === input) return cached.output
    const output = selectRef.current(input)
    cacheRef.current = { input, output }
    return output
  }, [store])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 「这一轮还在跑吗」——输入区与停止按钮的判据（见 ChatView 的 streamingActive）。 */
export function streamingOf(snapshot: ChatSnapshot): boolean {
  if (Object.keys(snapshot.typing).length > 0) return true
  return snapshot.messages.some((message) => {
    return !message.done
  })
}

/** 右栏信息板要的切片：接力链 + 会话产物。两者都不随 token 变化。 */
export interface PanelSlice {
  relays: readonly RelayItem[]
  artifacts: ArtifactItem[]
}

/**
 * 右栏的预设切片 selector（配合 {@link useChatSlice} 用，见 components/RightPanel）。
 *
 * 为什么接力链与产物必须并成一个切片：产物不是快照字段，而是
 * {@link ChatStore.artifacts} 按 artifactsVersion 现场算出来的。只切 relays 的话，
 * produce-card 到达时 relays 的数组身份没变，右栏就不重渲染，那一行产物要一直等到
 * 下一次 dispatch 才出现——省下的重绘换来的是界面缺东西。
 *
 * 返回的对象按两个字段的身份做稳定化：流式期间两者都不变，于是切片身份也不变，
 * React 才判得出「这一帧与上一帧等价」。selector 本身闭包持有上一份结果，因此必须
 * 经 {@link useMemo} 按 store 绑定（见 RightPanel），不能每次渲染现造一个。
 */
export function panelSliceOf(store: ChatStore): (snapshot: ChatSnapshot) => PanelSlice {
  let last: PanelSlice | undefined
  return (snapshot: ChatSnapshot): PanelSlice => {
    const relays = snapshot.relays
    const artifacts = store.artifacts()
    if (last !== undefined && last.relays === relays && last.artifacts === artifacts) return last
    last = { relays, artifacts }
    return last
  }
}

// ---- 按会话分桶的缓存 ----

/** 一个会话的滚动锚点：切走时记下，切回来原样恢复。 */
export interface ScrollAnchor {
  /** 滚动容器的 scrollTop（贴底时为 0，不记具体位置）。 */
  top: number
  /** 可视区高度（窗口化算可视区要用，切回来时这一帧量不到）。 */
  height: number
  /** 视口是不是贴着底部（贴底的会话切回来直接钉底，不记位置）。 */
  atBottom: boolean
}

const BOTTOM_ANCHOR: ScrollAnchor = { top: 0, height: 0, atBottom: true }
const EMPTY_HISTORY: UiMessage[] = []

/** 草稿落盘的去抖窗口（ms）：每次按键都写一次 localStorage 是白花的 IO。 */
const DRAFT_PERSIST_DEBOUNCE_MS = 300

/** 会话桶里那份「切走还要原样」的界面状态。 */
export interface ConversationViewState {
  /** 已加载的历史（往上翻页会前插；断口续接会并入）。 */
  history: UiMessage[]
  /** 上方还有没有更早的历史。 */
  hasMore: boolean
  /** 历史是否已经拉过（切回来时据此决定「复用」还是「重拉」）。 */
  loaded: boolean
  /**
   * 历史拉取失败的一句话原因；空串 = 没有错误。
   * 用空串而不是 undefined，是因为 {@link ConversationBucket.patch} 把 undefined 当成
   * 「这次不碰这个字段」，用它根本清不掉错误。
   */
  historyError: string
  /** 输入框里已输入但没发出去的草稿——切会话绝不能丢的那一串字。 */
  draft: string
  scroll: ScrollAnchor
  conn: 'open' | 'reconnecting'
  connDismissed: boolean
  /** 用户中止过这一轮（中止后不再有 message-done，见 ChatStore.sealIncomplete）。 */
  stopped: boolean
}

const VIEW_FIELDS = [
  'history',
  'hasMore',
  'loaded',
  'historyError',
  'draft',
  'scroll',
  'conn',
  'connDismissed',
  'stopped',
] as const satisfies readonly (keyof ConversationViewState)[]

/**
 * 一个会话的桶：流式状态（{@link ChatStore}）+ 切走还要原样的界面状态。
 *
 * 桶存在的理由是**切会话不该是重新开始**：此前 App 用 `key={active.id}` 让整个聊天区
 * 卸载重建，`store.reset()` 清空消息再重拉一页历史，顺带把输入框里打了半天的那句话一起
 * 扔掉。对一个一天在会话间来回切几十次的产品，这是可感知的卡顿加数据丢失。
 * 有了桶，切会话只是换一个桶：草稿、滚动位置、已加载历史、流式快照原样还在。
 */
export class ConversationBucket {
  readonly id: string
  readonly store: ChatStore
  private view: ConversationViewState = {
    history: EMPTY_HISTORY,
    hasMore: false,
    loaded: false,
    historyError: '',
    draft: '',
    scroll: BOTTOM_ANCHOR,
    conn: 'open',
    connDismissed: false,
    stopped: false,
  }
  private readonly listeners = new Set<() => void>()
  /** 草稿落盘的去抖计时器（null = 没有待写的）。 */
  private draftTimer: ReturnType<typeof setTimeout> | undefined

  constructor(id: string, store: ChatStore = new ChatStore()) {
    this.id = id
    this.store = store
    // 草稿从上一次运行里接回来：重启应用后回到这个会话，那半句话还在。
    const draft = loadDraft(id)
    if (draft.length > 0) this.view = { ...this.view, draft }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getView = (): ConversationViewState => {
    return this.view
  }

  /**
   * 改界面状态；没真变就不通知。
   *
   * 逐字段比身份（history/scroll 按引用比，其余按值比）不是为了省几次重绘，是因为滚动
   * 与输入这两条高频路径每帧都在写：字段没变却发通知，等于把「同一份状态」变成新对象，
   * 订阅者的 memo 全废。
   */
  patch(partial: Partial<ConversationViewState>): void {
    let changed = false
    for (const field of VIEW_FIELDS) {
      const next = partial[field]
      if (next === undefined) continue
      // scroll 是小记录，逐字段比：滚动这条路径每帧都在写，新对象但值一样时不该惊动订阅者。
      if (field === 'scroll') {
        const nextScroll = next as ScrollAnchor
        const current = this.view.scroll
        if (
          nextScroll.top === current.top &&
          nextScroll.height === current.height &&
          nextScroll.atBottom === current.atBottom
        ) {
          continue
        }
        changed = true
        break
      }
      if (next !== this.view[field]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.view = { ...this.view, ...partial }
    for (const listener of this.listeners) listener()
  }

  /**
   * 记下草稿（输入框每次改动都走这里，切会话因此丢不了）。
   *
   * 同时**镜像到 localStorage**：草稿此前只活在内存里，重启应用就没了——一个
   * 下午打到一半的句子因为手滑关了窗口而消失，是那种"软件不可信"的感觉。
   * 写入去抖 300ms（每次按键都写一次 localStorage 是白花的 IO），发出去时
   * 立刻清掉（消息已经在库里了，草稿不该还赖着）。
   */
  setDraft(draft: string): void {
    this.patch({ draft })
    this.persistDraft(draft)
  }

  /** 草稿落盘（去抖）；空串 = 草稿没了，直接删键。 */
  private persistDraft(draft: string): void {
    if (this.draftTimer !== undefined) {
      clearTimeout(this.draftTimer)
      this.draftTimer = undefined
    }
    if (draft.length === 0) {
      clearDraft(this.id)
      return
    }
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined
      saveDraft(this.id, draft)
    }, DRAFT_PERSIST_DEBOUNCE_MS)
  }

  /** 并入一段历史（断口续接 / 搜索定位窗口）：同 key 不重复，按 seq 归位。 */
  mergeHistory(incoming: readonly UiMessage[]): void {
    this.patch({ history: mergeMessages(this.view.history, incoming) })
  }

  /** 已加载历史里最大的服务端 seq：断口续接据此只补「之后」的部分。 */
  lastSeq(): number | undefined {
    let max: number | undefined
    for (const message of this.view.history) {
      if (message.seq === undefined) continue
      if (max === undefined || message.seq > max) max = message.seq
    }
    return max
  }

  dispose(): void {
    this.store.dispose()
    this.listeners.clear()
  }
}

/**
 * 合并一段来自服务端的窗口到已加载历史（纯函数）。
 *
 * 同 key 的不动——定位窗口往往与已加载的那一页重叠，重复插入会让同一条消息在流里出现
 * 两次。新的按 seq 归位，这样「往前翻历史」与「跳到某条命中」两条来路的消息仍然是一条
 * 按时间排好的流。
 */
export function mergeMessages(current: UiMessage[], incoming: readonly UiMessage[]): UiMessage[] {
  if (incoming.length === 0) return current
  const merged = new Map<string, UiMessage>(
    current.map((message) => {
      return [message.key, message]
    }),
  )
  let added = false
  for (const message of incoming) {
    if (merged.has(message.key)) continue
    merged.set(message.key, message)
    added = true
  }
  if (!added) return current
  return [...merged.values()].sort((a, b) => {
    return (a.seq ?? 0) - (b.seq ?? 0)
  })
}

/**
 * 历史是否已按 turnIndex 排好（按数组身份缓存）。
 *
 * 键是数组本身（WeakMap）：流式期间历史数组不换身份，只有重拉历史才换。于是
 * "排好没有"这件事一次算完、之后每帧 O(1) 地问一句。
 */
const sortedHistoryCache = new WeakMap<readonly UiMessage[], boolean>()

function isSortedByTurn(history: readonly UiMessage[]): boolean {
  const cached = sortedHistoryCache.get(history)
  if (cached !== undefined) return cached
  let sorted = true
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1]
    const current = history[index]
    if (previous === undefined || current === undefined) continue
    if (previous.turnIndex > current.turnIndex) {
      sorted = false
      break
    }
  }
  sortedHistoryCache.set(history, sorted)
  return sorted
}

/**
 * 流式那几条是不是全都排在历史之后（常态：是——它们是当前这一轮）。
 *
 * 排不上去的情况：断口续接把更早的一轮补了回来。那种时候老老实实回去排序。
 */
function streamedFitsAfter(history: readonly UiMessage[], streamed: readonly UiMessage[]): boolean {
  if (streamed.length === 0) return true
  const last = history[history.length - 1]
  let previous = last?.turnIndex ?? Number.NEGATIVE_INFINITY
  for (const message of streamed) {
    if (message.turnIndex < previous) return false
    previous = message.turnIndex
  }
  return true
}

/**
 * 历史 + 流式气泡合并成一条按时间排好的时间线（纯函数）。
 *
 * 此前是 `[...history, ...streamed]`：流式永远排在最后。而断口续接补回的缺口是**按
 * seq 归位**进 history 的，于是"补回 turn 3、4 的那几条"会落到已收口的气泡之前——
 * 时间线倒着走，同一轮被切成两块（分别渲染成两个 turn 块），React 还会因为两块
 * 用了同一个 `turnIndex` 做 key 打出 duplicate key 警告。
 *
 * 判据用 turnIndex 而不是 seq：流式气泡没有 seq（seq 由服务端分配），而 turn 在两边
 * 都是单调递增的。`Array.prototype.sort` 是稳定排序（ES2019 起写进规范），所以同一
 * 轮里保持「历史按 seq 在前、流式按到达序在后」——也就是流式那几条本来就是这一轮最后
 * 才到的，顺序不会错。
 *
 * history 非空时总是过一遍排序（包括 streamed 为空的情形）：history 是拼出来的
 * （首屏一页 + 向上翻页前插 + 搜索定位窗口按 seq 并入），其中按 seq 的窗口如果碰上
 * turn 序号与 seq 不完全同序的旧数据，交到这里的顺序就不能再当作已排好。streamed
 * 一侧则天然按到达序追加，history 为空时原样交出即可（排序对它是不做事白走路）。
 *
 * **常态下不排**：历史已经按轮次排好、流式那几条又排在它后面时，拼起来就是排好的
 * ——再排一次是纯浪费。流式每帧都要走这条路径，5000 条历史时那次排序与它的比较器
 * 开销就是每秒十几 MB 垃圾里的一部分。
 */
export function mergeTimeline(history: readonly UiMessage[], streamed: readonly UiMessage[]): UiMessage[] {
  if (history.length === 0) return streamed.slice()
  if (isSortedByTurn(history) && streamedFitsAfter(history, streamed)) {
    return [...history, ...streamed]
  }
  return [...history, ...streamed].sort((a, b) => {
    return a.turnIndex - b.turnIndex
  })
}

/**
 * 缓存的会话数上界。
 *
 * 5 是按用法定的：一天来回切几十次，五个正好覆盖「最近聊过的这几场」；再往上留对内存
 * 的边际收益很小（每桶就是一页历史 + 几个索引），而峰值不可预期才是真问题。
 * 有草稿的桶会排到最后才被逐出（见 {@link createBoundedCache} 的 protected）。
 */
export const MAX_CACHED_CONVERSATIONS = 5

/**
 * 会话桶的冷热窗口（见 {@link ConversationCache}）。
 *
 * 壳（App）持有它，按 conversationId 交出桶：同一个 id 拿到的永远是同一个实例，
 * 于是切会话不需要重建任何组件，只需要换一个订阅对象。
 */
export class ConversationCache {
  private readonly buckets = createBoundedCache<string, ConversationBucket>(MAX_CACHED_CONVERSATIONS, {
    onEvict: (bucket) => {
      bucket.dispose()
    },
    // 有草稿的桶不参与逐出排序的前排：用户正在写的话，比"省几 MB 内存"贵得多。
    protected: (bucket) => {
      return bucket.getView().draft.length > 0
    },
  })
  private agentNames = new Map<string, string>()

  /** 取（或建）某个会话的桶；命中即算「最近用过」。 */
  bucket(id: string): ConversationBucket {
    const existing = this.buckets.get(id)
    if (existing !== undefined) return existing
    const created = new ConversationBucket(id)
    created.store.setAgentNames(this.agentNames)
    return this.buckets.require(id, () => {
      return created
    })
  }

  /** agent 名单对所有已缓存的桶同步（新建的桶在 {@link bucket} 里补上）。 */
  setAgentNames(names: Map<string, string>): void {
    this.agentNames = names
    for (const bucket of this.buckets.values()) bucket.store.setAgentNames(names)
  }

  /** 当前缓存了几个会话（诊断用）。 */
  get size(): number {
    return this.buckets.size
  }
}

/**
 * 把一个已存在的 {@link ChatStore} 包成单会话桶。
 *
 * 供「外面已经拿着 store」（测试、一次性脚本）直接喂给 ChatView 用，省得为了渲染一个
 * 会话先去建一个缓存。
 */
export function bucketOf(store: ChatStore, id = 'adhoc'): ConversationBucket {
  return new ConversationBucket(id, store)
}
