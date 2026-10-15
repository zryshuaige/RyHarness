/**
 * GET /api/conversations/:id/messages 的 around 游标：搜索命中的定位窗口。
 *
 * 聊天区一次只加载最新一页，命中多半在更早的历史里——客户端要能把那条消息前后
 * 的上下文整段取回来插进流里。这里走真实 HTTP + 真实落库消息。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryagent/cordis'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import { LlmAdapter } from '@ryagent/llm'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryagent-around-${prefix}-`))
  tmpDirs.push(dir)
  return dir
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

class EchoAdapter extends LlmAdapter {
  constructor(private readonly text: string) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Echo' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: this.text },
      { type: 'block-end', index: 0, block: { type: 'text', text: this.text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

async function startServer(dataDir: string): Promise<RyAgentServer> {
  return RyAgentServer.create({
    port: 0,
    dataDir,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new EchoAdapter('收到。'))
    },
  })
}

async function sendJson(
  base: string,
  path: string,
  method: 'POST' | 'PATCH',
  payload: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await response.json()) as Record<string, unknown>
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface MessageRow {
  id: string
  seq: number
  contentBlocks: { type: string; text?: string }[]
}

async function listAll(base: string, conversationId: string): Promise<MessageRow[]> {
  const response = await getJson(base, `/api/conversations/${conversationId}/messages?limit=200`)
  return (response.body as { messages: MessageRow[] }).messages
}

/** 串行排队的一轮要跑完才落下一条：按条数等，不依赖 WS。 */
async function waitForMessages(base: string, conversationId: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await listAll(base, conversationId)).length >= expected) return
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
  }
  throw new Error(`conversation ${conversationId} did not reach ${expected} messages`)
}

const textOf = (row: MessageRow): string => {
  return row.contentBlocks
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.text ?? ''
    })
    .join('\n')
}

/** 建一个会话并发 rounds 轮消息（每轮两条：用户 + agent），返回全部消息行。 */
async function seedConversation(base: string, rounds: number): Promise<{ conversationId: string; rows: MessageRow[] }> {
  await sendJson(base, '/api/agents/ryen', 'PATCH', { provider: 'mock', model: 'mock' })
  const created = await sendJson(base, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
  const conversationId = (created.conversation as { id: string }).id
  for (let round = 1; round <= rounds; round++) {
    await sendJson(base, `/api/conversations/${conversationId}/messages`, 'POST', { text: `第${round}轮的话` })
  }
  await waitForMessages(base, conversationId, rounds * 2)
  return { conversationId, rows: await listAll(base, conversationId) }
}

describe('GET /api/conversations/:id/messages?around=', () => {
  it('回命中前后各若干条（含命中本身），并按 seq 升序、带出命中位置', async () => {
    const server = await startServer(tempDataDir('window'))
    try {
      const { conversationId, rows } = await seedConversation(server.url, 8)
      // 每轮两条（用户 + agent），所以第 3 轮那句话是 rows[4]。
      const hit = rows[4]!
      expect(textOf(hit)).toBe('第3轮的话')

      const response = await getJson(
        server.url,
        `/api/conversations/${conversationId}/messages?around=${encodeURIComponent(hit.id)}&window=2`,
      )
      expect(response.status).toBe(200)
      const body = response.body as { messages: MessageRow[]; hit: { messageId: string; seq: number } }
      // 命中前后各 2 条 + 命中本身。
      expect(body.messages).toHaveLength(5)
      expect(body.hit).toEqual({ messageId: hit.id, seq: hit.seq })
      expect(
        body.messages.map((row) => {
          return row.seq
        }),
      ).toEqual([hit.seq - 2, hit.seq - 1, hit.seq, hit.seq + 1, hit.seq + 2])
      // 命中那条必须在窗口里：客户端就是按它的 data-message-id 定位的。
      expect(
        body.messages.map((row) => {
          return row.id
        }),
      ).toContain(hit.id)
    } finally {
      await server.close()
    }
  })

  it('命中在最旧/最新一条时，窗口只往有内容的那一侧取', async () => {
    const server = await startServer(tempDataDir('edges'))
    try {
      const { conversationId, rows } = await seedConversation(server.url, 6)
      const oldest = rows[0]!
      const newest = rows[rows.length - 1]!

      const head = (
        await getJson(
          server.url,
          `/api/conversations/${conversationId}/messages?around=${encodeURIComponent(oldest.id)}&window=3`,
        )
      ).body as { messages: MessageRow[]; hit: { seq: number } }
      expect(head.messages[0]?.id).toBe(oldest.id)
      expect(head.hit.seq).toBe(oldest.seq)
      expect(head.messages).toHaveLength(4)

      const tail = (
        await getJson(
          server.url,
          `/api/conversations/${conversationId}/messages?around=${encodeURIComponent(newest.id)}&window=3`,
        )
      ).body as { messages: MessageRow[]; hit: { seq: number } }
      expect(tail.messages[tail.messages.length - 1]?.id).toBe(newest.id)
      expect(tail.hit.seq).toBe(newest.seq)
      expect(tail.messages).toHaveLength(4)
    } finally {
      await server.close()
    }
  })

  it('window 缺省 25、超上限夹到 50；不认识的命中回 404 而不是空窗口', async () => {
    const server = await startServer(tempDataDir('clamp'))
    try {
      const { conversationId, rows } = await seedConversation(server.url, 40)
      const hit = rows[40]!

      const defaulted = (await getJson(server.url, `/api/conversations/${conversationId}/messages?around=${hit.id}`))
        .body as { messages: MessageRow[] }
      // 缺省 25：命中前后共 51 条（80 条消息里取得到）。
      expect(defaulted.messages).toHaveLength(51)

      const clamped = (
        await getJson(server.url, `/api/conversations/${conversationId}/messages?around=${hit.id}&window=999`)
      ).body as { messages: MessageRow[] }
      expect(clamped.messages).toHaveLength(80)

      const zero = (
        await getJson(server.url, `/api/conversations/${conversationId}/messages?around=${hit.id}&window=0`)
      ).body as { messages: MessageRow[] }
      expect(zero.messages).toHaveLength(51)

      const missing = await getJson(
        server.url,
        `/api/conversations/${conversationId}/messages?around=${encodeURIComponent('nope')}`,
      )
      expect(missing.status).toBe(404)
      expect((missing.body as { error?: string }).error).toBe('message not found')
    } finally {
      await server.close()
    }
  })

  it('around 与 before 互斥：给了 around 就以命中为中心，不按最新一页回', async () => {
    const server = await startServer(tempDataDir('precedence'))
    try {
      const { conversationId, rows } = await seedConversation(server.url, 10)
      const hit = rows[2]!
      const response = await getJson(
        server.url,
        `/api/conversations/${conversationId}/messages?around=${encodeURIComponent(hit.id)}&before=99&window=1`,
      )
      const body = response.body as { messages: MessageRow[] }
      expect(
        body.messages.map((row) => {
          return row.id
        }),
      ).toEqual([rows[1]!.id, hit.id, rows[3]!.id])
    } finally {
      await server.close()
    }
  })

  it('会话不存在时同样 404（不因为多了个游标就绕过会话校验）', async () => {
    const server = await startServer(tempDataDir('no-conv'))
    try {
      const response = await getJson(server.url, '/api/conversations/nope/messages?around=whatever')
      expect(response.status).toBe(404)
      expect((response.body as { error?: string }).error).toBe('conversation not found')
    } finally {
      await server.close()
    }
  })
})
