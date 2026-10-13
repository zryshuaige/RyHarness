import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryagent/cordis'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import LlmRuntime, { LlmAdapter } from '@ryagent/llm'
import type { WsEvent } from '@ryagent/server'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

/** 按调用顺序消费脚本回复的 mock 适配器。 */
class MockAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly replies: string[]) {
    super()
  }

  callsMade(): number {
    return this.calls
  }

  protected lastUserText(options: GenerateOptions): string {
    const last = options.messages[options.messages.length - 1]
    return last === undefined ? '' : String((last.content[0] as { text?: string }).text ?? '')
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    return this.chunksFor(this.scriptedText(options))
  }

  /** 子类可覆盖：决定本次调用的回复文本。 */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: 子类覆盖点，基类实现不需要 options
  protected scriptedText(options: GenerateOptions): string {
    return this.replies[this.calls - 1] ?? ''
  }

  /** 子类可覆盖：自定义 chunk 流（如加延迟门）。 */
  protected chunksFor(text: string): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

const tmpDirs: string[] = []

async function startServer(replies: string[]): Promise<{ server: RyAgentServer; adapter: MockAdapter; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-test-'))
  tmpDirs.push(dataDir)
  const adapter = new MockAdapter(replies)
  const server = await RyAgentServer.create({
    port: 0,
    dataDir,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
  return { server, adapter, base: server.url }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function postJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 收集 WS 事件：先等连接建立（ready）再触发动作，直到满足条件或超时。 */
function collectWs(
  base: string,
  conversationId: string,
  until: (events: WsEvent[]) => boolean,
  timeoutMs = 8000,
): { ready: Promise<void>; done: Promise<WsEvent[]> } {
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })
  const done = new Promise<WsEvent[]>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
    const events: WsEvent[] = []
    const timer = setTimeout(() => {
      ws.terminate()
      reject(
        new Error(
          `WS collection timed out after ${timeoutMs}ms; events so far: ${events
            .map((e) => {
              return e.type
            })
            .join(',')}`,
        ),
      )
    }, timeoutMs)
    ws.on('open', () => {
      readyResolve()
    })
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as WsEvent
      events.push(event)
      if (until(events)) {
        clearTimeout(timer)
        ws.terminate()
        resolve(events)
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { ready, done }
}

/** 轮询等待条件成立（测试用，最长 5s）。 */
async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

describe('RyAgentServer', () => {
  it('serves templates, agents CRUD with builtin protection, and providers', async () => {
    const { server, base } = await startServer([])
    try {
      const templates = await getJson(base, '/api/agent-templates')
      expect(templates.status).toBe(200)
      const keys = (templates.body.templates as { key: string }[]).map((t) => {
        return t.key
      })
      expect(keys).toEqual(['general', 'coding', 'writing', 'translation', 'file-organizer'])

      const agents = await getJson(base, '/api/agents')
      const seeded = (agents.body.agents as { id: string; isBuiltin: boolean }[]).find((a) => {
        return a.id === 'ryen'
      })
      expect(seeded?.isBuiltin).toBe(true)

      const created = await postJson(base, '/api/agents', { templateKey: 'coding', name: 'Coder' })
      expect(created.status).toBe(201)
      const coder = (created.body as { agent: { id: string; tools: string[] } }).agent
      expect(coder.tools).toEqual(['fs_read', 'fs_write', 'shell_exec', 'file_produce'])

      const patched = await fetch(`${base}/api/agents/${coder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temperature: 0.2 }),
      })
      expect(patched.status).toBe(200)
      expect(((await patched.json()) as { agent: { temperature: number } }).agent.temperature).toBe(0.2)

      const deleteBuiltin = await fetch(`${base}/api/agents/ryen`, { method: 'DELETE' })
      expect(deleteBuiltin.status).toBe(409)
      const deleteCoder = await fetch(`${base}/api/agents/${coder.id}`, { method: 'DELETE' })
      expect(deleteCoder.status).toBe(200)

      const badTemplate = await postJson(base, '/api/agents', { templateKey: 'nope' })
      expect(badTemplate.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('group chat end-to-end: REST + WS events + persisted messages', async () => {
    const { server, base } = await startServer(['收到，我来协调。@Coder 写个草案', '草案写好了。'])
    try {
      // 把种子的 Ryen 与新建 agent 的 provider 指到 mock 路由（默认是 siliconflow）
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      // 建 Coding Agent + 群（Ryen + Coder）
      const created = await postJson(base, '/api/agents', {
        templateKey: 'coding',
        name: 'Coder',
        provider: 'mock',
        model: 'mock',
      })
      const coderId = (created.body as { agent: { id: string } }).agent.id
      const group = await postJson(base, '/api/conversations', {
        kind: 'group',
        memberAgentIds: ['ryen', coderId],
        title: '验证群',
      })
      expect(group.status).toBe(201)
      const conversationId = (group.body as { conversation: { id: string; dispatcherAgentId: string } }).conversation.id
      expect((group.body as { conversation: { dispatcherAgentId: string } }).conversation.dispatcherAgentId).toBe(
        'ryen',
      )

      // WS 先订阅（等连接建立），再发消息
      const collector = collectWs(base, conversationId, (events) => {
        const dones = events.filter((e) => {
          return e.type === 'message-done'
        })
        return (
          dones.some((e) => {
            return e.type === 'message-done' && e.senderId === 'ryen'
          }) &&
          dones.some((e) => {
            return e.type === 'message-done' && e.senderId === coderId
          })
        )
      })
      await collector.ready
      const posted = await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '这个需求怎么做？' })
      expect(posted.status).toBe(202)
      const events = await collector.done

      const kinds = events.map((e) => {
        return e.type
      })
      // 用户消息起播 + 调度员入口 + 接力 + 两条发言完成
      expect(kinds[0]).toBe('message-start')
      expect(
        kinds.filter((k) => {
          return k === 'message-start'
        }),
      ).toHaveLength(3)
      expect(
        kinds.filter((k) => {
          return k === 'message-done'
        }),
      ).toHaveLength(2)
      expect(kinds).toContain('dispatch')
      expect(kinds).toContain('text-delta')
      const dispatches = events.filter((e) => {
        return e.type === 'dispatch'
      })
      expect(
        dispatches.map((d) => {
          return d.type === 'dispatch' ? `${d.reason}->${d.toAgent}` : ''
        }),
      ).toEqual(['default-dispatcher->ryen', `relay @Coder->${coderId}`])

      // 拉消息列表断言与 WS 一致
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = (messages.body as { messages: { senderType: string; senderId?: string }[] }).messages
      expect(
        rows.map((m) => {
          return `${m.senderType}:${m.senderId ?? '-'}`
        }),
      ).toEqual(['user:user', 'agent:ryen', `agent:${coderId}`])

      // 会话列表含预览与真实未读数（两条 agent 发言未读）
      const list = await getJson(base, '/api/conversations')
      const entry = (list.body.conversations as { id: string; lastMessagePreview: string; unreadCount: number }[]).find(
        (c) => {
          return c.id === conversationId
        },
      )
      expect(entry?.lastMessagePreview).toBe('草案写好了。')
      expect(entry?.unreadCount).toBe(2)
      await postJson(base, `/api/conversations/${conversationId}/read`, {})
      const listAfterRead = await getJson(base, '/api/conversations')
      const entryAfter = (listAfterRead.body.conversations as { id: string; unreadCount: number }[]).find((c) => {
        return c.id === conversationId
      })
      expect(entryAfter?.unreadCount).toBe(0)

      // 删会话级联清消息
      const deleted = await fetch(`${base}/api/conversations/${conversationId}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      const gone = await getJson(base, `/api/conversations/${conversationId}`)
      expect(gone.status).toBe(404)
    } finally {
      await server.close()
    }
  }, 20_000)

  it('memory endpoints: agent memories + shared profile + soft delete + stats', async () => {
    const { MemoryService, HashEmbeddings } = await import('@ryagent/memory')
    const { mkdtempSync } = await import('node:fs')
    const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-mem-'))
    tmpDirs.push(dataDir)
    const memory = new MemoryService({
      dbPath: join(dataDir, 'ryagent.db'),
      embeddings: new HashEmbeddings(),
    })
    memory.store.insert({ agentId: 'ryen', kind: 'fact', content: 'Ryen 的私有约定' })
    memory.store.insert({ agentId: '*shared*', kind: 'profile', content: '用户是产品经理' })
    const server = await RyAgentServer.create({ port: 0, dataDir, memory })
    try {
      const res = await getJson(server.url, '/api/agents/ryen/memories')
      const body = res.body as { agent: { content: string }[]; shared: { content: string }[] }
      expect(
        body.agent.map((m) => {
          return m.content
        }),
      ).toContain('Ryen 的私有约定')
      expect(
        body.shared.map((m) => {
          return m.content
        }),
      ).toContain('用户是产品经理')

      const stats = await getJson(server.url, '/api/memory/stats')
      expect((stats.body as { enabled: boolean }).enabled).toBe(true)

      const list = (await getJson(server.url, '/api/agents/ryen/memories')).body as { agent: { id: string }[] }
      const del = await fetch(`${server.url}/api/memories/${list.agent[0]!.id}`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const after = (await getJson(server.url, '/api/agents/ryen/memories')).body as { agent: unknown[] }
      expect(after.agent).toHaveLength(0)
    } finally {
      await server.close() // server.close 会一并关闭注入的 MemoryService
    }
  })

  it('serves produce-card events and downloads produced files (whitelist)', async () => {
    const { server, base } = await startServer([])
    try {
      // 不经过 LLM，直接在工作区产物目录造一个文件验证下载白名单
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const artifacts = join(server.dataDir, 'workspace', '.ryagent-artifacts')
      mkdirSync(artifacts, { recursive: true })
      writeFileSync(join(artifacts, 'hello.txt'), 'hello file')

      const ok = await fetch(`${base}/api/files/hello.txt`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('hello file')
      expect(ok.headers.get('content-type')).toContain('text/plain')

      const missing = await fetch(`${base}/api/files/nope.txt`)
      expect(missing.status).toBe(404)
      const traversal = await fetch(`${base}/api/files/..%2Fryagent.db`)
      expect(traversal.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('direct conversation: 202 + WS stream + persisted reply', async () => {
    const { server, base } = await startServer(['单聊回复。'])
    try {
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const direct = await postJson(base, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      expect(direct.status).toBe(201)
      const conversationId = (direct.body as { conversation: { id: string } }).conversation.id

      const collector = collectWs(base, conversationId, (events) => {
        return events.some((e) => {
          return e.type === 'message-done'
        })
      })
      await collector.ready
      const posted = await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      expect(posted.status).toBe(202)
      const events = await collector.done
      expect(
        events.map((e) => {
          return e.type
        }),
      ).toEqual(['message-start', 'message-start', 'text-delta', 'message-done'])
      expect((events[1] as { senderId: string }).senderId).toBe('ryen')
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = (messages.body as { messages: { senderType: string; senderId?: string }[] }).messages
      expect(
        rows.map((m) => {
          return `${m.senderType}:${m.senderId ?? '-'}`
        }),
      ).toEqual(['user:user', 'agent:ryen'])
    } finally {
      await server.close()
    }
  })

  it('同会话消息串行：第二个请求排队，queued 事件先行，顺序不乱', async () => {
    // 第一个回复延迟 300ms，给第二条消息留出"撞上忙期"的窗口。
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const calls: string[] = []
    class GatedAdapter extends MockAdapter {
      protected override scriptedText(options: GenerateOptions): string {
        const text = this.lastUserText(options)
        calls.push(text)
        return `R${calls.length}`
      }

      protected override chunksFor(_text: string): AsyncIterable<StreamChunk> {
        return (async function* (): AsyncGenerator<StreamChunk> {
          if (calls.length === 1) await gate
          yield { type: 'text-delta', index: 0, text: `R${calls.length}` }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: `R${calls.length}` } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-queue-'))
    tmpDirs.push(dataDir)
    const adapter = new GatedAdapter(['', ''])
    const server = await RyAgentServer.create({
      port: 0,
      dataDir,
      mountLlm: (ctx) => {
        ctx.llm.registerAdapter(['mock'], adapter)
      },
    })
    try {
      await fetch(`${server.url}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const { conversation } = (await (
        await fetch(`${server.url}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
        })
      ).json()) as { conversation: { id: string } }

      const collector = collectWs(server.url, conversation.id, (events) => {
        return (
          events.filter((e) => {
            return e.type === 'message-done'
          }).length >= 2
        )
      })
      await collector.ready
      const first = await postJson(server.url, `/api/conversations/${conversation.id}/messages`, { text: '第一条' })
      expect(first.status).toBe(202)
      const second = await postJson(server.url, `/api/conversations/${conversation.id}/messages`, { text: '第二条' })
      expect(second.status).toBe(202)
      releaseFirst()
      const events = await collector.done
      // queued 事件在第二条处理前到达。
      expect(
        events.some((e) => {
          return e.type === 'queued'
        }),
      ).toBe(true)
      expect(calls).toEqual(['第一条', '第二条'])
      const messages = await getJson(server.url, `/api/conversations/${conversation.id}/messages`)
      const rows = (messages.body as { messages: { contentBlocks: { text?: string }[] }[] }).messages
      const texts = rows.map((m) => {
        return (m.contentBlocks[0] as { text?: string }).text
      })
      expect(texts).toEqual(['第一条', 'R1', '第二条', 'R2'])
    } finally {
      await server.close()
    }
  }, 20_000)

  it('未读徽标：agent 回复后 unreadCount=1，POST read 归零；用户消息不计未读', async () => {
    const { server, base } = await startServer(['未读回复。'])
    try {
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const { conversation } = (await (
        await fetch(`${base}/api/conversations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
        })
      ).json()) as { conversation: { id: string } }

      const collector = collectWs(base, conversation.id, (events) => {
        return events.some((e) => {
          return e.type === 'message-done'
        })
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversation.id}/messages`, { text: '在吗' })
      await collector.done

      const list1 = await getJson(base, '/api/conversations')
      const entry1 = (list1.body.conversations as { id: string; unreadCount: number }[]).find((c) => {
        return c.id === conversation.id
      })
      expect(entry1?.unreadCount).toBe(1)

      const read = await postJson(base, `/api/conversations/${conversation.id}/read`, {})
      expect(read.status).toBe(200)
      expect((read.body as { lastReadSeq: number }).lastReadSeq).toBeGreaterThan(0)

      const list2 = await getJson(base, '/api/conversations')
      const entry2 = (list2.body.conversations as { id: string; unreadCount: number }[]).find((c) => {
        return c.id === conversation.id
      })
      expect(entry2?.unreadCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('PATCH /api/agents/:id 与 POST 同款白名单校验：类型错误 400，未知键丢弃', async () => {
    const { server, base } = await startServer([])
    try {
      const patch = (payload: unknown): Promise<Response> => {
        return fetch(`${base}/api/agents/ryen`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      expect((await patch({ temperature: 'abc' })).status).toBe(400)
      expect((await patch({ tools: 'not-an-array' })).status).toBe(400)
      expect((await patch({ name: 42 })).status).toBe(400)
      // 未知键（createdAt 等）被丢弃而不是入库；合法字段正常合并
      const ok = await patch({ createdAt: 0, hacker: true, name: '猫管家二世' })
      expect(ok.status).toBe(200)
      const agent = ((await ok.json()) as { agent: Record<string, unknown> }).agent
      expect(agent.name).toBe('猫管家二世')
      expect('hacker' in agent).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('非法 JSON body 与非法 URL 编码回 400 而非 500', async () => {
    const { server, base } = await startServer([])
    try {
      const badJson = await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      expect(badJson.status).toBe(400)
      const badUrl = await fetch(`${base}/api/files/%E0%A4%A`)
      expect(badUrl.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('Origin 白名单：空/回环放行，外部源 HTTP 403、WS 拒绝升级', async () => {
    const { server, base } = await startServer([])
    try {
      expect((await getJson(base, '/api/agents')).status).toBe(200) // 无 Origin（Node/curl/Electron file://）
      const viteDev = await fetch(`${base}/api/agents`, { headers: { origin: 'http://localhost:5173' } })
      expect(viteDev.status).toBe(200)
      const loopback = await fetch(`${base}/api/agents`, { headers: { origin: 'http://127.0.0.1:32100' } })
      expect(loopback.status).toBe(200)
      // Electron 渲染层（file:// 页面）的 WS 握手带 Origin: file://，必须放行
      const fileOrigin = await fetch(`${base}/api/agents`, { headers: { origin: 'file://' } })
      expect(fileOrigin.status).toBe(200)
      const evil = await fetch(`${base}/api/agents`, { headers: { origin: 'https://evil.example' } })
      expect(evil.status).toBe(403)

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=c1`, {
          headers: { origin: 'https://evil.example' },
        })
        ws.on('open', () => {
          ws.terminate()
          reject(new Error('WS upgrade should have been refused for a foreign origin'))
        })
        ws.on('error', () => {
          resolve()
        })
      })
    } finally {
      await server.close()
    }
  })

  it('close() 幂等：重复调用复用同一停机流程，不抛错', async () => {
    const { server } = await startServer([])
    await Promise.all([server.close(), server.close()])
    await server.close()
  })

  it('WS 事件带每会话单调递增 seq（客户端可据此发现断线缺口）', async () => {
    const { server, base } = await startServer(['你好。'])
    try {
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const direct = await postJson(base, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (direct.body as { conversation: { id: string } }).conversation.id

      const collector = collectWs(base, conversationId, (events) => {
        return events.some((e) => {
          return e.type === 'message-done'
        })
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      const events = await collector.done
      const seqs = events.map((e) => {
        return (e as { seq?: number }).seq
      })
      expect(seqs).toEqual([1, 2, 3, 4])
    } finally {
      await server.close()
    }
  })

  it('WS 心跳：连续两轮未 pong 的半死连接被 terminate', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-heartbeat-'))
    tmpDirs.push(dataDir)
    const server = await RyAgentServer.create({
      port: 0,
      dataDir,
      wsHeartbeatMs: 60,
      mountLlm: (ctx) => {
        ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
      },
    })
    try {
      const port = Number(new URL(server.url).port)
      const socket = connect(port, '127.0.0.1')
      // 裸 TCP 完成 WS 握手后永不回 pong。
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.once('connect', () => {
          socket.write(
            'GET /ws?conversationId=c1 HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          )
          resolve()
        })
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('server did not terminate the dead connection within two heartbeat rounds'))
        }, 5000)
        // 裸 socket 必须排空入站帧（握手响应 + ping），否则 close 事件不可靠。
        socket.on('data', () => {})
        socket.on('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } finally {
      await server.close()
    }
  }, 10_000)

  it('优雅停机：close() 先等在途 turn 完成再关库（事件能送达客户端）', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    class GatedAdapter extends MockAdapter {
      protected override scriptedText(options: GenerateOptions): string {
        calls.push(this.lastUserText(options))
        return '慢回复'
      }

      protected override chunksFor(text: string): AsyncIterable<StreamChunk> {
        return (async function* (): AsyncGenerator<StreamChunk> {
          await gate
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-drain-'))
    tmpDirs.push(dataDir)
    const server = await RyAgentServer.create({
      port: 0,
      dataDir,
      mountLlm: (ctx) => {
        ctx.llm.registerAdapter(['mock'], new GatedAdapter([]))
      },
    })
    await fetch(`${server.url}/api/agents/ryen`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', model: 'mock' }),
    })
    const { conversation } = (await (
      await fetch(`${server.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
      })
    ).json()) as { conversation: { id: string } }

    const collector = collectWs(server.url, conversation.id, (events) => {
      return events.some((e) => {
        return e.type === 'message-done'
      })
    })
    await collector.ready
    await postJson(server.url, `/api/conversations/${conversation.id}/messages`, { text: '慢慢来' })
    await waitFor(() => {
      return calls.length > 0
    })

    const closePromise = server.close()
    const early = await Promise.race([
      closePromise.then(() => {
        return 'closed' as const
      }),
      new Promise<'waiting'>((resolve) => {
        setTimeout(() => {
          resolve('waiting')
        }, 300)
      }),
    ])
    expect(early).toBe('waiting') // turn 未完成前 close 不得关库返回
    release()
    const events = await collector.done
    expect(
      events.map((e) => {
        return e.type
      }),
    ).toEqual(['message-start', 'message-start', 'text-delta', 'message-done'])
    await closePromise
  }, 20_000)

  it('优雅停机超时兜底：在途 turn 卡死时 close() 也在超时后完成', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    class StuckAdapter extends MockAdapter {
      protected override scriptedText(options: GenerateOptions): string {
        calls.push(this.lastUserText(options))
        return '卡死'
      }

      protected override chunksFor(text: string): AsyncIterable<StreamChunk> {
        return (async function* (): AsyncGenerator<StreamChunk> {
          await gate
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-server-timeout-'))
    tmpDirs.push(dataDir)
    const server = await RyAgentServer.create({
      port: 0,
      dataDir,
      shutdownTimeoutMs: 200,
      mountLlm: (ctx) => {
        ctx.llm.registerAdapter(['mock'], new StuckAdapter([]))
      },
    })
    await fetch(`${server.url}/api/agents/ryen`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock', model: 'mock' }),
    })
    const { conversation } = (await (
      await fetch(`${server.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
      })
    ).json()) as { conversation: { id: string } }
    await postJson(server.url, `/api/conversations/${conversation.id}/messages`, { text: '卡住' })
    await waitFor(() => {
      return calls.length > 0
    })
    await server.close() // turn 永不放行也应 ~200ms 后完成停机
    release() // 放行悬挂的 turn；写已关闭的库由 runTurn 的 catch 兜住
  }, 20_000)
})
