import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StampedWsEvent, WsConnectionStatus } from '../renderer/src/api.ts'
import { ApiClient } from '../renderer/src/api.ts'

/** 可控的假 WebSocket：测试手动触发 open/message/close。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closedByClient = false

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  /** 客户端 close：不触发 onclose（与真实 WS 异步事件解耦，测试手动推进）。 */
  close(): void {
    this.closedByClient = true
  }

  open(): void {
    this.onopen?.()
  }

  emit(event: object): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  serverClose(): void {
    this.onclose?.()
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('ApiClient.subscribe 断线重连与 seq 缺口', () => {
  const api = new ApiClient('http://127.0.0.1:9')
  const realWs = globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWs
  })

  it('断开后按退避序列重连，状态回调 reconnecting → open', async () => {
    const statuses: WsConnectionStatus[] = []
    const unsubscribe = api.subscribe('c1', () => {}, {
      reconnectDelays: [5, 1000],
      onStatus: (status) => {
        statuses.push(status)
      },
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.open()
    FakeWebSocket.instances[0]!.serverClose()
    // 首连成功也发 open（2026-11-07 F2 修复）：桶视图持久化的 conn 依赖它归位。
    expect(statuses).toEqual(['open', 'reconnecting'])
    await sleep(30)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1]!.open()
    expect(statuses).toEqual(['open', 'reconnecting', 'open'])
    unsubscribe()
  })

  it('seq 缺口触发 onGap；连续事件不触发', async () => {
    const events: StampedWsEvent[] = []
    let gaps = 0
    const unsubscribe = api.subscribe(
      'c1',
      (event) => {
        events.push(event)
      },
      {
        onGap: () => {
          gaps += 1
        },
      },
    )
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    const delta = (seq: number): object => {
      return { type: 'text-delta', conversationId: 'c1', senderId: 'a', text: 'x', seq }
    }
    ws.emit(delta(1))
    ws.emit(delta(2))
    expect(gaps).toBe(0)
    ws.emit(delta(5)) // 3、4 丢失
    expect(gaps).toBe(1)
    ws.emit(delta(6))
    expect(gaps).toBe(1)
    expect(events).toHaveLength(4)
    unsubscribe()
  })

  it('重连成功（非首次连接）触发 onGap 让调用方补齐断线窗口', async () => {
    let gaps = 0
    const unsubscribe = api.subscribe('c1', () => {}, {
      reconnectDelays: [5],
      onGap: () => {
        gaps += 1
      },
    })
    FakeWebSocket.instances[0]!.open()
    expect(gaps).toBe(0) // 首次连接不算缺口
    FakeWebSocket.instances[0]!.serverClose()
    await sleep(30)
    FakeWebSocket.instances[1]!.open()
    expect(gaps).toBe(1)
    unsubscribe()
  })

  it('退订后不再重连', async () => {
    const unsubscribe = api.subscribe('c1', () => {}, { reconnectDelays: [5] })
    FakeWebSocket.instances[0]!.serverClose()
    unsubscribe()
    await sleep(30)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('退避超过序列末尾后循环使用末值（封顶）', async () => {
    const unsubscribe = api.subscribe('c1', () => {}, { reconnectDelays: [5, 20] })
    FakeWebSocket.instances[0]!.serverClose()
    await sleep(15)
    expect(FakeWebSocket.instances).toHaveLength(2) // 5ms 后第一次重连
    FakeWebSocket.instances[1]!.serverClose()
    await sleep(10)
    expect(FakeWebSocket.instances).toHaveLength(2) // 20ms 未到
    await sleep(30)
    expect(FakeWebSocket.instances).toHaveLength(3)
    FakeWebSocket.instances[2]!.serverClose()
    await sleep(10)
    expect(FakeWebSocket.instances).toHaveLength(3) // 仍用末值 20ms
    await sleep(30)
    expect(FakeWebSocket.instances).toHaveLength(4)
    unsubscribe()
  })
})

/**
 * 首连成功也要发 'open'（2026-11-07 用户视角 debug F2）：
 *
 * setReconnecting 的翻转守卫让「新订阅第一次就连上」变成 no-op——而桶视图里的
 * conn 是跨挂载持久的，上一段生命周期留下的 'reconnecting' 永远没人清：断线恢复
 * 后横幅僵死、点关闭也没用，尽管流式事件一直在正常到达。
 */
describe('ApiClient.subscribe 首连状态', () => {
  const api = new ApiClient('http://127.0.0.1:9')
  const realWs = globalThis.WebSocket
  /** 取第 n 个连接；没有就炸（比 `!` 非空断言多一句人话，也不给 lint 基线添数）。 */
  function socketAt(index: number): FakeWebSocket {
    const ws = FakeWebSocket.instances[index]
    if (ws === undefined) throw new Error(`FakeWebSocket.instances[${index}] 不存在`)
    return ws
  }

  beforeEach(() => {
    FakeWebSocket.instances = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = realWs
  })

  it('第一次连接成功就发 open（此前不发，遗留的 reconnecting 没人清）', () => {
    const statuses: WsConnectionStatus[] = []
    const unsubscribe = api.subscribe('c-first', () => {}, {
      onStatus: (status) => {
        statuses.push(status)
      },
    })
    socketAt(0).open()
    expect(statuses).toContain('open')
    unsubscribe()
  })

  it('open 与物理 onopen 一一对应；重复 open 也不炸（ChatView 侧 patch 幂等）', async () => {
    const statuses: WsConnectionStatus[] = []
    const unsubscribe = api.subscribe('c-flap', () => {}, {
      reconnectDelays: [5],
      onStatus: (status) => {
        statuses.push(status)
      },
    })
    socketAt(0).open()
    socketAt(0).serverClose()
    socketAt(0).open() // 竞态：close 后旧连接又 open
    await sleep(30)
    socketAt(1).open()
    socketAt(1).open() // 同一 socket 二次 open：再发一次也无害
    const openCount = statuses.filter((status) => {
      return status === 'open'
    }).length
    expect(openCount).toBe(4)
    unsubscribe()
  })
})
