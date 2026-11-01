/**
 * 关系追踪与血缘：一条消息和谁有关系、它是哪一轮的第几条。
 *
 * 这些用例盯的是「关系算对了没有」：三种关系各自独立断言，别把它们混成一句
 * 「相关消息」——混了就等于没测。
 */

import { describe, expect, it } from 'vitest'
import { buildReplyGraph, SessionQueryService, traceRelations } from '../src/index.ts'
import { createFixture } from './helpers.ts'

describe('关系追踪', () => {
  it('同一轮的消息列出来，不含自己', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[1].id)
    expect(trace).toBeDefined()
    expect(trace?.turnMessages.map((message) => message.seq)).toEqual([
      fixture.messages[0].seq,
      fixture.messages[2].seq,
      fixture.messages[3].seq,
    ])
    expect(trace?.turnMessages.some((message) => message.id === fixture.messages[1].id)).toBe(false)
  })

  it('它回复的是同一轮里的那条用户消息', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[3].id)
    expect(trace?.repliesTo?.id).toBe(fixture.messages[0].id)
    expect(trace?.repliesTo?.senderType).toBe('user')
  })

  it('工具结果回复的是发起那次调用的那条消息', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[2].id)
    expect(trace?.repliesTo?.id).toBe(fixture.messages[1].id)
    expect(trace?.repliesTo?.toolCallId).toBeUndefined()
  })

  it('引用了它的：接了它工具调用的工具结果', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[1].id)
    expect(trace?.referencedBy.map((message) => message.id)).toEqual([fixture.messages[2].id])
  })

  it('引用了它的：答了它的话的助理消息', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[0].id)
    expect(trace?.referencedBy.map((message) => message.id)).toEqual([fixture.messages[1].id, fixture.messages[3].id])
  })

  it('用户消息本身没有「它回复的」', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[0].id)
    expect(trace?.repliesTo).toBeUndefined()
  })

  it('前后文默认各取两条', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[3].id)
    expect(trace?.before.map((message) => message.seq)).toEqual([fixture.messages[1].seq, fixture.messages[2].seq])
    expect(trace?.after.map((message) => message.seq)).toEqual([fixture.messages[4].seq, fixture.messages[5].seq])
  })

  it('contextSize 调大就多取几条', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[4].id, { contextSize: 3 })
    expect(trace?.before).toHaveLength(3)
    expect(trace?.after).toHaveLength(1)
  })

  it('contextSize 为 0 时前后文都是空的', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const trace = service.traceRelations(fixture.messages[3].id, { contextSize: 0 })
    expect(trace?.before).toHaveLength(0)
    expect(trace?.after).toHaveLength(0)
  })

  it('追一条不存在的消息返回 undefined', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.traceRelations('不存在的消息')).toBeUndefined()
  })

  it('关系图：每条消息的「回复对象」都指得对', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const messages = service.listMessages({ conversationId: fixture.conversationId, order: 'asc', limit: 100 }).items
    const graph = buildReplyGraph(messages)
    expect(graph.repliesTo.get(fixture.messages[1].id)?.id).toBe(fixture.messages[0].id)
    expect(graph.repliesTo.get(fixture.messages[2].id)?.id).toBe(fixture.messages[1].id)
    expect(graph.repliesTo.get(fixture.messages[3].id)?.id).toBe(fixture.messages[0].id)
    expect(graph.repliesTo.get(fixture.messages[5].id)?.id).toBe(fixture.messages[4].id)
    expect(graph.repliesTo.has(fixture.messages[0].id)).toBe(false)
  })

  it('关系图：反向就是「谁引用了它」', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const messages = service.listMessages({ conversationId: fixture.conversationId, order: 'asc', limit: 100 }).items
    const graph = buildReplyGraph(messages)
    expect(graph.referencedBy.get(fixture.messages[0].id)?.map((message) => message.id)).toEqual([
      fixture.messages[1].id,
      fixture.messages[3].id,
    ])
    expect(graph.referencedBy.get(fixture.messages[1].id)?.map((message) => message.id)).toEqual([
      fixture.messages[2].id,
    ])
    expect(graph.referencedBy.get(fixture.messages[2].id)).toBeUndefined()
  })

  it('关系追踪直接吃消息数组也能算（不经过服务）', () => {
    const fixture = createFixture()
    const trace = traceRelations(fixture.messages[1], fixture.messages, { contextSize: 1 })
    expect(trace.turnMessages).toHaveLength(3)
    expect(trace.before.map((message) => message.seq)).toEqual([fixture.messages[0].seq])
  })
})

describe('血缘', () => {
  it('它是哪一轮的第几条、这一轮有几条', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const lineage = service.getLineage(fixture.messages[3].id)
    expect(lineage?.turnIndex).toBe(0)
    expect(lineage?.positionInTurn).toBe(4)
    expect(lineage?.turnSize).toBe(4)
    expect(lineage?.turnFirst.id).toBe(fixture.messages[0].id)
  })

  it('它前面那条消息是上一条', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const lineage = service.getLineage(fixture.messages[3].id)
    expect(lineage?.previousMessage?.id).toBe(fixture.messages[2].id)
  })

  it('上一轮是摘要：轮次号、第一条、条数', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const lineage = service.getLineage(fixture.messages[4].id)
    expect(lineage?.turnIndex).toBe(1)
    expect(lineage?.previousTurn?.turnIndex).toBe(0)
    expect(lineage?.previousTurn?.size).toBe(4)
    expect(lineage?.previousTurn?.first.id).toBe(fixture.messages[0].id)
  })

  it('本会话第一条消息没有「前面那条」，也没有上一轮', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const lineage = service.getLineage(fixture.messages[0].id)
    expect(lineage?.previousMessage).toBeUndefined()
    expect(lineage?.previousTurn).toBeUndefined()
    expect(lineage?.positionInTurn).toBe(1)
  })

  it('第一轮的第一条消息没有上一轮，但有前面那条（同轮的后一条不算）', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const lineage = service.getLineage(fixture.messages[1].id)
    expect(lineage?.previousTurn).toBeUndefined()
    expect(lineage?.previousMessage?.id).toBe(fixture.messages[0].id)
  })

  it('不存在的消息没有血缘', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.getLineage('不存在的消息')).toBeUndefined()
  })
})
