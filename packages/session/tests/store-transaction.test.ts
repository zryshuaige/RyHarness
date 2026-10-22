import type { StoredUsage } from '@ryharness/session'
import { SessionStore } from '@ryharness/session'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('appendMessage 写路径事务', () => {
  const spies: { mockRestore: () => void }[] = []
  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore()
  })

  it('一个事务里三写全部生效：消息行 + 会话 touch + FTS 索引', async () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const before = store.getConversation(conversation.id)!.updatedAt
    await new Promise((resolve) => {
      return setTimeout(resolve, 5)
    })
    const row = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'text', text: '三写同事务' }],
    })
    expect(store.listMessages(conversation.id)).toHaveLength(1)
    expect(row.seq).toBe(1)
    // touch 与 FTS 都在同一个事务里生效
    expect(store.getConversation(conversation.id)!.updatedAt).toBeGreaterThan(before)
    expect(store.messageIndexSize()).toBe(1)
    store.close()
  })

  it('中途失败（FTS 写入抛错）→ 整体回滚，不留半条消息，seq 也不留空洞', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const prototype = SessionStore.prototype as unknown as {
      indexMessage: (seq: number, contentBlocks: unknown[]) => void
    }
    const spy = vi.spyOn(prototype, 'indexMessage').mockImplementation(() => {
      throw new Error('fts boom')
    })
    spies.push(spy)
    expect(() => {
      store.appendMessage({
        conversationId: conversation.id,
        senderType: 'agent',
        senderId: 'a1',
        contentBlocks: [{ type: 'text', text: '半条消息' }],
      })
    }).toThrow('fts boom')
    spy.mockRestore()
    // 消息行、FTS 索引都被回滚
    expect(store.listMessages(conversation.id)).toEqual([])
    expect(store.messageIndexSize()).toBe(0)
    // AUTOINCREMENT 序列随事务回滚，下一条消息从 1 开始
    const next = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '重来' }],
    })
    expect(next.seq).toBe(1)
    expect(store.messageIndexSize()).toBe(1)
    store.close()
  })

  it('中途失败（会话 touch 抛错）→ 消息 INSERT 一并回滚', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const prototype = SessionStore.prototype as unknown as {
      touchConversation: (id: string, now?: number) => void
    }
    const spy = vi.spyOn(prototype, 'touchConversation').mockImplementation(() => {
      throw new Error('touch boom')
    })
    spies.push(spy)
    expect(() => {
      store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '半条消息' }],
      })
    }).toThrow('touch boom')
    spy.mockRestore()
    expect(store.listMessages(conversation.id)).toEqual([])
    expect(store.messageIndexSize()).toBe(0)
    store.close()
  })

  it('usage 随同一条 INSERT 写入；attachUsage 保留为后到 usage 的后补路径', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const usage: StoredUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
    const withUsage = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'text', text: '带用量' }],
      usage,
    })
    expect(withUsage.usage).toEqual(usage)
    const late = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'text', text: '后补用量' }],
    })
    expect(late.usage).toBeUndefined()
    store.attachUsage(late.id, usage)
    const rows = store.listMessages(conversation.id)
    expect(rows[0]!.usage).toEqual(usage)
    expect(rows[1]!.usage).toEqual(usage)
    const totals = store.conversationUsage(conversation.id)
    expect(totals).toEqual({ inputTokens: 22, outputTokens: 14, totalTokens: 36, messages: 2 })
    store.close()
  })
})
