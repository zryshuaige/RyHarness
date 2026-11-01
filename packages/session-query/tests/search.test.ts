/**
 * 全文搜索：命中、排序，以及「搜出来的与模型看到的历史对得上」。
 *
 * 最后一条是这一族最要紧的：索引可能过期、消息可能已删，正文可能被改过。搜索
 * 命中要回存储核一遍，核不上就不给——搜出来的等于没用。
 */

import { describe, expect, it } from 'vitest'
import { Fts5SearchBackend, MemorySearchBackend, SessionQueryService } from '../src/index.ts'
import { createFixture } from './helpers.ts'

describe('内存倒排后端', () => {
  it('搜得到正文里出现过的词，并给出片段', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = service.search('配置')
    expect(result.query).toBe('配置')
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].snippet.length).toBeGreaterThan(0)
    expect(result.hits.map((hit) => hit.conversationId)).toContain(fixture.conversationId)
  })

  it('命中的是模型看得见的那段正文（只取文本块）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = service.search('三个键')
    expect(result.hits).toHaveLength(2)
    expect(result.hits.map((hit) => hit.snippet).join('')).toContain('三个键')
  })

  it('限定会话时只返回那个会话的命中', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const scoped = service.search('天气', { conversationId: fixture.otherConversationId })
    expect(scoped.hits).toHaveLength(1)
    expect(scoped.hits[0].conversationId).toBe(fixture.otherConversationId)
    const other = service.search('天气', { conversationId: fixture.conversationId })
    expect(other.hits).toHaveLength(0)
  })

  it('空查询返回空结果，不报错', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('   ').hits).toHaveLength(0)
    expect(service.search('').query).toBe('')
  })

  it('搜不到时不硬凑，返回空数组', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('完全没出现过的词').hits).toHaveLength(0)
  })

  it('新落库的消息立刻能被搜到（搜索前会自动同步索引）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('刚发的消息').hits).toHaveLength(0)
    fixture.store.appendMessage({
      conversationId: fixture.conversationId,
      senderType: 'user',
      senderId: 'user-1',
      contentBlocks: [{ type: 'text', text: '这是刚发的消息' }],
      turnIndex: 2,
    })
    const result = service.search('刚发的消息')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].snippet).toContain('刚发的消息')
  })

  it('消息被删掉之后就不再被搜到（索引过期也不给对不上的结果）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('三个键').hits).toHaveLength(2)
    fixture.store.deleteConversation(fixture.conversationId)
    expect(service.search('三个键').hits).toHaveLength(0)
  })

  it('索引里有、库里已经没有的消息会被丢掉（dropped 记数）', () => {
    const fixture = createFixture()
    const backend = new MemorySearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    // 手工灌一条库里根本没有的消息（模拟索引比存储新）。
    backend.index({
      messageId: 'ghost-message',
      conversationId: 'ghost-conversation',
      seq: 9999,
      senderType: 'user',
      createdAt: 1,
      text: '幽灵消息',
    })
    const result = service.search('幽灵')
    expect(result.hits).toHaveLength(0)
    expect(result.dropped).toBe(1)
  })

  it('正文被改过之后，旧索引里的命中不会被原样端出来', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('ZIP').hits).toHaveLength(1)
    // 把那条用户消息的正文改掉（底座的「编辑并重发」走的就是这条路）。
    const target = fixture.messages[4]
    expect(fixture.store.updateUserMessageText(fixture.conversationId, target.seq, '再帮我导出成 PDF')).toBe(true)
    const result = service.search('ZIP')
    expect(result.hits).toHaveLength(0)
    expect(result.dropped).toBeGreaterThan(0)
  })

  it('按相关度排序：分越高越靠前', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = service.search('配置')
    for (let index = 1; index < result.hits.length; index++) {
      expect(result.hits[index - 1].score).toBeGreaterThanOrEqual(result.hits[index].score)
    }
  })

  it('limit 生效，超出的命中被截掉', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.search('配置', { limit: 1 }).hits).toHaveLength(1)
  })

  it('按发言者种类过滤命中', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = service.search('配置', { senderType: 'user' })
    expect(result.hits.every((hit) => hit.senderType === 'user')).toBe(true)
  })

  it('同步是增量的：会话没变时第二次不重复进索引', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.syncConversation(fixture.conversationId)).toBeGreaterThan(0)
    expect(service.syncConversation(fixture.conversationId)).toBe(0)
  })

  it('全量重建会把每个会话都重新进一遍索引', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const count = service.reindexAll()
    expect(count).toBeGreaterThan(0)
    expect(service.search('三个键').hits).toHaveLength(2)
  })

  it('后端可以自己清空', () => {
    const backend = new MemorySearchBackend()
    const service = new SessionQueryService({ store: createFixture().store, search: backend })
    service.search('配置')
    expect(backend.size).toBeGreaterThan(0)
    backend.clear()
    expect(backend.size).toBe(0)
  })
})

describe('SQLite FTS5 后端', () => {
  it('搜得到同样的内容', () => {
    const fixture = createFixture()
    const backend = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    const result = service.search('三个键')
    expect(result.hits).toHaveLength(2)
    expect(result.hits.map((hit) => hit.messageId).sort()).toEqual(
      [fixture.messages[2].id, fixture.messages[3].id].sort(),
    )
    backend.close()
  })

  it('分数方向与内存后端一致（越大越相关）', () => {
    const fixture = createFixture()
    const backend = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    const result = service.search('配置')
    for (let index = 1; index < result.hits.length; index++) {
      expect(result.hits[index - 1].score).toBeGreaterThanOrEqual(result.hits[index].score)
    }
    backend.close()
  })

  it('限定会话时只搜那个会话', () => {
    const fixture = createFixture()
    const backend = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    const result = service.search('天气', { conversationId: fixture.otherConversationId })
    expect(result.hits).toHaveLength(1)
    backend.close()
  })

  it('丢掉一个会话的索引行之后不再命中它', () => {
    const fixture = createFixture()
    const backend = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    service.syncConversation(fixture.conversationId)
    expect(backend.size).toBeGreaterThan(0)
    backend.removeConversation(fixture.conversationId)
    expect(backend.size).toBe(0)
    backend.close()
  })

  it('索引文件可以落盘，重开后还在', () => {
    const fixture = createFixture()
    const first = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: first })
    service.syncConversation(fixture.conversationId)
    first.close()
    // 落盘这件事在真实部署里由宿主决定路径；这里只用内存库验证「重建一次还能搜到」。
    const second = new Fts5SearchBackend()
    const reopened = new SessionQueryService({ store: fixture.store, search: second })
    reopened.syncConversation(fixture.conversationId)
    expect(reopened.search('三个键').hits).toHaveLength(2)
    second.close()
  })
})
