/**
 * 断口续接之后「同一条发言」只留一份（R3，纯逻辑）。
 *
 * 补回来的那一份来自服务端落库（key `hist:<id>`），屏上那一份是流式气泡（key
 * `stream:<sender>:<turn>`，用户自己发的是 `user:<时间戳>:<序>`）。两边 key 不同，
 * store 的 mergeMessages 只按 key 去重——于是背压 terminate / 心跳超时 / 休眠唤醒之后，
 * 同一条发言在时间线上出现两次。
 *
 * 期望值是"留历史那一份"：它带服务端消息 id（搜索定位、高亮、反馈去重都靠它），而且是
 * 完整正文；流式副本被掐断时可能只有半句。正文对不上就一条都不动——宁可多显示一条，
 * 也不替用户猜哪句是假的。
 */
import { describe, expect, it } from 'vitest'
import { reconcileStreamed } from '../renderer/src/lib/stream-history.ts'
import type { MessagePart, UiMessage } from '../renderer/src/store.ts'

/** 一条消息：默认就是一句纯文本。 */
function message(partial: Partial<UiMessage> & Pick<UiMessage, 'key'>): UiMessage {
  return {
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    parts: [{ kind: 'text', text: '' }],
    done: true,
    ...partial,
  }
}

function text(key: string, body: string, partial: Partial<UiMessage> = {}): UiMessage {
  return message({ key, parts: [{ kind: 'text', text: body }], ...partial })
}

function tool(key: string, callId: string, partial: Partial<UiMessage> = {}): UiMessage {
  return message({ key, parts: [{ kind: 'tool', callId, name: 'fs_read', arguments: '', status: 'done' }], ...partial })
}

function keysOf(messages: readonly UiMessage[]): string[] {
  return messages.map((item) => {
    return item.key
  })
}

describe('reconcileStreamed：断口续接不产生第二份', () => {
  it('屏上那条流式副本被去掉，历史那一份留着', () => {
    const history = [text('hist:m4', 'turn 3 的回复', { turnIndex: 3, seq: 4 })]
    const streamed = [text('stream:ryen:3', 'turn 3 的回复', { turnIndex: 3 })]
    const result = reconcileStreamed(history, streamed)
    expect(keysOf(result.streamed)).toEqual([])
    expect(result.history).toBe(history)
  })

  it('流式只吐了一半时，留下的那份是完整的（不是把半句留在屏上）', () => {
    const history = [text('hist:m4', 'turn 3 的回复，补完了。', { turnIndex: 3, seq: 4 })]
    const streamed = [text('stream:ryen:3', 'turn 3 的回', { turnIndex: 3 })]
    const result = reconcileStreamed(history, streamed)
    expect(keysOf(result.streamed)).toEqual([])
    expect(result.history[0]?.key).toBe('hist:m4')
  })

  it('用户自己那条被补回两次也一样只留一份（键形态不同：user:… vs hist:…）', () => {
    const history = [
      text('hist:m5', '帮我看下这个', { senderType: 'user', senderId: 'user', senderName: '我', turnIndex: 3, seq: 5 }),
    ]
    const streamed = [
      text('user:1700000000000:2', '帮我看下这个', {
        senderType: 'user',
        senderId: 'user',
        senderName: '我',
        turnIndex: 3,
      }),
    ]
    expect(keysOf(reconcileStreamed(history, streamed).streamed)).toEqual([])
  })

  it('同一轮里同一 agent 说了两次：两条历史各留一条，不并成一条', () => {
    const history = [
      text('hist:a', '先看日志', { turnIndex: 3, seq: 4 }),
      text('hist:b', '再看配置', { turnIndex: 3, seq: 6 }),
    ]
    const streamed = [
      text('stream:ryen:3', '先看日志', { turnIndex: 3 }),
      text('stream:ryen:3#2', '再看配置', { turnIndex: 3 }),
    ]
    const result = reconcileStreamed(history, streamed)
    expect(keysOf(result.streamed)).toEqual([])
    expect(keysOf(result.history)).toEqual(['hist:a', 'hist:b'])
  })

  it('工具行没有正文可比：按 callId 配对（一次工具调用不出现两次）', () => {
    const history = [tool('hist:t1', 'call-1', { turnIndex: 2, seq: 3 })]
    const streamed = [tool('stream:ryen:2', 'call-1', { turnIndex: 2 })]
    expect(keysOf(reconcileStreamed(history, streamed).streamed)).toEqual([])
  })

  it('正文对不上就不动：宁可多显示一条，也不替用户删掉他真说过的话', () => {
    const history = [text('hist:m4', '这是另一条消息', { turnIndex: 3, seq: 4 })]
    const streamed = [text('stream:ryen:3', 'turn 3 的回复', { turnIndex: 3 })]
    const result = reconcileStreamed(history, streamed)
    expect(keysOf(result.streamed)).toEqual(['stream:ryen:3'])
    expect(result.history).toBe(history)
  })

  it('只有一方有正文时不配对（拿一条有话的行顶替没话的，等于把话弄丢）', () => {
    const history = [tool('hist:t1', 'call-1', { turnIndex: 2, seq: 3 })]
    const streamed = [
      message({
        key: 'stream:ryen:2',
        turnIndex: 2,
        parts: [
          { kind: 'text', text: '我看下' },
          { kind: 'tool', callId: 'call-1', name: 'fs_read', arguments: '', status: 'done' },
        ] satisfies MessagePart[],
      }),
    ]
    expect(keysOf(reconcileStreamed(history, streamed).streamed)).toEqual(['stream:ryen:2'])
  })

  it('不相关的轮次/发言者互不影响（没补到的那些流式气泡一条都不动）', () => {
    const history = [text('hist:m4', 'turn 3 的回复', { turnIndex: 3, seq: 4 })]
    const streamed = [
      text('stream:ryen:4', 'turn 4 的回复', { turnIndex: 4 }),
      text('stream:nova:3', 'turn 3 的回复', { turnIndex: 3, senderId: 'nova' }),
    ]
    expect(keysOf(reconcileStreamed(history, streamed).streamed)).toEqual(['stream:ryen:4', 'stream:nova:3'])
  })

  it('历史为空 / 流式为空时原样返回（首屏与常态路径不多分配数组）', () => {
    const history = [text('hist:m1', '你好', { seq: 1 })]
    const streamed = [text('stream:ryen:1', '你好', { turnIndex: 0 })]
    const empty = reconcileStreamed([], streamed)
    expect(empty.history).toEqual([])
    expect(empty.streamed).toBe(streamed)
    const noStream = reconcileStreamed(history, [])
    expect(noStream.history).toBe(history)
    expect(noStream.streamed).toEqual([])
  })
})
