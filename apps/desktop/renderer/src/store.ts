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
import { useSyncExternalStore } from 'react'
import type { WsEvent } from './api.ts'

/** 消息内的一个展示部件。 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; arguments: string; status: 'running' | 'done'; isError?: boolean }
  | { kind: 'file'; callId: string; name: string; size: number; mime: string }

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
   * 内容版本号：store 每次改动该消息的 parts/done 自增，供 memo 比较器 O(1) 判断。
   * 由 store 维护；历史消息（ChatView 的 fromHistory）没有此字段，按 0 处理。
   */
  version?: number
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

/** 重绘节流窗口：连续流式事件在窗口内合并成一次重绘（≈25fps）。 */
const NOTIFY_INTERVAL_MS = 40

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
  private agentNames = new Map<string, string>()

  // ---- 索引：把「每次事件扫全量」降为 O(1) ----
  /** 全部在册 key（分配流式 key 时防重）。 */
  private readonly liveKeys = new Set<string>()
  /** stream key → 消息下标。 */
  private readonly streamKeyIndex = new Map<string, number>()
  /** senderId → 正在流式写入的消息下标（miss 或已 done 时回退倒扫）。 */
  private readonly streamingIndex = new Map<string, number>()
  /** callId → 含该 callId 的消息下标（tool-result 定点更新）。 */
  private readonly callIndex = new Map<string, number[]>()

  /** 产物缓存：artifactsVersion 不变时返回同一数组身份（右栏直接复用）。 */
  private artifactsVersion = 0
  private artifactsCache: { version: number; list: ArtifactItem[] } | undefined

  setAgentNames(names: Map<string, string>): void {
    this.agentNames = names
  }

  private nameOf(senderId: string, fallback?: string): string {
    if (senderId === 'user') return '我'
    return this.agentNames.get(senderId) ?? fallback ?? senderId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
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
    this.lastFlushAt = Date.now()
    for (const listener of this.listeners) listener()
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
    this.artifactsVersion += 1
    this.artifactsCache = undefined
    this.notify()
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
        }
        const index = messages.length
        this.liveKeys.add(key)
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
        const index = this.findStreamingIndex(event.senderId)
        if (index < 0) return
        const message = this.snapshot.messages[index]!
        this.emit({
          messages: replaceAt(this.snapshot.messages, index, withParts(message, appendText(message.parts, event.text))),
        })
        return
      }
      case 'tool-call-start': {
        const index = this.findStreamingIndex(event.senderId)
        if (index < 0) return
        const message = this.snapshot.messages[index]!
        this.indexCall(event.callId, index)
        this.emit({
          messages: replaceAt(
            this.snapshot.messages,
            index,
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
          }
          messages = replaceAt(messages, index, withParts(message, parts))
        }
        if (messages === this.snapshot.messages) return
        this.emit({ messages })
        return
      }
      case 'produce-card': {
        const index = this.findStreamingIndex(event.senderId)
        if (index < 0) return
        const message = this.snapshot.messages[index]!
        this.indexCall(event.callId, index)
        this.artifactsVersion += 1
        this.emit({
          messages: replaceAt(
            this.snapshot.messages,
            index,
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
        const index = this.streamKeyIndex.get(key)
        let messages = this.snapshot.messages
        if (index !== undefined) {
          const message = messages[index]
          this.streamKeyIndex.delete(key)
          if (this.streamingIndex.get(event.senderId) === index) this.streamingIndex.delete(event.senderId)
          if (message !== undefined) {
            messages = replaceAt(messages, index, { ...message, done: true, version: (message.version ?? 0) + 1 })
          }
        }
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
        this.emit({ error: { message: event.message, code: event.code } })
        return
      }
      default:
        return
    }
  }

  /** 本地插入用户消息（发送即上屏，不等 WS）。 */
  addUserMessage(text: string, turnIndex: number): void {
    // 重发即视为新一轮：清掉上一条错误横幅。
    const messages = this.snapshot.messages
    const message: UiMessage = {
      key: `user:${Date.now()}:${messages.length}`,
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex,
      parts: [{ kind: 'text', text }],
      done: true,
      version: 0,
    }
    this.liveKeys.add(message.key)
    this.emit({ messages: [...messages, message], clearError: true })
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
}

/** Hook：订阅 store。 */
export function useChat(store: ChatStore): ChatSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
// ---- @提及补全（纯逻辑，供测试）----

/** 从输入文本与光标位置解析 @补全状态；无补全时返回 null。 */
export function mentionQueryAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  const query = before.slice(at + 1)
  // @ 后只允许普通名字字符；遇到空白说明 @ 已结束。
  if (/[\s@]/.test(query)) return null
  return { start: at, query }
}

/** 按 query 过滤候选名字（大小写不敏感包含匹配）。 */
export function filterMentions<T extends { id: string; name: string }>(members: T[], query: string): T[] {
  const lowered = query.toLowerCase()
  return members.filter((member) => {
    return member.name.toLowerCase().includes(lowered)
  })
}
