/**
 * 会话事件总线：HTTP 处理把协调器事件流转成 WsEvent 发布，
 * WS 连接按 conversationId 订阅收事件。
 * @module @ryagent/server/bus
 */

import type { WsEvent } from './events.ts'

type Listener = (event: WsEvent) => void

/** 进程内事件总线（单进程模型：Electron 内嵌或独立 node）。 */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>()

  /** 订阅一个会话的事件；返回退订函数。 */
  subscribe(conversationId: string, listener: Listener): () => void {
    let set = this.listeners.get(conversationId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(conversationId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(conversationId)
    }
  }

  /** 发布事件给该会话的全部订阅者。 */
  publish(event: WsEvent): void {
    const set = this.listeners.get(event.conversationId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(event)
      } catch {
        // 单个订阅者故障不影响其他订阅者与发布方。
      }
    }
  }
}
