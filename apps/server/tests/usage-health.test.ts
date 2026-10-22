/**
 * 两个聚合端点：GET /api/memory/health（记忆库整体健康度）与
 * GET /api/usage（按会话 / 按供应商两维的 token 账单）。
 *
 * 用量数据直接走 store.appendMessage 造真实的 usage 行——账单的两个维度必须来自
 * 同一批消息，这里刻意造出"同会话多 agent""agent 已删""totalTokens 缺失"几种形状，
 * 它们正是界面上两栏对不上账时最常见的来源。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { HashEmbeddings, MemoryService, NullEmbeddings } from '@ryharness/memory'
import type { ProvidersConfigFile } from '@ryharness/server'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const DAY_MS = 86_400_000

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-usage-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区，不强求。
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
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function patchJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface MemoryHealthBody {
  enabled?: boolean
  total?: number
  archived?: number
  missingVectors?: number
  bySpace?: Record<string, number>
  dbBytes?: number
  embeddings?: { label?: string; model?: string; dim?: number }
  lastRecall?: { conversationId?: string; items?: number; ms?: number; at?: number }
}

interface UsageBody {
  byConversation: {
    conversationId: string
    title: string
    kind: string
    input: number
    output: number
    total: number
    messages: number
  }[]
  byProvider: {
    provider: string
    displayName: string
    input: number
    output: number
    total: number
    agents: { agentId: string; name: string; total: number }[]
  }[]
  totals: { input: number; output: number; total: number }
}

/** 固定回复的适配器（记忆健康度的召回用例要真跑一轮对话）。 */
class SimpleAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Simple' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '布丁。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '布丁。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** 带指定 embedding 实现起一个记忆打开的服务，并交出预置数据用的 MemoryService。 */
async function startWithMemory(
  prefix: string,
  embeddings: HashEmbeddings | NullEmbeddings = new HashEmbeddings(16),
): Promise<{ server: RyHarnessServer; memory: MemoryService }> {
  const dataDir = tempDataDir(prefix)
  const memory = new MemoryService({ dbPath: join(dataDir, 'ryharness.db'), embeddings })
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory,
    evolution: null,
    consolidationIntervalMs: 0,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new SimpleAdapter())
    },
  })
  return { server, memory }
}

/** 造一条"长期零访问"的记忆并归档它（巩固任务的口径）。 */
function archiveDormant(memory: MemoryService, agentId: string, content: string, daysAgo: number): string {
  const row = memory.store.insert({ agentId, kind: 'fact', content })
  memory.store.backdate(row.id, Date.now() - daysAgo * DAY_MS)
  memory.store.archiveDormant(30 * DAY_MS)
  return row.id
}

describe('GET /api/memory/health', () => {
  it('一次给全总数 / 归档 / 缺向量 / 各空间 / 体积 / embedding 状态', async () => {
    const { server, memory } = await startWithMemory('health')
    try {
      memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户养了一只橘猫叫布丁' })
      memory.store.insert({ agentId: 'ryen', kind: 'preference', content: '用户偏好川菜' })
      archiveDormant(memory, 'ryen', '很久以前的旧约定', 90)
      memory.store.insert({ agentId: 'writer', kind: 'fact', content: '周报已经写完' })

      const res = await getJson(server.url, '/api/memory/health')
      expect(res.status).toBe(200)
      const health = res.body as MemoryHealthBody
      expect(health.enabled).toBe(true)
      // 总数含归档（口径同 /api/memory/stats），归档单独一格。
      expect(health.total).toBe(4)
      expect(health.archived).toBe(1)
      // 还没重建向量：四条记忆（含归档）全都缺当前模型的向量。
      expect(health.missingVectors).toBe(4)
      expect(health.bySpace?.ryen).toBe(3)
      expect(health.bySpace?.writer).toBe(1)
      expect(health.dbBytes).toBeGreaterThan(0)
      expect(health.embeddings?.label).toBe('configured')
      expect(health.embeddings?.model).toBe('hash:test')
      // 一条向量都没有时不猜维度。
      expect(health.embeddings?.dim).toBeUndefined()
      expect(health.lastRecall).toBeUndefined()

      // 重建向量后：缺向量清零，维度按实际向量给出。
      expect((await postJson(server.url, '/api/memory/reembed')).body.reembedded).toBe(4)
      const after = (await getJson(server.url, '/api/memory/health')).body as MemoryHealthBody
      expect(after.missingVectors).toBe(0)
      expect(after.embeddings?.dim).toBe(16)
      expect(after.total).toBe(4)
      expect(after.archived).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('纯 FTS5 安装（没有 embedding）：标成 none:fts-only，缺向量等于总数', async () => {
    const { server, memory } = await startWithMemory('health-fts-only', new NullEmbeddings())
    try {
      memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户住在北京' })
      const health = (await getJson(server.url, '/api/memory/health')).body as MemoryHealthBody
      expect(health.embeddings?.label).toBe('none:fts-only')
      expect(health.embeddings?.model).toBe('none')
      expect(health.embeddings?.dim).toBeUndefined()
      // 没有 embedding 就永远重建不出向量：这两格必须等量，不能只报缺的那部分。
      expect(health.missingVectors).toBe(health.total)
    } finally {
      await server.close()
    }
  })

  it('记忆系统关闭：回 200 {enabled:false}（面板每次打开都拉，不该报错）', async () => {
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: tempDataDir('health-off'),
      memory: null,
      evolution: null,
      consolidationIntervalMs: 0,
    })
    try {
      const res = await getJson(server.url, '/api/memory/health')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ enabled: false })
    } finally {
      await server.close()
    }
  })

  it('最近一次召回：跑完一轮真实对话后能指名会话、条数与耗时', async () => {
    const { server, memory } = await startWithMemory('health-recall')
    try {
      memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户养了一只橘猫叫布丁' })
      await patchJson(server.url, '/api/agents/ryen', { provider: 'mock', model: 'mock' })
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id
      expect(
        (await postJson(server.url, `/api/conversations/${conversationId}/messages`, { text: '我的猫叫什么' })).status,
      ).toBe(202)

      let health: MemoryHealthBody = {}
      for (let attempt = 0; attempt < 100; attempt++) {
        health = (await getJson(server.url, '/api/memory/health')).body as MemoryHealthBody
        if (health.lastRecall !== undefined) break
        await sleep(50)
      }
      expect(health.lastRecall?.conversationId).toBe(conversationId)
      expect(health.lastRecall?.items).toBeGreaterThanOrEqual(1)
      expect(health.lastRecall?.ms).toBeGreaterThanOrEqual(0)
      expect(health.lastRecall?.at).toBeGreaterThan(0)
      // 召回那一轮照样把记忆库本身的数据带全（两格不是二选一）。
      expect(health.total).toBeGreaterThanOrEqual(1)
    } finally {
      await server.close()
    }
  })

  it('未知查询参数回 400（健康度没有可调项，敲错的键不该被默默忽略）', async () => {
    const { server } = await startWithMemory('health-params')
    try {
      const res = await getJson(server.url, '/api/memory/health?limit=10')
      expect(res.status).toBe(400)
      expect(String(res.body.error)).toContain('unknown query parameter')
    } finally {
      await server.close()
    }
  })
})

const USAGE_PROVIDERS: ProvidersConfigFile = {
  providers: {
    deepseek: {
      baseURL: 'https://api.deepseek.com/v1',
      displayName: 'DeepSeek',
      models: [{ id: 'deepseek-chat' }],
      custom: true,
      apiKey: 'test-key',
    },
    openai: {
      baseURL: 'https://api.openai.com/v1',
      displayName: 'OpenAI',
      models: [{ id: 'gpt-4o-mini' }],
      custom: true,
      apiKey: 'test-key',
    },
  },
}

async function startUsageServer(prefix: string): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: tempDataDir(prefix),
    providersConfig: USAGE_PROVIDERS,
    memory: null,
    evolution: null,
    consolidationIntervalMs: 0,
  })
}

/** 造一个 agent（显式指定供应商，才能验出按供应商归因）。 */
async function createAgent(base: string, id: string, name: string, provider: string): Promise<void> {
  const res = await postJson(base, '/api/agents', { id, name, provider, model: 'test-model', systemPrompt: '…' })
  expect(res.status).toBe(201)
}

/** 往会话里塞一条带用量（或不带用量）的 agent 消息。 */
async function appendUsage(
  server: RyHarnessServer,
  conversationId: string,
  senderId: string,
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number },
): Promise<void> {
  server.store.appendMessage({
    conversationId,
    senderType: 'agent',
    senderId,
    contentBlocks: [{ type: 'text', text: `来自 ${senderId} 的回复` }],
    ...(usage === undefined ? {} : { usage }),
  })
}

async function usage(base: string, query = ''): Promise<UsageBody> {
  const res = await getJson(base, `/api/usage${query}`)
  expect(res.status).toBe(200)
  return res.body as unknown as UsageBody
}

describe('GET /api/usage', () => {
  it('两个维度从同一批消息聚合：按会话合计 == 按供应商合计 == totals', async () => {
    const server = await startUsageServer('aggregate')
    try {
      await createAgent(server.url, 'writer', '写手', 'deepseek')
      await createAgent(server.url, 'coder', '程序员', 'openai')
      const solo = (await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'writer' })).body as {
        conversation: { id: string }
      }
      const room = (
        await postJson(server.url, '/api/conversations', {
          kind: 'group',
          memberAgentIds: ['writer', 'coder'],
          dispatcherAgentId: 'writer',
          title: '日报群',
        })
      ).body as { conversation: { id: string } }

      await appendUsage(server, solo.conversation.id, 'writer', {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      })
      await appendUsage(server, solo.conversation.id, 'writer', {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
      })
      await appendUsage(server, room.conversation.id, 'writer', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
      // 缺 totalTokens 的形状：按 input+output 兜底，不能当成 0。
      await appendUsage(server, room.conversation.id, 'coder', { inputTokens: 20, outputTokens: 10 })
      // 不带用量的消息不进账单。
      await appendUsage(server, room.conversation.id, 'coder')

      const report = await usage(server.url)
      expect(
        report.byConversation.map((row) => {
          return [row.kind, row.title, row.total, row.messages]
        }),
      ).toEqual([
        ['direct', '写手', 450, 2],
        ['group', '日报群', 45, 2],
      ])
      expect(report.byConversation[0]?.conversationId).toBe(solo.conversation.id)

      // 写手在两个会话里都发过言：供应商这一维并成一行（450 + 15）。
      expect(
        report.byProvider.map((row) => {
          return [row.provider, row.displayName, row.total]
        }),
      ).toEqual([
        ['deepseek', 'DeepSeek', 465],
        ['openai', 'OpenAI', 30],
      ])
      expect(report.byProvider[0]?.agents).toEqual([{ agentId: 'writer', name: '写手', total: 465 }])
      expect(report.byProvider[1]?.agents).toEqual([{ agentId: 'coder', name: '程序员', total: 30 }])

      expect(report.totals).toEqual({ input: 330, output: 165, total: 495 })
      const conversationSum = report.byConversation.reduce((acc, row) => acc + row.total, 0)
      const providerSum = report.byProvider.reduce((acc, row) => acc + row.total, 0)
      const agentSum = report.byProvider.reduce((acc, row) => acc + row.agents.reduce((a, b) => a + b.total, 0), 0)
      expect(conversationSum).toBe(report.totals.total)
      expect(providerSum).toBe(report.totals.total)
      expect(agentSum).toBe(report.totals.total)
    } finally {
      await server.close()
    }
  })

  it('同一个 agent 在多个会话里发言：按供应商并成一行，按会话仍分开', async () => {
    const server = await startUsageServer('multi-conversation')
    try {
      await createAgent(server.url, 'writer', '写手', 'deepseek')
      const first = (await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'writer' })).body as {
        conversation: { id: string }
      }
      const second = (await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'writer' })).body as {
        conversation: { id: string }
      }
      await appendUsage(server, first.conversation.id, 'writer', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
      await appendUsage(server, second.conversation.id, 'writer', {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      })

      const report = await usage(server.url)
      expect(report.byConversation).toHaveLength(2)
      expect(report.byProvider).toHaveLength(1)
      expect(report.byProvider[0]?.total).toBe(45)
      expect(report.byProvider[0]?.agents).toEqual([{ agentId: 'writer', name: '写手', total: 45 }])
    } finally {
      await server.close()
    }
  })

  it('发言 agent 已被删除：用量归到未知供应商，不许悄悄从账单里消失', async () => {
    const server = await startUsageServer('deleted-agent')
    try {
      await createAgent(server.url, 'ghost', '临时工', 'openai')
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ghost' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id
      await appendUsage(server, conversationId, 'ghost', { inputTokens: 50, outputTokens: 25, totalTokens: 75 })
      expect((await fetch(`${server.url}/api/agents/ghost`, { method: 'DELETE' })).status).toBe(200)

      const report = await usage(server.url)
      expect(report.byProvider).toEqual([
        {
          provider: 'unknown',
          displayName: '未知供应商',
          input: 50,
          output: 25,
          total: 75,
          agents: [{ agentId: 'ghost', name: 'ghost', total: 75 }],
        },
      ])
      // 两维仍然对得上：agent 没了，账还在。
      expect(report.totals.total).toBe(75)
      expect(report.byConversation[0]?.total).toBe(75)
    } finally {
      await server.close()
    }
  })

  it('?since= 只统计该时刻之后的轮次；空参数 = 不限', async () => {
    const server = await startUsageServer('since')
    try {
      await createAgent(server.url, 'writer', '写手', 'deepseek')
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'writer' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id
      await appendUsage(server, conversationId, 'writer', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
      const cut = Date.now() + 1
      await sleep(10)
      await appendUsage(server, conversationId, 'writer', { inputTokens: 20, outputTokens: 10, totalTokens: 30 })

      const all = await usage(server.url)
      expect(all.totals).toEqual({ input: 30, output: 15, total: 45 })

      const incremental = await usage(server.url, `?since=${cut}`)
      expect(incremental.totals).toEqual({ input: 20, output: 10, total: 30 })
      expect(incremental.byConversation).toHaveLength(1)
      expect(incremental.byProvider[0]?.agents).toEqual([{ agentId: 'writer', name: '写手', total: 30 }])

      // 空串当作没给（而不是 0，也不是报错）。
      const empty = await usage(server.url, '?since=')
      expect(empty.totals.total).toBe(45)
      // 窗口在所有消息之后：空账本，而不是回 0 值的满屏行。
      const future = await usage(server.url, `?since=${Date.now() + 60_000}`)
      expect(future).toEqual({ byConversation: [], byProvider: [], totals: { input: 0, output: 0, total: 0 } })
    } finally {
      await server.close()
    }
  })

  it('校验口径：非法 since 与未知参数回 400', async () => {
    const server = await startUsageServer('validation')
    try {
      for (const query of ['?since=abc', '?since=-1', '?since=Infinity', '?limit=10', '?since=1&foo=2']) {
        const res = await getJson(server.url, `/api/usage${query}`)
        expect(res.status, query).toBe(400)
        expect(typeof res.body.error).toBe('string')
      }
    } finally {
      await server.close()
    }
  })

  it('空账本：两个维度都是空数组，totals 全 0', async () => {
    const server = await startUsageServer('empty')
    try {
      expect(await usage(server.url)).toEqual({
        byConversation: [],
        byProvider: [],
        totals: { input: 0, output: 0, total: 0 },
      })
    } finally {
      await server.close()
    }
  })

  it('会话改过名：账单里的标题跟着界面态走（界面写新名、账单写旧名会没法对账）', async () => {
    const server = await startUsageServer('renamed')
    try {
      await createAgent(server.url, 'writer', '写手', 'deepseek')
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'writer' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id
      await appendUsage(server, conversationId, 'writer', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
      expect((await patchJson(server.url, `/api/conversations/${conversationId}`, { title: '周报专线' })).status).toBe(
        200,
      )

      const report = await usage(server.url)
      expect(report.byConversation[0]?.title).toBe('周报专线')
    } finally {
      await server.close()
    }
  })
})
