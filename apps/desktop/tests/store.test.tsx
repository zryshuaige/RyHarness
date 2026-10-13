import { describe, expect, it } from 'vitest'
import { ChatStore } from '../renderer/src/store.ts'

function collect(store: ChatStore) {
  const events: unknown[] = []
  store.subscribe(() => {
    events.push(store.getSnapshot())
  })
  return events
}

describe('ChatStore 事件折叠', () => {
  it('message-start/delta/done 折叠成一条完成的 agent 消息', () => {
    const store = new ChatStore()
    store.setAgentNames(new Map([['ryen', 'Ryen']]))
    collect(store)
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '你' })
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '好' })
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'ryen', turnIndex: 0 })
    const snapshot = store.getSnapshot()
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]).toMatchObject({ senderId: 'ryen', senderName: 'Ryen', done: true })
    expect(snapshot.messages[0]!.parts[0]).toEqual({ kind: 'text', text: '你好' })
    expect(snapshot.typing).toEqual({})
  })

  it('tool-result 把对应工具行从 running 标为 done；produce-card 追加文件部件', () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'a1', senderName: 'A', turnIndex: 0 })
    store.apply({
      type: 'tool-call-start',
      conversationId: 'c',
      senderId: 'a1',
      callId: 'c1',
      name: 'file_produce',
      arguments: '{}',
    })
    store.apply({
      type: 'produce-card',
      conversationId: 'c',
      senderId: 'a1',
      callId: 'c1',
      card: { path: '/x/report.md', name: 'report.md', size: 10, mime: 'text/markdown' },
    })
    store.apply({
      type: 'tool-result',
      conversationId: 'c',
      senderId: 'a1',
      callId: 'c1',
      name: 'file_produce',
      isError: false,
      content: 'ok',
    })
    const parts = store.getSnapshot().messages[0]!.parts
    expect(parts[0]).toMatchObject({ kind: 'tool', status: 'done' })
    expect(parts[1]).toMatchObject({ kind: 'file', name: 'report.md' })
  })

  it('dispatch 进入接力链；error 记录错误', () => {
    const store = new ChatStore()
    store.apply({
      type: 'dispatch',
      conversationId: 'c',
      fromAgent: 'ryen',
      toAgent: 'codebot',
      reason: 'relay @CodeBot',
      turnIndex: 0,
    })
    store.apply({ type: 'error', conversationId: 'c', message: 'boom', code: 'QUOTA' })
    const snapshot = store.getSnapshot()
    expect(snapshot.relays).toHaveLength(1)
    expect(snapshot.error).toEqual({ message: 'boom', code: 'QUOTA' })
  })

  it('queued 事件置排队状态，message-done 解除', () => {
    const store = new ChatStore()
    expect(store.getSnapshot().queueing).toBe(false)
    store.apply({ type: 'queued', conversationId: 'c', senderId: 'user', turnIndex: 1 })
    expect(store.getSnapshot().queueing).toBe(true)
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'ryen', turnIndex: 0 })
    expect(store.getSnapshot().queueing).toBe(false)
  })

  it('多个 agent 的流式消息互不串扰', () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: 'A' })
    store.apply({
      type: 'message-start',
      conversationId: 'c',
      senderId: 'codebot',
      senderName: 'CodeBot',
      turnIndex: 0,
    })
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'codebot', text: 'B' })
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'ryen', turnIndex: 0 })
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'codebot', turnIndex: 0 })
    const messages = store.getSnapshot().messages
    expect(messages).toHaveLength(2)
    expect(messages[0]!.parts[0]).toMatchObject({ text: 'A' })
    expect(messages[1]!.parts[0]).toMatchObject({ text: 'B' })
  })
})
