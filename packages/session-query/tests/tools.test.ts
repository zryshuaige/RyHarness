/**
 * 模型看得见的三件工具：名字、参数、行为。
 *
 * 这些用例盯的是「模型怎么用它」：参数缺了给一句能照着改的话，没有会话上下文
 * 时不装作有（默认只查当前会话），查到了就把正文与关系原样给出来。
 */

import { describe, expect, it } from 'vitest'
import {
  createSessionQueryTools,
  SESSION_QUERY_TOOL_NAMES,
  SESSION_READ_TOOL_NAME,
  SESSION_SEARCH_TOOL_NAME,
  SESSION_TRACE_TOOL_NAME,
  SessionQueryService,
  type SessionQueryTool,
} from '../src/index.ts'
import { createFixture } from './helpers.ts'

/** 建一套工具与它们背后的服务。 */
function toolsOf(): {
  tools: readonly SessionQueryTool[]
  service: SessionQueryService
  fixture: ReturnType<typeof createFixture>
} {
  const fixture = createFixture()
  const service = new SessionQueryService({ store: fixture.store })
  return { tools: createSessionQueryTools(service), service, fixture }
}

/** 按名字取工具。 */
function toolOf(tools: readonly SessionQueryTool[], name: string): SessionQueryTool {
  const found = tools.find((tool) => {
    return tool.name === name
  })
  if (found === undefined) throw new Error(`没有这件工具：${name}`)
  return found
}

describe('工具清单', () => {
  it('三件工具的名字与清单一致', () => {
    const { tools } = toolsOf()
    expect(tools.map((tool) => tool.name)).toEqual([...SESSION_QUERY_TOOL_NAMES])
    expect(SESSION_QUERY_TOOL_NAMES).toEqual([
      SESSION_SEARCH_TOOL_NAME,
      SESSION_READ_TOOL_NAME,
      SESSION_TRACE_TOOL_NAME,
    ])
  })

  it('每件工具都有说明与参数表', () => {
    const { tools } = toolsOf()
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters.type).toBe('object')
    }
  })
})

describe('session_search', () => {
  it('搜到时给出台词与来自哪个会话', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_SEARCH_TOOL_NAME).execute(
      { query: '三个键' },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('三个键')
    expect(result.content).toContain(fixture.conversationId)
  })

  it('没给关键词就说清缺了什么', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, SESSION_SEARCH_TOOL_NAME).execute({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query')
  })

  it('搜不到就直说搜不到，不编', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_SEARCH_TOOL_NAME).execute(
      { query: '压根没出现过的词' },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('没搜到')
  })

  it('默认只查当前会话；跨会话要显式说明', async () => {
    const { tools, fixture } = toolsOf()
    const scoped = await toolOf(tools, SESSION_SEARCH_TOOL_NAME).execute(
      { query: '天气' },
      { conversationId: fixture.conversationId },
    )
    expect(scoped.content).toContain('没搜到')
    const all = await toolOf(tools, SESSION_SEARCH_TOOL_NAME).execute(
      { query: '天气', allSessions: true },
      { conversationId: fixture.conversationId },
    )
    expect(all.content).toContain('天气')
  })
})

describe('session_read', () => {
  it('把那条消息原样给出来', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_READ_TOOL_NAME).execute(
      { messageId: fixture.messages[0].id },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('帮我看看这份配置')
    expect(result.content).toContain(fixture.messages[0].id)
  })

  it('缺 id 就说缺 id', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, SESSION_READ_TOOL_NAME).execute({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('messageId')
  })

  it('读不到就说读不到', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_READ_TOOL_NAME).execute(
      { messageId: '根本没有这条' },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没找到')
  })
})

describe('session_trace', () => {
  it('给出它回复的是谁、同轮有哪些消息', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_TRACE_TOOL_NAME).execute(
      { messageId: fixture.messages[1].id },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('它回复的是')
    expect(result.content).toContain('同一轮里的其它消息')
    expect(result.content).toContain('帮我看看这份配置')
  })

  it('缺 id 就说缺 id', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, SESSION_TRACE_TOOL_NAME).execute({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('messageId')
  })

  it('追不到就说追不到', async () => {
    const { tools, fixture } = toolsOf()
    const result = await toolOf(tools, SESSION_TRACE_TOOL_NAME).execute(
      { messageId: '根本没有这条' },
      { conversationId: fixture.conversationId },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没找到')
  })
})
