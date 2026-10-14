/**
 * 会话事件总线：HTTP 处理把协调器事件流转成 WsEvent 发布，
 * WS 连接按 conversationId 订阅收事件。
 *
 * 发布时给每条事件打上该会话内单调递增的 seq（无论是否有订阅者都递增，
 * 断线重连的客户端据此发现缺口）；seq 计数随进程生命周期保留。
 * @module @ryagent/server/bus
 */

import type { StampedWsEvent, WsEvent } from './events.ts'

type Listener = (event: StampedWsEvent) => void

/** 进程内事件总线（单进程模型：Electron 内嵌或独立 node）。 */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly seqs = new Map<string, number>()

  /**
   * 该会话已发布到的最后一个 seq（没有事件时为 0）。
   * 客户端在握手前读一次当缺口检测的基线：没有基线时，订阅建立之前发布的
   * 事件对客户端是隐形的（欢迎页「先发消息、后建订阅」就是丢在这一段）。
   */
  lastSeq(conversationId: string): number {
    return this.seqs.get(conversationId) ?? 0
  }

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

  /** 发布事件给该会话的全部订阅者（先打 seq，再投递）。 */
  publish(event: WsEvent): void {
    const seq = (this.seqs.get(event.conversationId) ?? 0) + 1
    this.seqs.set(event.conversationId, seq)
    const stamped: StampedWsEvent = { ...event, seq }
    const set = this.listeners.get(event.conversationId)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(stamped)
      } catch {
        // 单个订阅者故障不影响其他订阅者与发布方。
      }
    }
  }
}
