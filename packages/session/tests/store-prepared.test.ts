import { SessionStore } from '@ryagent/session'
import { describe, expect, it } from 'vitest'

/**
 * 预编译语句缓存：长会话里每翻一页消息、每写一条消息都要发同一条 SQL，
 * 每次重新 prepare 等于把解析与执行计划重做一遍。
 */
function seed(store: SessionStore, turns = 3): string {
  const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['ryen'] })
  for (let i = 0; i < turns; i++) {
    store.appendMessage({
      conversationId: conversation.id,
      senderType: i % 2 === 0 ? 'user' : 'agent',
      senderId: i % 2 === 0 ? 'user' : 'ryen',
      contentBlocks: [{ type: 'text', text: `第 ${i} 条` }],
      turnIndex: i,
      ...(i % 2 === 1 ? { usage: { inputTokens: 10, outputTokens: 20 } } : {}),
    })
  }
  return conversation.id
}

describe('SessionStore 预编译语句缓存', () => {
  it('同一条 SQL 反复执行只解析一次（缓存规模不随调用次数增长）', () => {
    const store = new SessionStore(':memory:')
    const conversationId = seed(store)
    // 三条热路径各预热一次，之后只看缓存规模是否还长。
    store.listMessages(conversationId, { limit: 2 })
    store.listConversationsWithPreview(50)
    store.nextTurnIndex(conversationId)
    const first = store.preparedStats()

    for (let i = 0; i < 200; i++) {
      store.listMessages(conversationId, { limit: 2 })
      store.listConversationsWithPreview(50)
      store.nextTurnIndex(conversationId)
    }
    const second = store.preparedStats()

    expect(second.cached).toBe(first.cached)
    expect(second.reuse).toBeGreaterThanOrEqual(first.reuse + 600)
    store.close()
  })

  it('分页方向不同是两条语句，各自复用', () => {
    const store = new SessionStore(':memory:')
    const conversationId = seed(store, 10)
    const newest = store.listMessages(conversationId, { limit: 3 })
    store.listMessages(conversationId, { limit: 3, beforeSeq: newest[0]!.seq })
    const before = store.preparedStats()

    const older = store.listMessages(conversationId, { limit: 3, beforeSeq: newest[0]!.seq })
    expect(older.map((message) => message.seq)).toEqual([newest[0]!.seq - 3, newest[0]!.seq - 2, newest[0]!.seq - 1])

    const after = store.preparedStats()
    // 两条 SQL 各缓存一次：再取同一页只是命中，不新增条目。
    expect(after.cached).toBe(before.cached)
    expect(after.reuse).toBe(before.reuse + 1)
    store.close()
  })

  it('缓存生效不影响读出内容（usage 只解析一次也不丢）', () => {
    const store = new SessionStore(':memory:')
    const conversationId = seed(store)
    for (let i = 0; i < 5; i++) {
      const messages = store.listMessages(conversationId, { limit: 10 })
      expect(messages).toHaveLength(3)
      expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
      expect(messages[0]?.usage).toBeUndefined()
    }
    expect(store.conversationUsage(conversationId)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      messages: 1,
    })
    store.close()
  })

  it('缓存条目有上界（SQL 文本种类固定时不会无限制增长）', () => {
    const store = new SessionStore(':memory:')
    const conversationId = seed(store)
    // deleteAgent 会按表名拼 SQL（memories / playbook_entries / …），是最容易把
    // 缓存撑大的路径之一：表名不同的 DELETE 各占一条。
    store.upsertAgent({
      id: 'ryen',
      name: 'Ryen',
      systemPrompt: 'p',
      provider: 'siliconflow',
      model: 'm',
      tools: [],
    })
    store.deleteAgent('ryen')
    const stats = store.preparedStats()
    expect(stats.cached).toBeGreaterThan(0)
    expect(stats.cached).toBeLessThanOrEqual(64)
    store.close()
  })
})
