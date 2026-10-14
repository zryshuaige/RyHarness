import { describe, expect, it } from 'vitest'
import { ChatStore, composeMessageText, formatSize } from '../renderer/src/store.ts'

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

  it('首个 text-delta 即清 typing：不与正在出字的气泡并存，message-done 幂等兜底', () => {
    const store = new ChatStore()
    store.apply({ type: 'message-start', conversationId: 'c', senderId: 'ryen', senderName: 'Ryen', turnIndex: 0 })
    expect(store.getSnapshot().typing).toEqual({ ryen: 1 })
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '你' })
    expect(store.getSnapshot().typing).toEqual({})
    // 气泡还在写：消息本身必须仍是未完成态（停止按钮据此判活）
    expect(store.getSnapshot().messages[0]?.done).toBe(false)
    store.apply({ type: 'text-delta', conversationId: 'c', senderId: 'ryen', text: '好' })
    expect(store.getSnapshot().typing).toEqual({})
    store.apply({ type: 'message-done', conversationId: 'c', senderId: 'ryen', turnIndex: 0 })
    expect(store.getSnapshot().typing).toEqual({})
    expect(store.getSnapshot().messages[0]).toMatchObject({ done: true })
  })

  it('用户附件按 file 部件上屏（与产物卡片同一条渲染通道）', () => {
    const store = new ChatStore()
    store.addUserMessage('看下这个', 3, [{ name: 'shot.png', size: 2048, mime: 'image/png' }])
    const message = store.getSnapshot().messages[0]
    expect(message).toMatchObject({ senderType: 'user', turnIndex: 3, done: true })
    expect(message?.parts[0]).toEqual({ kind: 'text', text: '看下这个' })
    expect(message?.parts[1]).toMatchObject({ kind: 'file', name: 'shot.png', size: 2048, mime: 'image/png' })
    expect(store.artifacts()).toEqual([{ callId: expect.any(String), name: 'shot.png', size: 2048, mime: 'image/png' }])
  })

  it('纯附件消息不发空文本块', () => {
    const store = new ChatStore()
    store.addUserMessage('', 0, [{ name: 'a.txt', size: 10, mime: 'text/plain' }])
    expect(store.getSnapshot().messages[0]?.parts).toHaveLength(1)
    expect(store.getSnapshot().messages[0]?.parts[0]).toMatchObject({ kind: 'file' })
  })

  it('composeMessageText：正文 + 附件记述；无附件时就是正文本身', () => {
    expect(composeMessageText('  帮我看看  ')).toBe('帮我看看')
    expect(composeMessageText('帮我看看', [{ name: 'report.pdf', size: 1536, mime: 'application/pdf' }])).toBe(
      '帮我看看\n[附件] report.pdf（1.5 KB，application/pdf）',
    )
    // 只有附件时正文不能为空，否则服务端会以 body.text 缺失拒收
    expect(composeMessageText('', [{ name: 'a.png', size: 512, mime: 'image/png' }])).toBe(
      '[附件] a.png（512 B，image/png）',
    )
  })

  it('formatSize 三档', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
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
