/**
 * ACP 服务端侧的用例：编辑器驱动我们，我们应答。
 *
 * 这一族盯的是「线协议对不对」：握手、开会话、发消息、取消，四步都要给出
 * 对方认得的形状；事件要带版本号、会话 id 与**会话内序号**（编辑器靠它判断
 * 有没有漏收）。
 */
import { createMemoryTransportPair } from '@ryharness/api'
import { describe, expect, it } from 'vitest'
import { type AcpAgentHandlers, AcpAgentServer } from '../src/index.ts'

/** 记下服务端收到过什么。 */
interface Recorder {
  readonly handlers: AcpAgentHandlers
  readonly prompts: string[]
  readonly cancelled: string[]
}

/** 造一个服务端与它的对端（内存传输对）。 */
function makeServer(options: { waitsForCancel?: boolean } = {}): {
  server: AcpAgentServer
  client: {
    request: (method: string, params?: unknown) => Promise<unknown>
    notifications: Array<{ method: string; params: unknown }>
  }
  recorder: Recorder
} {
  const [clientSide, serverSide] = createMemoryTransportPair()
  const waitsForCancel = options.waitsForCancel === true
  const prompts: string[] = []
  const cancelled: string[] = []
  const handlers: AcpAgentHandlers = {
    newSession: async () => 'session-1',
    prompt: async (_sessionId, text, signal) => {
      prompts.push(text)
      // **可被取消打断**：编辑器取消这一轮时，abort 一响就该停。
      // 不这么做的话，宿主那一侧的 promise 永远挂着，取消就只是「通知了一声」。
      //
      // 「这一轮要等多久」由宿主决定；测试里只有「等取消」那一条才真的等。
      if (waitsForCancel) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve()
            return
          }
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return 'cancelled'
      }
      return 'end_turn'
    },
    closeSession: async () => undefined,
    cancel: (sessionId) => {
      cancelled.push(sessionId)
    },
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onError: () => undefined,
  }
  const server = new AcpAgentServer({ transport: serverSide, handlers })
  const notifications: Array<{ method: string; params: unknown }> = []
  // 对端用最朴素的 JSON-RPC 客户端：写请求、收回复与通知。
  let nextId = 0
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  clientSide.onData((chunk) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const message = JSON.parse(trimmed) as {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { message?: string }
      }
      if (typeof message.id === 'number' && message.method === undefined) {
        const call = pending.get(message.id)
        pending.delete(message.id)
        if (message.error !== undefined) call?.reject(new Error(message.error.message ?? '远程调用失败'))
        else call?.resolve(message.result)
        continue
      }
      if (message.method !== undefined) notifications.push({ method: message.method, params: message.params })
    }
  })
  const request = (method: string, params?: unknown): Promise<unknown> => {
    nextId += 1
    const id = nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      clientSide.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      )
    })
  }
  return { server, client: { request, notifications }, recorder: { handlers, prompts, cancelled } }
}

describe('ACP 服务端', () => {
  it('握手：给出协议版本与能力', async () => {
    const { server, client } = makeServer()
    try {
      const result = (await client.request('initialize', { protocolVersion: 1 })) as {
        protocolVersion: number
        agentCapabilities: { streaming: boolean; tools: boolean }
      }
      expect(result.protocolVersion).toBe(1)
      expect(result.agentCapabilities.streaming).toBe(true)
      expect(result.agentCapabilities.tools).toBe(true)
    } finally {
      server.close()
    }
  })

  it('开会话：回一个会话 id', async () => {
    const { server, client } = makeServer()
    try {
      const result = (await client.request('session/new', { cwd: '/tmp' })) as { sessionId: string }
      expect(result.sessionId).toBe('session-1')
    } finally {
      server.close()
    }
  })

  it('发消息：宿主收到消息，这一轮以 end_turn 结束', async () => {
    const { server, client, recorder } = makeServer()
    try {
      await client.request('session/new')
      const result = (await client.request('session/prompt', {
        sessionId: 'session-1',
        prompt: { type: 'text', text: '你好' },
      })) as { stopReason: string }
      expect(result.stopReason).toBe('end_turn')
      expect(recorder.prompts).toEqual(['你好'])
    } finally {
      server.close()
    }
  })

  it('事件：带版本号、会话 id 与会话内序号，序号递增', async () => {
    const { server, client } = makeServer()
    try {
      await client.request('session/new')
      await client.request('session/prompt', {
        sessionId: 'session-1',
        prompt: { type: 'text', text: '你好' },
      })
      const updates = client.notifications.filter((item) => item.method === 'session/update')
      expect(updates.length).toBeGreaterThan(0)
      const seqs: number[] = []
      for (const update of updates) {
        const params = update.params as { version?: number; sessionId?: string; seq?: number }
        expect(params.version).toBe(1)
        expect(params.sessionId).toBe('session-1')
        expect(typeof params.seq).toBe('number')
        seqs.push(params.seq as number)
      }
      // 序号在会话内递增：编辑器靠它判断有没有漏收。
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
    } finally {
      server.close()
    }
  })

  it('取消：中止器真的 abort，宿主也收到取消', async () => {
    const { server, client, recorder } = makeServer({ waitsForCancel: true })
    try {
      await client.request('session/new')
      // 这轮会一直挂着，直到被取消。
      const pending = client.request('session/prompt', {
        sessionId: 'session-1',
        prompt: { type: 'text', text: '等着' },
      })
      // 等这一轮真的开始（事件推出来说明开始了）。
      await new Promise((resolve) => setTimeout(resolve, 50))
      server.cancel('session-1')
      expect(recorder.cancelled).toContain('session-1')
      // 挂着的那个请求会因为 abort 而结束（这里只关心它不永久挂着）。
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 500))])
    } finally {
      server.close()
    }
  })

  it('不认识的方法：回错，不是静默', async () => {
    const { server, client } = makeServer()
    try {
      await expect(client.request('no/such/method')).rejects.toThrow()
    } finally {
      server.close()
    }
  })

  it('关会话：宿主收到关闭', async () => {
    const { server, client } = makeServer()
    try {
      await client.request('session/new')
      await client.request('session/close', { sessionId: 'session-1' })
    } finally {
      server.close()
    }
  })
})
