/**
 * 轻量会话状态 store：React hooks + useSyncExternalStore。
 * 把 WS 事件流折叠成 UI 状态（消息、流式增量、工具行、产物卡片、接力链、输入中）。
 */
import { useSyncExternalStore } from 'react'
import type { WsEvent } from './api.ts'

/** 消息内的一个展示部件。 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; arguments: string; status: 'running' | 'done'; isError?: boolean }
  | { kind: 'file'; callId: string; name: string; size: number; mime: string }

export interface UiMessage {
  /** 流式期间用 senderId 作 key；message-done 后换行 id。 */
  key: string
  senderType: 'user' | 'agent' | 'system'
  senderId: string
  senderName: string
  turnIndex: number
  parts: MessagePart[]
  /** 已完整落库（message-done）。 */
  done: boolean
}

export interface RelayItem {
  fromAgent?: string
  toAgent: string
  reason: string
  turnIndex: number
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

/** 一条消息内文本部件的累积写入辅助。 */
function appendText(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1]
  if (last !== undefined && last.kind === 'text') last.text += text
  else parts.push({ kind: 'text', text })
}

export class ChatStore {
  private snapshot: ChatSnapshot = EMPTY
  private listeners = new Set<() => void>()
  private agentNames = new Map<string, string>()

  setAgentNames(names: Map<string, string>): void {
    this.agentNames = names
  }

  private nameOf(senderId: string, fallback?: string): string {
    if (senderId === 'user') return '我'
    return this.agentNames.get(senderId) ?? fallback ?? senderId
  }

  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ChatSnapshot => {
    return this.snapshot
  }

  private mutate(fn: (draft: ChatSnapshot) => void): void {
    const draft: ChatSnapshot = {
      messages: this.snapshot.messages.map((m) => { return { ...m, parts: [...m.parts] } }),
      relays: [...this.snapshot.relays],
      typing: { ...this.snapshot.typing },
      queueing: this.snapshot.queueing,
      ...this.snapshot.error === undefined ? {} : { error: this.snapshot.error },
    }
    fn(draft)
    this.snapshot = draft
    for (const listener of this.listeners) listener()
  }

  reset(): void {
    this.snapshot = EMPTY
    for (const listener of this.listeners) listener()
  }

  /** 折叠一条 WS 事件。 */
  apply(event: WsEvent): void {
    switch (event.type) {
      case 'message-start': {
        if (event.senderId === 'user') {
          // 用户消息行由发送方本地插入（send 时），这里只补 agent 的。
          return
        }
        this.mutate((draft) => {
          const key = this.streamingKey(event.senderId, event.turnIndex)
          if (draft.messages.some((m) => { return m.key === key })) return
          draft.messages.push({
            key, senderType: 'agent', senderId: event.senderId,
            senderName: this.nameOf(event.senderId, event.senderName),
            turnIndex: event.turnIndex, parts: [], done: false,
          })
          draft.typing[event.senderId] = (draft.typing[event.senderId] ?? 0) + 1
        })
        return
      }
      case 'text-delta': {
        this.mutate((draft) => {
          const message = this.findStreaming(draft, event.senderId)
          if (message !== undefined) appendText(message.parts, event.text)
        })
        return
      }
      case 'tool-call-start': {
        this.mutate((draft) => {
          const message = this.findStreaming(draft, event.senderId)
          if (message === undefined) return
          message.parts.push({
            kind: 'tool', callId: event.callId, name: event.name,
            arguments: event.arguments, status: 'running',
          })
        })
        return
      }
      case 'tool-result': {
        this.mutate((draft) => {
          for (const message of draft.messages) {
            const tool = message.parts.find((part) => { return part.kind === 'tool' && part.callId === event.callId })
            if (tool !== undefined && tool.kind === 'tool') {
              tool.status = 'done'
              tool.isError = event.isError
            }
          }
        })
        return
      }
      case 'produce-card': {
        this.mutate((draft) => {
          const message = this.findStreaming(draft, event.senderId)
          if (message === undefined) return
          message.parts.push({
            kind: 'file', callId: event.callId,
            name: event.card.name, size: event.card.size, mime: event.card.mime,
          })
        })
        return
      }
      case 'dispatch': {
        this.mutate((draft) => {
          draft.relays.push({
            ...event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent },
            toAgent: event.toAgent, reason: event.reason, turnIndex: event.turnIndex,
          })
        })
        return
      }
      case 'message-done': {
        this.mutate((draft) => {
          draft.queueing = false
          const key = this.streamingKey(event.senderId, event.turnIndex)
          const index = draft.messages.findIndex((m) => { return m.key === key })
          if (index >= 0) {
            draft.messages[index]!.key = `done:${event.senderId}:${event.turnIndex}:${index}`
            draft.messages[index]!.done = true
          }
          const remaining = (draft.typing[event.senderId] ?? 1) - 1
          if (remaining <= 0) delete draft.typing[event.senderId]
          else draft.typing[event.senderId] = remaining
        })
        return
      }
      case 'queued': {
        this.mutate((draft) => {
          draft.queueing = true
        })
        return
      }
      case 'error': {
        this.mutate((draft) => {
          draft.error = { message: event.message, code: event.code }
        })
        return
      }
      default:
        return
    }
  }

  /** 本地插入用户消息（发送即上屏，不等 WS）。 */
  addUserMessage(text: string, turnIndex: number): void {
    this.mutate((draft) => {
      draft.messages.push({
        key: `user:${Date.now()}`,
        senderType: 'user', senderId: 'user', senderName: '我',
        turnIndex, parts: [{ kind: 'text', text }], done: true,
      })
    })
  }

  private streamingKey(senderId: string, turnIndex: number): string {
    return `stream:${senderId}:${turnIndex}`
  }

  private findStreaming(draft: ChatSnapshot, senderId: string): UiMessage | undefined {
    // 从后往前找该 sender 最近的未完成消息。
    for (let i = draft.messages.length - 1; i >= 0; i--) {
      const message = draft.messages[i]!
      if (message.senderId === senderId && !message.done && message.senderType === 'agent') return message
    }
    return undefined
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
  return members.filter((member) => { return member.name.toLowerCase().includes(lowered) })
}
