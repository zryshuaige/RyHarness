/**
 * 会话管理面：改名/置顶/静音/换群成员（PATCH）与会话内全文搜索（GET /api/search）。
 *
 * 走真实 HTTP + 真实文件读写（临时目录）：界面态落在 <dataDir>/conversation-state.json，
 * 因此这里还要验证"重启后仍在"。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-conv-admin-${prefix}-`))
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

/** 一次性回固定文本的适配器（搜索结果需要真实落库的消息）。 */
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

async function startServer(dataDir: string): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new EchoAdapter('已经记下了，这轮就到这儿。'))
    },
  })
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function sendJson(
  base: string,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface ConversationRow {
  id: string
  title: string
  memberAgentIds: string[]
  dispatcherAgentId?: string
  pinned: boolean
  muted: boolean
}

/** 把种子的 Ryen 指到 mock 路由（否则模型调用落回 siliconflow，turn 只会报错）。 */
async function useMockRyen(base: string): Promise<void> {
  await sendJson(base, '/api/agents/ryen', 'PATCH', { provider: 'mock', model: 'mock' })
}

/** 把种子的 Ryen 指到 mock 路由，并建一个 agent。 */
async function seedMockAgents(base: string, templateKey: string, name: string): Promise<string> {
  await useMockRyen(base)
  const created = await sendJson(base, '/api/agents', 'POST', {
    templateKey,
    name,
    provider: 'mock',
    model: 'mock',
  })
  return (created.body as { agent: { id: string } }).agent.id
}

/** 等一轮真正结束（按消息条数判断，避免依赖 WS）。 */
async function waitForMessages(base: string, conversationId: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await getJson(base, `/api/conversations/${conversationId}/messages?limit=50`)
    const rows = (res.body as { messages: unknown[] }).messages
    if (rows.length >= expected) return
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  throw new Error(`conversation ${conversationId} did not reach ${expected} messages`)
}

describe('PATCH /api/conversations/:id', () => {
  it('改名、置顶、静音一次改完，回执带回写后的会话', async () => {
    const server = await startServer(tempDataDir('patch'))
    try {
      const coderId = await seedMockAgents(server.url, 'coding', 'Coder')
      const created = await sendJson(server.url, '/api/conversations', 'POST', {
        kind: 'group',
        memberAgentIds: ['ryen', coderId],
        title: '验证群',
      })
      const conversationId = (created.body as { conversation: ConversationRow }).conversation.id

      const patched = await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', {
        title: '重构小组',
        pinned: true,
        muted: true,
      })
      expect(patched.status).toBe(200)
      const conversation = (patched.body as { conversation: ConversationRow }).conversation
      expect(conversation.title).toBe('重构小组')
      expect(conversation.pinned).toBe(true)
      expect(conversation.muted).toBe(true)

      // 列表与详情都带界面态（前端刷新后不能把置顶丢了）。
      const listed = (await getJson(server.url, '/api/conversations')).body as { conversations: ConversationRow[] }
      const row = listed.conversations.find((entry) => {
        return entry.id === conversationId
      })
      expect(row?.pinned).toBe(true)
      expect(row?.muted).toBe(true)
      const detail = (await getJson(server.url, `/api/conversations/${conversationId}`)).body as {
        conversation: ConversationRow
      }
      expect(detail.conversation.title).toBe('重构小组')
    } finally {
      await server.close()
    }
  })

  it('界面态跨重启仍在（conversation-state.json 是事实源），删会话时一并清掉', async () => {
    const dataDir = tempDataDir('persist')
    const first = await startServer(dataDir)
    let conversationId = ''
    try {
      await seedMockAgents(first.url, 'coding', 'Coder')
      const created = await sendJson(first.url, '/api/conversations', 'POST', {
        kind: 'direct',
        agentId: 'ryen',
        title: '单聊',
      })
      conversationId = (created.body as { conversation: ConversationRow }).conversation.id
      await sendJson(first.url, `/api/conversations/${conversationId}`, 'PATCH', { pinned: true, title: '置顶的猫' })
      const statePath = join(dataDir, 'conversation-state.json')
      expect(existsSync(statePath)).toBe(true)
      expect(readFileSync(statePath, 'utf8')).toContain('置顶的猫')
    } finally {
      await first.close()
    }

    const second = await startServer(dataDir)
    try {
      const detail = (await getJson(second.url, `/api/conversations/${conversationId}`)).body as {
        conversation: ConversationRow
      }
      expect(detail.conversation.pinned).toBe(true)
      expect(detail.conversation.title).toBe('置顶的猫')
      // 未设的界面态恒为 false，而不是缺字段。
      expect(detail.conversation.muted).toBe(false)

      expect((await sendJson(second.url, `/api/conversations/${conversationId}`, 'DELETE')).status).toBe(200)
      expect(readFileSync(join(dataDir, 'conversation-state.json'), 'utf8')).not.toContain(conversationId)
    } finally {
      await second.close()
    }
  })

  it('换群成员：调度员必须留在名单里，非法输入 400 且不落盘', async () => {
    const server = await startServer(tempDataDir('members'))
    try {
      const coderId = await seedMockAgents(server.url, 'coding', 'Coder')
      const created = await sendJson(server.url, '/api/conversations', 'POST', {
        kind: 'group',
        memberAgentIds: ['ryen', coderId],
        title: '成员增减',
      })
      const conversationId = (created.body as { conversation: ConversationRow }).conversation.id

      // 把 Ryen（调度员）移出成员：会让群里每条消息都以 UNKNOWN_AGENT 报错，直接拒。
      const rejected = await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', {
        memberAgentIds: [coderId],
      })
      expect(rejected.status).toBe(400)
      expect(String((rejected.body as { error: string }).error)).toContain('ryen')
      const untouched = (await getJson(server.url, `/api/conversations/${conversationId}`)).body as {
        conversation: ConversationRow
      }
      expect(untouched.conversation.memberAgentIds).toEqual(['ryen', coderId])

      // 未知 agent / 空名单 / 非字符串都是 400。
      expect(
        (await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { memberAgentIds: [] })).status,
      ).toBe(400)
      expect(
        (await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { memberAgentIds: ['nope'] }))
          .status,
      ).toBe(400)
      expect(
        (await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { memberAgentIds: [1] })).status,
      ).toBe(400)

      // 合法换人（加上第三个 agent，调度员仍在名单里）。
      const helper = await sendJson(server.url, '/api/agents', 'POST', {
        templateKey: 'writing',
        name: '阿墨',
        provider: 'mock',
        model: 'mock',
      })
      const helperId = (helper.body as { agent: { id: string } }).agent.id
      const accepted = await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', {
        memberAgentIds: ['ryen', coderId, helperId],
      })
      expect(accepted.status).toBe(200)
      expect((accepted.body as { conversation: ConversationRow }).conversation.memberAgentIds).toEqual([
        'ryen',
        coderId,
        helperId,
      ])
    } finally {
      await server.close()
    }
  })

  it('单聊必须恰好留一个成员；字段类型不对 400；未知会话 404', async () => {
    const server = await startServer(tempDataDir('direct'))
    try {
      const coderId = await seedMockAgents(server.url, 'coding', 'Coder')
      const created = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: ConversationRow }).conversation.id

      expect(
        (
          await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', {
            memberAgentIds: ['ryen', coderId],
          })
        ).status,
      ).toBe(400)
      expect((await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { title: 7 })).status).toBe(
        400,
      )
      expect(
        (await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { pinned: 'yes' })).status,
      ).toBe(400)
      expect((await sendJson(server.url, '/api/conversations/no-such-id', 'PATCH', { pinned: true })).status).toBe(404)

      const swapped = await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', {
        memberAgentIds: [coderId],
      })
      expect(swapped.status).toBe(200)
      expect((swapped.body as { conversation: ConversationRow }).conversation.memberAgentIds).toEqual([coderId])
    } finally {
      await server.close()
    }
  })

  it('换过成员的单聊，下一条消息就按新 agent 派工', async () => {
    const server = await startServer(tempDataDir('rebinding'))
    try {
      const coderId = await seedMockAgents(server.url, 'coding', 'Coder')
      const created = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: ConversationRow }).conversation.id
      await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { memberAgentIds: [coderId] })

      expect(
        (await sendJson(server.url, `/api/conversations/${conversationId}/messages`, 'POST', { text: '在吗' })).status,
      ).toBe(202)
      await waitForMessages(server.url, conversationId, 2)
      const messages = (await getJson(server.url, `/api/conversations/${conversationId}/messages`)).body as {
        messages: { senderId?: string }[]
      }
      expect(
        messages.messages.some((row) => {
          return row.senderId === coderId
        }),
      ).toBe(true)
    } finally {
      await server.close()
    }
  })
})

describe('GET /api/search', () => {
  it('命中消息、带会话标题与片段；空 q 回空数组；可按会话过滤', async () => {
    const server = await startServer(tempDataDir('search'))
    try {
      await useMockRyen(server.url)
      const direct = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const directId = (direct.body as { conversation: ConversationRow }).conversation.id
      const group = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const groupId = (group.body as { conversation: ConversationRow }).conversation.id

      await sendJson(server.url, `/api/conversations/${directId}/messages`, 'POST', { text: '帮我找一下蓝色马克杯' })
      await waitForMessages(server.url, directId, 2)
      await sendJson(server.url, `/api/conversations/${groupId}/messages`, 'POST', { text: '今天天气不错' })
      await waitForMessages(server.url, groupId, 2)

      const hit = await getJson(server.url, `/api/search?q=${encodeURIComponent('马克杯')}`)
      expect(hit.status).toBe(200)
      const results = (hit.body as { results: { conversationId: string; snippet: string; agentId: string }[] }).results
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]?.conversationId).toBe(directId)
      expect(results[0]?.snippet).toContain('马克杯')
      // 命中的那条是用户自己发的（senderId=user），agentId 如实回发送者。
      expect(results[0]?.agentId).toBe('user')
      // agent 发言也能被搜到，agentId 落在 agent 上。
      const agentHit = (await getJson(server.url, `/api/search?q=${encodeURIComponent('记下了')}`)).body as {
        results: { agentId: string; createdAt: number }[]
      }
      expect(agentHit.results[0]?.agentId).toBe('ryen')

      // 大小写不敏感；无命中回空数组（不是 404）。
      expect(
        ((await getJson(server.url, `/api/search?q=${encodeURIComponent('MARKCUP')}`)).body as { results: unknown[] })
          .results,
      ).toEqual([])
      expect(((await getJson(server.url, '/api/search?q=')).body as { results: unknown[] }).results).toEqual([])
      expect(((await getJson(server.url, '/api/search')).body as { results: unknown[] }).results).toEqual([])

      // 限定会话：只回该会话里的命中。
      const scoped = (
        (await getJson(server.url, `/api/search?q=${encodeURIComponent('今天')}&conversationId=${groupId}`)).body as {
          results: { conversationId: string }[]
        }
      ).results
      expect(scoped).toHaveLength(1)
      expect(scoped[0]?.conversationId).toBe(groupId)

      // 片段以命中处为中心并带省略号，不回整条正文。
      const long = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const longId = (long.body as { conversation: ConversationRow }).conversation.id
      await sendJson(server.url, `/api/conversations/${longId}/messages`, 'POST', {
        text: `前面${'铺垫'.repeat(80)}关键词后面${'尾巴'.repeat(80)}`,
      })
      await waitForMessages(server.url, longId, 2)
      const snippet = (
        (await getJson(server.url, `/api/search?q=${encodeURIComponent('关键词')}&conversationId=${longId}`)).body as {
          results: { snippet: string }[]
        }
      ).results[0]?.snippet
      expect(snippet).toContain('关键词')
      expect(snippet?.startsWith('…')).toBe(true)
      expect(snippet?.endsWith('…')).toBe(true)
      expect(snippet?.length).toBeLessThan(200)
    } finally {
      await server.close()
    }
  })

  it('会话标题带界面态改名：搜到的标题是改过的那个', async () => {
    const server = await startServer(tempDataDir('search-title'))
    try {
      await useMockRyen(server.url)
      const created = await sendJson(server.url, '/api/conversations', 'POST', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: ConversationRow }).conversation.id
      await sendJson(server.url, `/api/conversations/${conversationId}`, 'PATCH', { title: '厨房话题' })
      await sendJson(server.url, `/api/conversations/${conversationId}/messages`, 'POST', { text: '买点番茄' })
      await waitForMessages(server.url, conversationId, 2)

      const results = (
        (await getJson(server.url, `/api/search?q=${encodeURIComponent('番茄')}`)).body as {
          results: { conversationTitle: string }[]
        }
      ).results
      expect(results[0]?.conversationTitle).toBe('厨房话题')
    } finally {
      await server.close()
    }
  })
})
