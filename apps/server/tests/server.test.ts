import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ryagent/cordis'
import LlmRuntime, { LlmAdapter } from '@ryagent/llm'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import { RyAgentServer } from '@ryagent/server'
import type { WsEvent } from '@ryagent/server'
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

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.replies[this.calls++] ?? ''
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> { yield* chunks })()
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
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function postJson(base: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** 收集 WS 事件：先等连接建立（ready）再触发动作，直到满足条件或超时。 */
function collectWs(
  base: string,
  conversationId: string,
  until: (events: WsEvent[]) => boolean,
  timeoutMs = 8000,
): { ready: Promise<void>; done: Promise<WsEvent[]> } {
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((resolve) => { readyResolve = resolve })
  const done = new Promise<WsEvent[]>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
    const events: WsEvent[] = []
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`WS collection timed out after ${timeoutMs}ms; events so far: ${events.map((e) => { return e.type }).join(',')}`))
    }, timeoutMs)
    ws.on('open', () => { readyResolve() })
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

describe('RyAgentServer', () => {
  it('serves templates, agents CRUD with builtin protection, and providers', async () => {
    const { server, base } = await startServer([])
    try {
      const templates = await getJson(base, '/api/agent-templates')
      expect(templates.status).toBe(200)
      const keys = (templates.body.templates as { key: string }[]).map((t) => { return t.key })
      expect(keys).toEqual(['general', 'coding', 'writing', 'translation', 'file-organizer'])

      const agents = await getJson(base, '/api/agents')
      const seeded = (agents.body.agents as { id: string; isBuiltin: boolean }[]).find((a) => { return a.id === 'ryen' })
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
    const { server, base } = await startServer([
      '收到，我来协调。@Coder 写个草案',
      '草案写好了。',
    ])
    try {
      // 把种子的 Ryen 与新建 agent 的 provider 指到 mock 路由（默认是 siliconflow）
      await fetch(`${base}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      // 建 Coding Agent + 群（Ryen + Coder）
      const created = await postJson(base, '/api/agents', {
        templateKey: 'coding', name: 'Coder', provider: 'mock', model: 'mock',
      })
      const coderId = (created.body as { agent: { id: string } }).agent.id
      const group = await postJson(base, '/api/conversations', {
        kind: 'group', memberAgentIds: ['ryen', coderId], title: '验证群',
      })
      expect(group.status).toBe(201)
      const conversationId = (group.body as { conversation: { id: string; dispatcherAgentId: string } }).conversation.id
      expect((group.body as { conversation: { dispatcherAgentId: string } }).conversation.dispatcherAgentId).toBe('ryen')

      // WS 先订阅（等连接建立），再发消息
      const collector = collectWs(
        base,
        conversationId,
        (events) => {
          const dones = events.filter((e) => { return e.type === 'message-done' })
          return dones.some((e) => { return e.type === 'message-done' && e.senderId === 'ryen' })
            && dones.some((e) => { return e.type === 'message-done' && e.senderId === coderId })
        },
      )
      await collector.ready
      const posted = await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '这个需求怎么做？' })
      expect(posted.status).toBe(202)
      const events = await collector.done

      const kinds = events.map((e) => { return e.type })
      // 用户消息起播 + 调度员入口 + 接力 + 两条发言完成
      expect(kinds[0]).toBe('message-start')
      expect(kinds.filter((k) => { return k === 'message-start' })).toHaveLength(3)
      expect(kinds.filter((k) => { return k === 'message-done' })).toHaveLength(2)
      expect(kinds).toContain('dispatch')
      expect(kinds).toContain('text-delta')
      const dispatches = events.filter((e) => { return e.type === 'dispatch' })
      expect(dispatches.map((d) => { return d.type === 'dispatch' ? `${d.reason}->${d.toAgent}` : '' }))
        .toEqual(['default-dispatcher->ryen', `relay @Coder->${coderId}`])

      // 拉消息列表断言与 WS 一致
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = (messages.body as { messages: { senderType: string; senderId?: string }[] }).messages
      expect(rows.map((m) => { return `${m.senderType}:${m.senderId ?? '-'}` }))
        .toEqual(['user:user', 'agent:ryen', `agent:${coderId}`])

      // 会话列表含预览
      const list = await getJson(base, '/api/conversations')
      const entry = (list.body.conversations as { id: string; lastMessagePreview: string; unreadCount: number }[])
        .find((c) => { return c.id === conversationId })
      expect(entry?.lastMessagePreview).toBe('草案写好了。')
      expect(entry?.unreadCount).toBe(0)

      // 删会话级联清消息
      const deleted = await fetch(`${base}/api/conversations/${conversationId}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      const gone = await getJson(base, `/api/conversations/${conversationId}`)
      expect(gone.status).toBe(404)
    } finally {
      await server.close()
    }
  }, 20_000)

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
      const escape = await fetch(`${base}/api/files/..%2Fryagent.db`)
      expect(escape.status).toBe(400)
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

      const collector = collectWs(
        base, conversationId,
        (events) => { return events.some((e) => { return e.type === 'message-done' }) },
      )
      await collector.ready
      const posted = await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      expect(posted.status).toBe(202)
      const events = await collector.done
      expect(events.map((e) => { return e.type }))
        .toEqual(['message-start', 'message-start', 'text-delta', 'message-done'])
      expect((events[1] as { senderId: string }).senderId).toBe('ryen')
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = (messages.body as { messages: { senderType: string; senderId?: string }[] }).messages
      expect(rows.map((m) => { return `${m.senderType}:${m.senderId ?? '-'}` })).toEqual(['user:user', 'agent:ryen'])
    } finally {
      await server.close()
    }
  })
})
