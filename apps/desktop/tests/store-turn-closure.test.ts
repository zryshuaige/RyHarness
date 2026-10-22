/**
 * 「一轮怎么结束」的三条收口约定，全在 ChatStore.apply 里：
 *
 * 1. **error 也要收口**（R1）：真实供应商失败时服务端只发 error、不发 message-done
 *    （apps/server/src/app.ts 的 catch 与 AgentLoop 的 error 分支都是终态事件）。此前
 *    store 只写错误横幅，于是红条弹出而气泡光标继续闪、停止按钮与秒表长亮、onTurnEnd
 *    永不触发——界面一边报错一边说「还在生成」。
 * 2. **同一 sender 同一轮的第二次发言要开新气泡**（R2）：群聊接力允许 A→B→C→A
 *    （loop-guard 只挡上一个与上上个），而服务端每个 sender 每轮只补一次 message-start
 *    （ensureStart），所以 A 的第二段是裸的 text-delta。之前它被整段静默丢弃，刷新后
 *    服务端落库的那段又凭空冒出来。
 * 3. **兜底收口要有护栏与度量**（R3）：message-done 的 key 对不上时按 sender 猜候选，
 *    猜错的方向不对称——提前关掉进行中的一轮会把那句话切成两段。
 */
import { describe, expect, it } from 'vitest'
import { ChatStore, type UiMessage } from '../renderer/src/store.ts'

function start(store: ChatStore, senderId: string, senderName: string, turnIndex: number): void {
  store.apply({ type: 'message-start', conversationId: 'c', senderId, senderName, turnIndex })
}

function delta(store: ChatStore, senderId: string, text: string): void {
  store.apply({ type: 'text-delta', conversationId: 'c', senderId, text })
}

function done(store: ChatStore, senderId: string, turnIndex: number): void {
  store.apply({ type: 'message-done', conversationId: 'c', senderId, turnIndex })
}

function fail(store: ChatStore, code: string, message = 'boom'): void {
  store.apply({ type: 'error', conversationId: 'c', code, message })
}

/** 一个 sender 说完一整段（有 message-start 也有 message-done）。 */
function speak(store: ChatStore, senderId: string, senderName: string, turnIndex: number, text: string): void {
  start(store, senderId, senderName, turnIndex)
  delta(store, senderId, text)
  done(store, senderId, turnIndex)
}

/** 气泡正文（可能有多段文本部件，拼起来便于断言）。 */
function bodyOf(message: UiMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => {
      return part.kind === 'text'
    })
    .map((part) => {
      return part.kind === 'text' ? part.text : ''
    })
    .join('')
}

describe('error 分支把这一轮收口', () => {
  it('供应商真失败：红条弹出时气泡也收口、typing 清空（光标不再闪）', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '半句')
    expect(store.getSnapshot().messages[0]?.done).toBe(false)
    expect(store.getSnapshot().typing).toEqual({})

    fail(store, 'RATE_LIMIT', '429 慢一点')

    const snapshot = store.getSnapshot()
    expect(snapshot.error).toEqual({ message: '429 慢一点', code: 'RATE_LIMIT' })
    expect(snapshot.messages[0]).toMatchObject({ done: true })
    // ChatView 的 streamingActive = typing 非空 || 存在 done=false 的消息：
    // 两处都空 ⇒ 停止按钮熄灭、onTurnEnd 触发。
    expect(snapshot.typing).toEqual({})
    expect(
      snapshot.messages.some((message) => {
        return !message.done
      }),
    ).toBe(false)
    expect(store.metrics().sealedOnError).toBe(1)
  })

  it('error 事件不带 senderId：群聊里其余正在流式的气泡一并收口', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '我看下')
    start(store, 'codebot', 'CodeBot', 0)
    delta(store, 'codebot', '我也在')

    fail(store, 'CONTEXT_WINDOW_EXCEEDED')

    const snapshot = store.getSnapshot()
    expect(
      snapshot.messages.map((message) => {
        return message.done
      }),
    ).toEqual([true, true])
    expect(snapshot.typing).toEqual({})
  })

  it('已完成的旧气泡不受影响：引用与版本号都不动', () => {
    const store = new ChatStore()
    speak(store, 'ryen', 'Ryen', 0, '上一轮')
    const sealedBefore = store.getSnapshot().messages[0]

    start(store, 'ryen', 'Ryen', 1)
    delta(store, 'ryen', '这一轮说一半')
    fail(store, 'TIMEOUT')

    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(2)
    // 结构共享：旧气泡连对象都没换（新快照里仍是同一个引用），没有无谓的重绘。
    expect(messages[0]).toBe(sealedBefore)
    expect(messages[0]?.done).toBe(true)
    expect(messages[1]).toMatchObject({ done: true })
  })

  it('没有在流式的气泡时不收口：红条与收口在同一次通知里到位，不多发一次重绘', () => {
    const store = new ChatStore()
    const before = store.getSnapshot()
    const flushes = store.metrics().flushes

    fail(store, 'DISPATCHER_NOT_MEMBER', '调度员不在成员名单里')

    expect(store.getSnapshot().messages).toBe(before.messages)
    // 一次 emit 就够：先弹红条再收口的话这里会是 2（红条与收口晚一帧才一起到位）。
    expect(store.metrics().flushes).toBe(flushes + 1)
    expect(store.metrics().sealedOnError).toBe(0)
    expect(store.getSnapshot().error).toMatchObject({ code: 'DISPATCHER_NOT_MEMBER' })
  })

  it('「消息没发出去」（HTTP）不收口：那一轮压根没开始，别的 agent 还在说话', () => {
    // 渲染层自己造的码（ChatView.deliver 的 catch）：POST 失败 ≠ 这一轮跑挂了。
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '说到一半')

    fail(store, 'HTTP', 'HTTP 502')

    expect(store.getSnapshot().error).toMatchObject({ code: 'HTTP' })
    expect(store.getSnapshot().messages[0]).toMatchObject({ done: false })
    expect(store.metrics().sealedOnError).toBe(0)

    // 那一轮照常收尾：气泡不被拦腰截断，后面的字也还在同一条里。
    delta(store, 'ryen', '继续说')
    done(store, 'ryen', 0)
    expect(bodyOf(store.getSnapshot().messages[0])).toBe('说到一半继续说')
    expect(store.getSnapshot().messages[0]).toMatchObject({ done: true })
  })
})

describe('同一 sender 同一轮的第二次发言', () => {
  it('裸 text-delta（没有 message-start）也开新气泡，不被静默丢弃', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '第一段')
    done(store, 'ryen', 0)

    // 服务端 ensureStart：A 的第二段没有 message-start。
    delta(store, 'ryen', '第二段')

    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(2)
    expect(bodyOf(messages[1])).toBe('第二段')
    expect(messages[1]).toMatchObject({ done: false, senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    expect(messages[1]?.key).not.toBe(messages[0]?.key)
  })

  it('群聊接力 A→B→C→A：A 的第二段发言完整保留并被正确收口', () => {
    const store = new ChatStore()
    speak(store, 'a1', '阿码', 0, 'A1')
    speak(store, 'b1', '小贝', 0, 'B1')
    speak(store, 'c1', '策策', 0, 'C1')
    // A 第二次发言：裸 delta + 工具 + 产物卡片，全都没有 message-start。
    delta(store, 'a1', 'A2')
    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId: 'a1',
      callId: 'call-2',
      name: 'fs_read',
      arguments: '{}',
    })
    store.apply({
      type: 'produce-card',
      conversationId: 'c',
      senderId: 'a1',
      callId: 'call-2',
      card: { path: '/x/plan.md', name: 'plan.md', size: 12, mime: 'text/markdown' },
    })
    done(store, 'a1', 0)

    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(4)
    const second = messages[3]
    expect(bodyOf(second)).toBe('A2')
    expect(second?.turnIndex).toBe(0)
    expect(
      second?.parts.map((part) => {
        return part.kind
      }),
    ).toEqual(['text', 'tool', 'file'])
    // 前三段仍然是各自的完成态，顺序不变。
    expect(
      messages.slice(0, 3).map((message) => {
        return bodyOf(message)
      }),
    ).toEqual(['A1', 'B1', 'C1'])
    // 收口的是新开的那条，不是 A 的第一段。
    expect(
      messages.map((message) => {
        return message.done
      }),
    ).toEqual([true, true, true, true])
    expect(store.getSnapshot().typing).toEqual({})
    expect(store.artifacts()).toEqual([{ callId: 'call-2', name: 'plan.md', size: 12, mime: 'text/markdown' }])
  })

  it('裸 tool-call-start 也算「开始说话」：新气泡挂上 typing，由随后的 message-done 摘掉', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '第一段')
    done(store, 'ryen', 0)

    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'c1',
      name: 'fs_read',
      arguments: '{}',
    })
    expect(store.getSnapshot().typing).toEqual({ ryen: 1 })
    // 工具结果仍定点写进新气泡。
    store.apply({
      type: 'tool-result',
      conversationId: 'c',
      senderId: 'ryen',
      callId: 'c1',
      name: 'fs_read',
      isError: false,
      content: 'ok',
    })
    done(store, 'ryen', 0)
    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(2)
    expect(messages[1]?.parts[0]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'done' })
    expect(messages[1]).toMatchObject({ done: true })
    expect(store.getSnapshot().typing).toEqual({})
  })

  it('新气泡落在正确的一轮：接力往下一轮推进时，第二段发言不被归到上一轮', () => {
    const store = new ChatStore()
    store.addUserMessage('先答我', 0)
    speak(store, 'ryen', 'Ryen', 0, '第一轮的回答')
    store.addUserMessage('再说', 1)
    speak(store, 'ryen', 'Ryen', 1, '第二轮第一段')
    done(store, 'ryen', 1)
    delta(store, 'ryen', '第二轮第二段')

    const streamed = store.getSnapshot().messages.filter((message) => {
      return message.senderType === 'agent'
    })
    expect(
      streamed.map((message) => {
        return message.turnIndex
      }),
    ).toEqual([0, 1, 1])
  })
})

describe('message-done 的 sender 兜底：度量与护栏', () => {
  it('兜底收口记进度量：最近一次兜底的候选 key、轮次与结局都留痕', () => {
    const store = new ChatStore()
    speak(store, 'ryen', 'Ryen', 3, '第一段')
    delta(store, 'ryen', '第二段')
    done(store, 'ryen', 3)

    const metrics = store.metrics()
    expect(metrics.doneFallbacks).toBe(1)
    expect(metrics.doneFallbackRejected).toBe(0)
    expect(metrics.lastDoneFallback).toEqual({
      senderId: 'ryen',
      turnIndex: 3,
      candidateKey: store.getSnapshot().messages[1]?.key,
      candidateTurnIndex: 3,
      outcome: 'sealed',
    })
  })

  it('候选轮次明显对不上时宁可不收：进行中的一轮不被提前关掉，后续 delta 仍写进同一条', () => {
    const store = new ChatStore()
    // 进行中的是第 5 轮；来的是第 2 轮的迟到 message-done。
    start(store, 'ryen', 'Ryen', 5)
    delta(store, 'ryen', '说到一半')
    done(store, 'ryen', 2)

    const before = store.getSnapshot().messages[0]
    expect(before).toMatchObject({ done: false })
    expect(store.metrics().doneFallbacks).toBe(0)
    expect(store.metrics().doneFallbackRejected).toBe(1)
    expect(store.metrics().lastDoneFallback).toMatchObject({
      senderId: 'ryen',
      turnIndex: 2,
      candidateTurnIndex: 5,
      outcome: 'rejected',
    })

    delta(store, 'ryen', '还在说')
    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(1)
    expect(bodyOf(messages[0])).toBe('说到一半还在说')
    expect(messages[0]).toMatchObject({ done: false })
  })

  it('只差一轮的漂移仍然收口：服务端某一端先自增了一轮不该让气泡一直闪', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 5)
    delta(store, 'ryen', '半句')
    done(store, 'ryen', 6)

    expect(store.getSnapshot().messages[0]).toMatchObject({ done: true })
    expect(store.metrics().doneFallbacks).toBe(1)
    expect(store.metrics().doneFallbackRejected).toBe(0)
    expect(store.getSnapshot().typing).toEqual({})
  })

  it('键对得上时走精确路径，兜底计数不涨', () => {
    const store = new ChatStore()
    speak(store, 'ryen', 'Ryen', 0, '一句话')
    expect(store.metrics().doneFallbacks).toBe(0)
    expect(store.metrics().lastDoneFallback).toBeUndefined()
  })

  it('既没有精确键也没有在流式的气泡：什么都不收，只清 typing', () => {
    const store = new ChatStore()
    start(store, 'ryen', 'Ryen', 0)
    delta(store, 'ryen', '说完')
    done(store, 'ryen', 0)
    const before = store.metrics()

    done(store, 'ryen', 0)

    expect(store.metrics().doneFallbacks).toBe(before.doneFallbacks)
    expect(store.metrics().doneFallbackRejected).toBe(before.doneFallbackRejected)
    expect(store.getSnapshot().messages).toHaveLength(1)
  })
})
