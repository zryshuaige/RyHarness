/**
 * 边界情形：空输入、坏数据、关掉之后、重复索引。
 *
 * 这些用例盯的是「不该崩的时候别崩」：查询词是空的、消息被改得只剩空壳、索引里
 * 已经有同一条消息、插件被关掉之后——每一处都该有一个说得清的行为，而不是抛
 * 一个英文异常出去。
 */

import { describe, expect, it } from 'vitest'
import {
  buildLineage,
  createSessionQueryTools,
  decodeCursor,
  encodeCursor,
  Fts5SearchBackend,
  filterFingerprint,
  formatTime,
  MemorySearchBackend,
  makeSnippet,
  matchesFilter,
  messageKinds,
  renderMessage,
  requireConversation,
  SessionQueryError,
  SessionQueryService,
  type SessionQueryTool,
  searchTokenList,
  searchTokens,
  textMatchesQuery,
  toolCallIds,
  traceRelations,
} from '../src/index.ts'
import { createFixture } from './helpers.ts'

describe('空输入与坏数据', () => {
  it('查询词是空的就当没问', () => {
    expect(textMatchesQuery('随便什么正文', '')).toBe(false)
    expect(searchTokens('').size).toBe(0)
  })

  it('正文里没有那个词就不算命中', () => {
    expect(textMatchesQuery('今天天气不错', '配置')).toBe(false)
  })

  it('片段里找不到原样的命中词，就取正文开头', () => {
    const snippet = makeSnippet('今天天气不错，出门记得带伞', '天气', 16)
    expect(snippet.startsWith('今天天气不错')).toBe(true)
  })

  it('内容块是脏数据时不炸，只是认不出工具调用', () => {
    const message = {
      id: 'm1',
      seq: 1,
      conversationId: 'c1',
      senderType: 'agent' as const,
      contentBlocks: ['一段字符串', null, { type: 'tool-call' }, { type: 'tool-call', id: 42 }],
      mentions: [],
      turnIndex: 0,
      createdAt: 1,
    }
    expect(toolCallIds(message)).toEqual([])
    // 块在就算「含有工具调用」，只是认不出它的 id。
    expect(messageKinds(message)).toEqual(['tool-call'])
  })

  it('筛选条件不匹配就是不算', () => {
    const fixture = createFixture()
    expect(matchesFilter(fixture.messages[0], { conversationId: '别的会话' })).toBe(false)
    expect(matchesFilter(fixture.messages[0], { conversationId: fixture.conversationId })).toBe(true)
  })

  it('坏游标：能解出 JSON 但不是游标形状', () => {
    const cursor = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString('base64url')
    try {
      decodeCursor(cursor, filterFingerprint({}))
      throw new Error('不该走到这里')
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CURSOR_INVALID')
    }
  })

  it('游标里带的序号能原样取回', () => {
    const fingerprint = filterFingerprint({ conversationId: 'c1' })
    expect(decodeCursor(encodeCursor(7, fingerprint), fingerprint)).toBe(7)
  })
})

describe('关掉与清空', () => {
  it('服务关掉之后搜索后端也被关掉（不抛错）', () => {
    const fixture = createFixture()
    const backend = new Fts5SearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    service.search('配置')
    service.close()
  })

  it('内存后端清空之后索引里什么都没有了', () => {
    const backend = new MemorySearchBackend()
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    service.syncConversation(fixture.conversationId)
    expect(backend.size).toBeGreaterThan(0)
    backend.clear()
    expect(backend.size).toBe(0)
  })

  it('FTS5 后端清空之后索引里也没有了', () => {
    const backend = new Fts5SearchBackend()
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    service.syncConversation(fixture.conversationId)
    expect(backend.size).toBeGreaterThan(0)
    backend.clear()
    expect(backend.size).toBe(0)
    backend.close()
  })

  it('去掉一个不存在的会话不报错', () => {
    const backend = new Fts5SearchBackend()
    backend.removeConversation('根本没这个会话')
    backend.close()
    const memory = new MemorySearchBackend()
    memory.removeConversation('根本没这个会话')
  })

  it('正文为空的消息不进索引', () => {
    const backend = new MemorySearchBackend()
    backend.index({
      messageId: 'm1',
      conversationId: 'c1',
      seq: 1,
      senderType: 'user',
      createdAt: 1,
      text: '',
    })
    expect(backend.size).toBe(0)
    expect(backend.search('任何词', { limit: 5 })).toEqual([])
  })

  it('同一条消息重复进索引不会变成两条', () => {
    const backend = new Fts5SearchBackend()
    const document = {
      messageId: 'm1',
      conversationId: 'c1',
      seq: 1,
      senderType: 'user' as const,
      createdAt: 1,
      text: '重复进索引的正文',
    }
    backend.index(document)
    backend.index(document)
    expect(backend.size).toBe(1)
    expect(backend.search('重复', { limit: 5 })).toHaveLength(1)
    backend.close()
  })
})

describe('缺了上下文的关系与血缘', () => {
  it('目标消息不在消息列表里时，前后文是空的', () => {
    const fixture = createFixture()
    const stranger = { ...fixture.messages[0], id: '不在列表里的消息' }
    const trace = traceRelations(stranger, fixture.messages)
    expect(trace.before).toHaveLength(0)
    expect(trace.after).toHaveLength(0)
  })

  it('目标消息不在消息列表里时，血缘给的是它自己那一轮', () => {
    const fixture = createFixture()
    const stranger = { ...fixture.messages[0], id: '不在列表里的消息' }
    const lineage = buildLineage(stranger, fixture.messages)
    expect(lineage.positionInTurn).toBe(1)
    expect(lineage.turnSize).toBe(4)
    expect(lineage.turnFirst.id).toBe(fixture.messages[0].id)
  })

  it('这一轮之前的用户消息不在同一轮时，退到本会话上一条用户消息', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const messages = service.listMessages({ conversationId: fixture.conversationId, order: 'asc', limit: 100 }).items
    // 把第一轮的用户消息挪走：助理那条就只能退到更早的用户消息（或没有）。
    const withoutUser = messages.filter((message) => message.senderType !== 'user')
    const agentMessage = withoutUser.find((message) => message.seq === fixture.messages[3].seq)
    expect(agentMessage).toBeDefined()
    const trace = traceRelations(agentMessage as (typeof withoutUser)[number], withoutUser)
    expect(trace.repliesTo).toBeUndefined()
  })
})

describe('要一个不存在的会话', () => {
  it('requireConversation 拿不到就报错，错误码说清是哪一种', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(requireConversation(service, fixture.conversationId).id).toBe(fixture.conversationId)
    try {
      requireConversation(service, '不存在的会话')
      throw new Error('不该走到这里')
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CONVERSATION_NOT_FOUND')
    }
  })
})

describe('工具的参数不规矩', () => {
  it('参数不是对象就当没给', async () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const tools = createSessionQueryTools(service)
    const search = tools.find((tool) => {
      return tool.name === 'session_search'
    }) as SessionQueryTool
    const result = await search.execute('这不是对象', { conversationId: fixture.conversationId })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })

  it('limit 不是数字就用缺省值', async () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const tools = createSessionQueryTools(service)
    const search = tools.find((tool) => {
      return tool.name === 'session_search'
    }) as SessionQueryTool
    const result = await search.execute({ query: '三个键', limit: '很多' }, { conversationId: fixture.conversationId })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('三个键')
  })
})

describe('后端自己被直接用的时候', () => {
  it('查询词是空的就直接给空结果', () => {
    const memory = new MemorySearchBackend()
    expect(memory.search('', { limit: 5 })).toEqual([])
    const fts = new Fts5SearchBackend()
    expect(fts.search('', { limit: 5 })).toEqual([])
    fts.close()
  })

  it('正文里没有字母数字的消息不进索引', () => {
    const memory = new MemorySearchBackend()
    memory.index({
      messageId: 'm1',
      conversationId: 'c1',
      seq: 1,
      senderType: 'user',
      createdAt: 1,
      text: '！！',
    })
    expect(memory.size).toBe(0)
    const fts = new Fts5SearchBackend()
    fts.index({
      messageId: 'm1',
      conversationId: 'c1',
      seq: 1,
      senderType: 'user',
      createdAt: 1,
      text: '',
    })
    expect(fts.size).toBe(0)
    fts.close()
  })

  it('内存后端关掉之后索引清空', () => {
    const backend = new MemorySearchBackend()
    backend.close()
    expect(backend.size).toBe(0)
  })
})

describe('渲染与格式化', () => {
  it('内容块是脏数据时渲染也不炸', () => {
    const message = {
      id: 'm1',
      seq: 1,
      conversationId: 'c1',
      senderType: 'agent' as const,
      contentBlocks: ['一段字符串', null, { type: 'text', text: '能看的那句' }],
      mentions: [],
      turnIndex: 0,
      createdAt: 1,
    }
    const rendered = renderMessage(message)
    expect(rendered).toContain('能看的那句')
    expect(rendered).toContain('助理')
  })

  it('工具调用与工具结果各说各的', () => {
    const fixture = createFixture()
    expect(renderMessage(fixture.messages[1])).toContain('（调用工具 fs_read）')
    expect(renderMessage(fixture.messages[2])).toContain('（工具结果 call-1）')
    expect(renderMessage(fixture.messages[0])).toContain('用户')
  })

  it('时间戳补零成 YYYY-MM-DD HH:mm:ss', () => {
    const stamp = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(formatTime(stamp)).toBe('2026-01-02 03:04:05')
  })

  it('正文比片段还短时，片段就是正文本身', () => {
    expect(makeSnippet('短', '短', 160)).toBe('短')
    expect(makeSnippet('今天天气不错', '配置', 16)).toBe('今天天气不错')
  })

  it('全是标点的正文切不出词', () => {
    expect(searchTokenList('！！')).toEqual([])
  })
})

describe('没有正文的会话', () => {
  it('只有工具调用的消息不进搜索索引', () => {
    const fixture = createFixture()
    const conversation = fixture.store.createConversation({
      kind: 'direct',
      title: '只有工具',
      memberAgentIds: ['agent-a'],
    })
    fixture.store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'agent-a',
      contentBlocks: [{ type: 'tool-call', id: 'call-x', name: 'fs_read', arguments: '{}' }],
      turnIndex: 0,
    })
    const backend = new MemorySearchBackend()
    const service = new SessionQueryService({ store: fixture.store, search: backend })
    expect(service.syncConversation(conversation.id)).toBe(0)
    expect(backend.size).toBe(0)
  })

  it('空会话同步进去是 0 条，不报错', () => {
    const fixture = createFixture()
    const conversation = fixture.store.createConversation({
      kind: 'direct',
      title: '空的',
      memberAgentIds: ['agent-a'],
    })
    const service = new SessionQueryService({ store: fixture.store })
    expect(service.syncConversation(conversation.id)).toBe(0)
    expect(service.getTurn(conversation.id, 0)).toBeUndefined()
  })

  it('正序翻页也按 seq 往后走', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const first = service.listMessages({ conversationId: fixture.conversationId, order: 'asc', limit: 2 })
    expect(first.items.map((message) => message.seq)).toEqual([fixture.messages[0].seq, fixture.messages[1].seq])
    const second = service.listMessages({
      conversationId: fixture.conversationId,
      order: 'asc',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((message) => message.seq)).toEqual([fixture.messages[2].seq, fixture.messages[3].seq])
  })
})
