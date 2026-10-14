import { describe, expect, it } from 'vitest'
import { ChatStore } from '../renderer/src/store.ts'

/**
 * ChatStore 的两条长会话护栏：索引有上界（内存不随会话长度线性涨），
 * 以及一条能回答「这一轮重绘了多少次」的本地度量。
 */
function streamTurn(store: ChatStore, senderId: string, turnIndex: number, callId?: string): void {
  store.apply({
    type: 'message-start',
    conversationId: 'c',
    senderId,
    senderName: senderId,
    turnIndex,
  })
  if (callId !== undefined) {
    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId,
      callId,
      name: 'fs_read',
      arguments: '{}',
    })
  }
  store.apply({ type: 'message-done', conversationId: 'c', senderId, turnIndex })
}

describe('ChatStore 长会话上界', () => {
  it('几千轮之后索引表不再增长（消息本身还在，内存不会跟着会话长度线性涨）', () => {
    const store = new ChatStore()
    for (let turn = 0; turn < 3000; turn++) streamTurn(store, 'ryen', turn, `call-${turn}`)

    const stats = store.metrics()
    expect(stats.messages).toBe(3000)
    // 索引上界是实现细节，这里只断言「远小于消息数」——具体上限见 trimIndex 的常量。
    const sizes = store as unknown as { liveKeys: Set<string>; callIndex: Map<string, number[]> }
    expect(sizes.liveKeys.size).toBeLessThan(1000)
    expect(sizes.callIndex.size).toBeLessThan(1000)
  })

  it('最近一轮的工具结果仍然能定点更新（截断的是最旧的条目，不是最新的）', () => {
    const store = new ChatStore()
    for (let turn = 0; turn < 3000; turn++) streamTurn(store, 'ryen', turn, `call-${turn}`)

    // 最后一轮：tool-call-start → tool-result 的定点更新路径没被上界打断。
    store.apply({
      type: 'message-start',
      conversationId: 'c',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex: 3000,
    })
    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'latest',
      name: 'fs_read',
      arguments: '{}',
    })
    store.apply({
      type: 'tool-result',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'latest',
      name: 'fs_read',
      isError: false,
      content: 'ok',
    })
    const last = store.getSnapshot().messages.at(-1)
    expect(last?.parts[0]).toMatchObject({ kind: 'tool', callId: 'latest', status: 'done', isError: false })
  })

  it('reset 后索引清空，key 防重能力恢复', () => {
    const store = new ChatStore()
    for (let turn = 0; turn < 2000; turn++) streamTurn(store, 'ryen', turn)
    store.reset()
    const sizes = store as unknown as { liveKeys: Set<string>; callIndex: Map<string, number[]> }
    expect(sizes.liveKeys.size).toBe(0)
    expect(sizes.callIndex.size).toBe(0)
  })
})

describe('ChatStore 度量', () => {
  it('事件数与重绘数都记着，且重绘远少于事件（40ms 合批在起作用）', () => {
    const store = new ChatStore()
    let flushes = 0
    store.subscribe(() => {
      flushes += 1
    })
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    for (let i = 0; i < 50; i++) {
      store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: `字${i}` })
    }
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'ryen', turnIndex: 0 })

    const metrics = store.metrics()
    expect(metrics.events).toBe(52)
    expect(metrics.messages).toBe(1)
    expect(metrics.parts).toBe(1)
    expect(metrics.flushes).toBe(flushes)
    expect(metrics.flushes).toBeLessThan(metrics.events)
    expect(metrics.lastFlushMs).toBeGreaterThanOrEqual(0)
  })
})
