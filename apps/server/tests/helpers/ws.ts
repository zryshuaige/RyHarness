/**
 * 服务端测试共用的 WS 观察窗。
 *
 * 「订阅某个会话的 WS，收一段时间内的事件」——要断言"服务端到底推了什么"的测试
 * 都要用。抄到各文件里会被重复代码门禁判为复制粘贴，所以放在这里。
 * @module @ryharness/server/tests/helpers/ws
 */

import type { WsEvent } from '@ryharness/server'
import WebSocket from 'ws'

/** 一个订阅窗口。 */
export interface EventWindow {
  /** 连接建好（订阅就绪）时兑现。 */
  readonly ready: Promise<void>
  /** 时间到（或提前收够）时兑现，拿到这段时间里收到的全部事件。 */
  readonly events: Promise<WsEvent[]>
}

/**
 * 订阅一个会话的 WS，收 ms 毫秒。
 *
 * 刻意不做"收够就停"：有的断言要数"一共推了几条"，提前停会把后面几条漏掉。
 */
export function watchConversation(base: string, conversationId: string, ms: number): EventWindow {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
  const received: WsEvent[] = []
  const ready = new Promise<void>((resolve) => {
    socket.on('open', () => {
      resolve()
    })
  })
  const events = new Promise<WsEvent[]>((resolve) => {
    socket.on('message', (raw) => {
      received.push(JSON.parse(String(raw)) as WsEvent)
    })
    setTimeout(() => {
      socket.terminate()
      resolve(received)
    }, ms)
  })
  return { ready, events }
}

/** 按类型挑出事件里的一类。 */
export function eventsOfType<T extends WsEvent['type']>(
  events: readonly WsEvent[],
  type: T,
): Extract<WsEvent, { type: T }>[] {
  return events.filter((event): event is Extract<WsEvent, { type: T }> => {
    return event.type === type
  })
}
