/**
 * ACP 客户端端到端：起一个假 agent，完整走一遍会话。
 */
import { describe, expect, it } from 'vitest'
import { ACP_EVENT_VERSION, ACP_METHODS, AcpClient, type AcpEvent } from '../src/index.ts'
import { createFakeAgent, REPLAY_EVENTS } from './helpers.ts'

describe('ACP 客户端', () => {
  it('握手说清协议版本与能力', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    const result = await client.initialize()
    expect(result.protocolVersion).toBe(1)
    expect(result.agentCapabilities).toEqual({ streaming: true, tools: true })
    expect(agent.requests).toContain(ACP_METHODS.initialize)
    client.close()
  })

  it('新建会话拿到会话 id', async () => {
    const agent = createFakeAgent('sess-42')
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession({ cwd: '/tmp' })
    expect(session.sessionId).toBe('sess-42')
    expect(session.isClosed).toBe(false)
    client.close()
  })

  it('发一条消息，事件按顺序到齐，最后拿到停止原因', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    session.onEvent((event) => {
      events.push(event)
    })
    const stopReason = await session.send('你好')
    expect(stopReason).toBe('end_turn')
    expect(events).toHaveLength(REPLAY_EVENTS.length)
    expect(events.map((event) => event.kind)).toEqual([
      'message_chunk',
      'message_chunk',
      'tool_call',
      'tool_result',
      'message_chunk',
      'completed',
    ])
    client.close()
  })

  it('事件里能看到文本、工具调用与工具结果', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    session.onEvent((event) => {
      events.push(event)
    })
    await session.send('你好')
    const texts = events
      .filter((event) => event.kind === 'message_chunk')
      .map((event) => (event.kind === 'message_chunk' ? event.text : ''))
    expect(texts.join('')).toBe('我在。')
    const call = events.find((event) => event.kind === 'tool_call')
    expect(call).toMatchObject({ callId: 'c1', title: '读文件', status: 'in_progress', toolKind: 'read' })
    const result = events.find((event) => event.kind === 'tool_result')
    expect(result).toMatchObject({ callId: 'c1', status: 'completed', content: '文件内容' })
    client.close()
  })

  it('事件带固定版本号与会话内序号', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    session.onEvent((event) => {
      events.push(event)
    })
    await session.send('你好')
    expect(events.map((event) => event.version)).toEqual([1, 1, 1, 1, 1, 1])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.every((event) => event.sessionId === session.sessionId)).toBe(true)
    expect(ACP_EVENT_VERSION).toBe(1)
    client.close()
  })

  it('取消是一条通知，不等回包', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    session.cancel()
    expect(agent.notifications).toContain(ACP_METHODS.cancel)
    client.close()
  })

  it('关闭会话：对端收到 close', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    await session.close()
    expect(agent.requests).toContain(ACP_METHODS.close)
    expect(session.isClosed).toBe(true)
    client.close()
  })

  it('关掉的会话不能再发消息', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    await session.close()
    await expect(session.send('再来一次')).rejects.toMatchObject({ code: 'acp/session-unknown' })
    client.close()
  })

  it('不认识的事件被丢掉，会话不垮', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    session.onEvent((event) => {
      events.push(event)
    })
    agent.push({ version: 1, sessionId: session.sessionId, seq: 1, kind: '不认识的事件' })
    agent.push({ version: 9, sessionId: session.sessionId, seq: 2, kind: 'message_chunk', text: 'x' })
    expect(events).toEqual([])
    // 会话照常能用。
    await expect(session.send('你好')).resolves.toBe('end_turn')
    client.close()
  })

  it('别的会话的事件不会串到这个会话', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    session.onEvent((event) => {
      events.push(event)
    })
    agent.push({ version: 1, sessionId: '别的会话', seq: 1, kind: 'message_chunk', text: '串了' })
    expect(events).toEqual([])
    client.close()
  })

  it('客户端级别也能订阅全部事件', async () => {
    const agent = createFakeAgent()
    const client = new AcpClient({ transport: agent.transport })
    await client.initialize()
    const session = await client.newSession()
    const events: AcpEvent[] = []
    client.onEvent((event) => {
      events.push(event)
    })
    await session.send('你好')
    expect(events).toHaveLength(REPLAY_EVENTS.length)
    client.close()
  })
})
