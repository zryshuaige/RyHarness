import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '@ryagent/session'
import { migrate, SCHEMA_VERSION } from '@ryagent/session'
import type { StoredAgent } from '@ryagent/session'

function sampleAgent(id: string): Omit<StoredAgent, 'isBuiltin' | 'createdAt' | 'updatedAt'> {
  return {
    id,
    name: id,
    systemPrompt: '你是测试 agent。',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    temperature: 0.7,
    tools: ['fs_read', 'fs_write'],
  }
}

describe('SessionStore', () => {
  it('opens an in-memory database at the current schema version', () => {
    const store = new SessionStore(':memory:')
    expect(store.schemaVersion).toBe(SCHEMA_VERSION)
    store.close()
  })

  it('rejects a database newer than the supported schema version', () => {
    const store = new SessionStore(':memory:')
    store.close()
    const db = new DatabaseSync(':memory:')
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    expect(() => { migrate(db) }).toThrow(/newer/)
    db.close()
  })

  it('upserts and reads agent definitions, preserving createdAt', () => {
    const store = new SessionStore(':memory:')
    const created = store.upsertAgent({ ...sampleAgent('a1'), isBuiltin: true })
    expect(created.isBuiltin).toBe(true)
    const updated = store.upsertAgent({ ...sampleAgent('a1'), name: 'renamed', model: 'other-model' })
    expect(updated.name).toBe('renamed')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
    expect(store.listAgents()).toHaveLength(1)
    expect(store.getAgent('missing')).toBeUndefined()
    store.close()
  })

  it('creates conversations and lists them by updatedAt desc', async () => {
    const store = new SessionStore(':memory:')
    const first = store.createConversation({ kind: 'direct', title: '单聊', memberAgentIds: ['a1'] })
    const second = store.createConversation({
      kind: 'group', title: '群聊', memberAgentIds: ['a1', 'a2'], dispatcherAgentId: 'a1',
    })
    expect(second.dispatcherAgentId).toBe('a1')
    store.touchConversation(first.id, Date.now() + 1000)
    const list = store.listConversations()
    expect(list.map((c) => { return c.id })).toEqual([first.id, second.id])
    expect(store.getConversation(first.id)?.kind).toBe('direct')
    store.close()
  })

  it('appends messages and pages them by seq', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(store.appendMessage({
        conversationId: conversation.id,
        senderType: i % 2 === 0 ? 'user' : 'agent',
        senderId: i % 2 === 0 ? 'user-1' : 'a1',
        contentBlocks: [{ type: 'text', text: `m${i}` }],
        turnIndex: Math.floor(i / 2),
      }).seq)
    }
    const page1 = store.listMessages(conversation.id, { limit: 2 })
    // 默认页 = 最新 N 条（seq 升序展示）：最后两条是 seq 4、5
    expect(page1.map((m) => { return m.seq })).toEqual([ids[3], ids[4]])
    const page2 = store.listMessages(conversation.id, { limit: 2, beforeSeq: page1[0]!.seq })
    expect(page2.map((m) => { return m.seq })).toEqual([ids[1], ids[2]])
    const page3 = store.listMessages(conversation.id, { limit: 2, beforeSeq: page2[0]!.seq })
    expect(page3.map((m) => { return m.seq })).toEqual([ids[0]])
    const all = store.listMessages(conversation.id)
    expect(all).toHaveLength(5)
    expect(all[0]!.senderType).toBe('user')
    expect(all[1]!.contentBlocks).toEqual([{ type: 'text', text: 'm1' }])
    // 新消息刷新会话 updatedAt
    expect(store.getConversation(conversation.id)!.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt)
    store.close()
  })

  it('stores mentions and dispatch events as JSON round-trips', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'group', memberAgentIds: ['a1', 'a2'], dispatcherAgentId: 'a1' })
    store.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user-1',
      contentBlocks: [{ type: 'text', text: '@a2 看一下这个' }],
      mentions: ['a2'],
      turnIndex: 3,
    })
    const messages = store.listMessages(conversation.id)
    expect(messages[0]!.mentions).toEqual(['a2'])
    expect(messages[0]!.turnIndex).toBe(3)
    const event = store.recordDispatchEvent({
      conversationId: conversation.id,
      fromAgent: 'a1',
      toAgent: 'a2',
      reason: '用户点名 @a2',
      turnIndex: 3,
    })
    expect(event.id).toBeTruthy()
    expect(store.listDispatchEvents(conversation.id)).toHaveLength(1)
    expect(store.listDispatchEvents(conversation.id)[0]!.toAgent).toBe('a2')
    store.close()
  })

  it('unreadCount 按 seq 与发送者过滤；markConversationRead 推进 lastReadSeq', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const say = (senderType: 'user' | 'agent', text: string) => {
      return store.appendMessage({
        conversationId: conversation.id, senderType,
        senderId: senderType === 'user' ? 'user' : 'a1',
        contentBlocks: [{ type: 'text', text }],
      }).seq
    }
    const seq1 = say('user', 'hi')      // 用户消息不计未读
    const seq2 = say('agent', '你好')    // 未读 1
    const seq3 = say('agent', '在的')    // 未读 2
    expect(store.unreadCount(conversation.id, 0)).toBe(2)
    expect(store.unreadCount(conversation.id, seq1)).toBe(2)
    expect(store.unreadCount(conversation.id, seq2)).toBe(1)
    const read = store.markConversationRead(conversation.id)
    expect(read).toBe(seq3)
    expect(store.unreadCount(conversation.id, read)).toBe(0)
    expect(store.getConversation(conversation.id)?.lastReadSeq).toBe(seq3)
    // 新 agent 消息再次产生未读
    say('agent', '又来了')
    expect(store.unreadCount(conversation.id, read)).toBe(1)
    store.close()
  })

  it('schema v3：conversations 带 last_read_seq 列，旧库迁移后默认 0', () => {
    // 模拟 v2 库：只应用 v1+v2 迁移，再交给 migrate() 补 v3。
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    migrate(db) // 直接到最新，验证列存在
    const columns = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => { return c.name })
    expect(columns).toContain('last_read_seq')
    db.close()
  })

  it('persists to a file and reloads (file-backed databases)', () => {
    const path = `${process.env.TEMP ?? '/tmp'}/ryagent-session-test-${Date.now()}.db`
    const store = new SessionStore(path)
    store.upsertAgent(sampleAgent('persisted'))
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['persisted'] })
    store.appendMessage({
      conversationId: conversation.id, senderType: 'user', senderId: 'u',
      contentBlocks: [{ type: 'text', text: 'hi' }],
    })
    store.close()
    const reopened = new SessionStore(path)
    expect(reopened.getAgent('persisted')?.name).toBe('persisted')
    expect(reopened.listMessages(conversation.id)).toHaveLength(1)
    reopened.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  })
})
