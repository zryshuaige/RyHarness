/**
 * 查询服务：精确读、筛选列表、分页边界。
 *
 * 这些用例盯的是「查到的东西对不对」：给一个 id 要拿到那条消息、给一组条件要
 * 拿到符合条件的那些、翻页要能接着往下翻且不重不漏。
 */

import { describe, expect, it } from 'vitest'
import { SessionQueryError, SessionQueryService } from '../src/index.ts'
import { createFixture } from './helpers.ts'

describe('精确读', () => {
  it('按消息 id 取到那条消息，内容与发言者都对得上', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const found = service.getMessage(fixture.messages[1].id)
    expect(found?.id).toBe(fixture.messages[1].id)
    expect(found?.senderType).toBe('agent')
    expect(found?.senderId).toBe('agent-a')
    expect(found?.contentBlocks).toHaveLength(2)
  })

  it('给了会话 id 就只在那一个会话里找，给错了就找不到', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.getMessage(fixture.messages[0].id, { conversationId: fixture.conversationId })?.seq).toBe(
      fixture.messages[0].seq,
    )
    expect(service.getMessage(fixture.messages[0].id, { conversationId: fixture.otherConversationId })).toBeUndefined()
  })

  it('不存在的消息 id 返回 undefined（不是抛错）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.getMessage('根本没有这条消息')).toBeUndefined()
  })

  it('按 id 取会话，拿到标题与成员', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const conversation = service.getConversation(fixture.conversationId)
    expect(conversation?.title).toBe('配置检查')
    expect(conversation?.memberAgentIds).toEqual(['agent-a'])
    expect(service.getConversation('nope')).toBeUndefined()
  })

  it('取一轮拿到这一轮的全部消息与条数', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const turn = service.getTurn(fixture.conversationId, 0)
    expect(turn?.size).toBe(4)
    expect(turn?.messages.map((message) => message.seq)).toEqual([
      fixture.messages[0].seq,
      fixture.messages[1].seq,
      fixture.messages[2].seq,
      fixture.messages[3].seq,
    ])
  })

  it('取不存在的一轮返回 undefined', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.getTurn(fixture.conversationId, 99)).toBeUndefined()
  })

  it('会话清单带消息条数，按最后更新时间倒序', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const conversations = service.listConversations()
    expect(conversations).toHaveLength(2)
    const byId = new Map(
      conversations.map((conversation) => {
        return [conversation.id, conversation] as const
      }),
    )
    expect(byId.get(fixture.conversationId)?.messageCount).toBe(6)
    expect(byId.get(fixture.otherConversationId)?.messageCount).toBe(1)
    expect(conversations[0].updatedAt).toBeGreaterThanOrEqual(conversations[1].updatedAt)
  })

  it('软删掉的会话按查不到处理（与底座的会话列表一致）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    fixture.store.markConversationDeleted(fixture.conversationId)
    expect(service.getConversation(fixture.conversationId)).toBeUndefined()
    expect(service.listMessages({ conversationId: fixture.conversationId }).total).toBe(0)
  })
})

describe('筛选列表', () => {
  it('缺省按 seq 倒序返回（新的在前）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId })
    expect(page.items).toHaveLength(6)
    expect(page.items[0].seq).toBe(fixture.messages[5].seq)
    expect(page.items[5].seq).toBe(fixture.messages[0].seq)
  })

  it('asc 排序把顺序翻过来', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, order: 'asc' })
    expect(page.items[0].seq).toBe(fixture.messages[0].seq)
    expect(page.items[5].seq).toBe(fixture.messages[5].seq)
  })

  it('limit 生效，且 total 记的是翻页前的总数', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(6)
    expect(page.hasMore).toBe(true)
  })

  it('按发言者种类过滤', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, senderType: 'user' })
    expect(page.total).toBe(2)
    expect(page.items.every((message) => message.senderType === 'user')).toBe(true)
  })

  it('按发言者 id 过滤', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, senderId: 'agent-a' })
    expect(page.total).toBe(3)
  })

  it('按内容种类过滤：工具结果只有那一条', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, kind: 'tool-result' })
    expect(page.total).toBe(1)
    expect(page.items[0].toolCallId).toBe('call-1')
  })

  it('按内容种类过滤：含工具调用的那条也算「有正文」', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.listMessages({ conversationId: fixture.conversationId, kind: 'tool-call' }).total).toBe(1)
    expect(service.listMessages({ conversationId: fixture.conversationId, kind: 'text' }).total).toBe(6)
  })

  it('按时间区间过滤（含端点）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const earliest = fixture.messages[0].createdAt
    const latest = fixture.messages[5].createdAt
    // 上界比最早的一条还早一毫秒：一条都不该命中。
    expect(service.listMessages({ conversationId: fixture.conversationId, toTime: earliest - 1 }).total).toBe(0)
    // 下界比最晚的一条还晚一毫秒：一条都不该命中。
    expect(service.listMessages({ conversationId: fixture.conversationId, fromTime: latest + 1 }).total).toBe(0)
    // 端点含住：拿最早那条的毫秒值当区间，命中的每一条都落在区间里。
    const page = service.listMessages({
      conversationId: fixture.conversationId,
      fromTime: earliest,
      toTime: earliest,
    })
    expect(page.total).toBeGreaterThanOrEqual(1)
    expect(page.items.every((message) => message.createdAt === earliest)).toBe(true)
  })

  it('按正文子串过滤', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, text: '三个键' })
    expect(page.total).toBe(2)
    // 缺省是倒序（新的在前）。
    expect(page.items.map((message) => message.seq)).toEqual([fixture.messages[3].seq, fixture.messages[2].seq])
  })

  it('不给会话就跨会话列（两个会话的消息都在）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages()
    expect(page.total).toBe(7)
    expect(new Set(page.items.map((message) => message.conversationId)).size).toBe(2)
  })
})

describe('分页边界', () => {
  it('游标能接着往下翻，两页拼起来不重不漏', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const first = service.listMessages({ conversationId: fixture.conversationId, limit: 4 })
    expect(first.items).toHaveLength(4)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBeDefined()
    const second = service.listMessages({
      conversationId: fixture.conversationId,
      limit: 4,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(2)
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeUndefined()
    const all = [...first.items, ...second.items].map((message) => message.seq)
    expect(all).toEqual(fixture.messages.map((message) => message.seq).reverse())
  })

  it('limit 正好等于总数时没有下一页', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, limit: 6 })
    expect(page.items).toHaveLength(6)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })

  it('limit 比总数还大时也不报错', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const page = service.listMessages({ conversationId: fixture.conversationId, limit: 100 })
    expect(page.items).toHaveLength(6)
    expect(page.hasMore).toBe(false)
  })

  it('游标用在另一组筛选条件上会报错，不给一页莫名其妙的数据', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const first = service.listMessages({ conversationId: fixture.conversationId, limit: 2 })
    expect(() => {
      service.listMessages({
        conversationId: fixture.conversationId,
        limit: 2,
        senderType: 'user',
        cursor: first.nextCursor,
      })
    }).toThrow(SessionQueryError)
    try {
      service.listMessages({
        conversationId: fixture.conversationId,
        limit: 2,
        senderType: 'user',
        cursor: first.nextCursor,
      })
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CURSOR_MISMATCH')
    }
  })

  it('坏掉的游标报「游标格式不对」', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    try {
      service.listMessages({ conversationId: fixture.conversationId, cursor: '这不是游标' })
      throw new Error('不该走到这里')
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CURSOR_INVALID')
    }
  })
})
