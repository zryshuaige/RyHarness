/**
 * 记忆管理面（记忆面板底部的两个动作）：已归档列表 / 恢复 / 重建向量索引。
 *
 * 归档数据用真实巩固口径造（插入后回拨 updated_at + archiveDormant），而不是
 * 直接改 status，这样测的是端点与存储层在真实数据形状下的配合。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HashEmbeddings, MemoryService, NullEmbeddings } from '@ryagent/memory'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const DAY_MS = 86_400_000

interface MemoryItem {
  id: string
  agentId: string
  kind: string
  content: string
  updatedAt: number
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

/** 带指定 embedding 实现起一个服务，并返回可预置数据的 MemoryService。 */
async function startWithMemory(
  prefix: string,
  embeddings: HashEmbeddings | NullEmbeddings = new HashEmbeddings(),
): Promise<{ server: RyAgentServer; memory: MemoryService }> {
  const dataDir = mkdtempSync(join(tmpdir(), `ryagent-memory-${prefix}-`))
  tmpDirs.push(dataDir)
  const memory = new MemoryService({ dbPath: join(dataDir, 'ryagent.db'), embeddings })
  const server = await RyAgentServer.create({ port: 0, dataDir, memory })
  return { server, memory }
}

/** 造一条"长期零访问"的记忆并归档它（巩固任务的口径）。 */
function archiveDormant(memory: MemoryService, agentId: string, content: string, daysAgo: number): string {
  const row = memory.store.insert({ agentId, kind: 'fact', content })
  memory.store.backdate(row.id, Date.now() - daysAgo * DAY_MS)
  const archived = memory.store.archiveDormant(30 * DAY_MS)
  expect(archived).toBeGreaterThan(0)
  return row.id
}

describe('记忆归档分区', () => {
  it('GET /api/memory/archived 列出巩固归档的记忆（按 agent 过滤在调用方）', async () => {
    const { server, memory } = await startWithMemory('archived')
    try {
      const ryenArchived = archiveDormant(memory, 'ryen', '很久以前的旧约定', 90)
      archiveDormant(memory, 'other-agent', '别的 agent 的旧记忆', 90)
      memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '还在活跃的记忆' })

      const res = await getJson(server.url, '/api/memory/archived')
      expect(res.status).toBe(200)
      const items = res.body.items as MemoryItem[]
      expect(
        items
          .map((item) => {
            return item.content
          })
          .sort(),
      ).toEqual(['别的 agent 的旧记忆', '很久以前的旧约定'])
      // 面板按 agentId 自己过滤，这里给足它需要的字段。
      const ryenItem = items.find((item) => {
        return item.id === ryenArchived
      }) as MemoryItem
      expect(ryenItem.agentId).toBe('ryen')
      expect(ryenItem.kind).toBe('fact')
      expect(ryenItem.updatedAt).toBeGreaterThan(0)
      // 只回展示/恢复需要的字段：向量（Float32Array 序列化成 {"0":…}）不该外泄。
      expect(Object.keys(ryenItem).sort()).toEqual(
        ['accessCount', 'agentId', 'content', 'createdAt', 'id', 'kind', 'updatedAt'].sort(),
      )
    } finally {
      await server.close()
    }
  })

  it('POST /api/memory/restore 把归档记忆拉回活跃列表，并重新可被检索', async () => {
    const { server, memory } = await startWithMemory('restore')
    try {
      const id = archiveDormant(memory, 'ryen', '用户养了一只橘猫叫布丁', 90)
      const before = await getJson(server.url, '/api/agents/ryen/memories')
      expect((before.body as { agent: unknown[] }).agent).toHaveLength(0)

      const restored = await postJson(server.url, '/api/memory/restore', { id })
      expect(restored.status).toBe(200)
      expect(restored.body.restored).toBe(id)

      const after = (await getJson(server.url, '/api/agents/ryen/memories')).body as { agent: MemoryItem[] }
      expect(
        after.agent.map((item) => {
          return item.content
        }),
      ).toEqual(['用户养了一只橘猫叫布丁'])
      expect((await getJson(server.url, '/api/memory/archived')).body.items).toEqual([])
      // FTS 索引也跟着回来了：recall 能命中（软删/恢复都只动 memories 表是不够的）。
      expect(await memory.recall('ryen', '橘猫')).toContain('用户养了一只橘猫叫布丁')
    } finally {
      await server.close()
    }
  })

  it('restore 的边界：不存在的 id 404，没归档过 409，缺 id 400', async () => {
    const { server, memory } = await startWithMemory('restore-edges')
    try {
      const active = memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '还在活跃' })
      const softDeleted = memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '软删掉的' })
      memory.store.supersede(softDeleted.id, 'deleted')

      expect((await postJson(server.url, '/api/memory/restore', { id: 'no-such-id' })).status).toBe(404)
      expect((await postJson(server.url, '/api/memory/restore', { id: active.id })).status).toBe(409)
      expect((await postJson(server.url, '/api/memory/restore', { id: softDeleted.id })).status).toBe(409)
      expect((await postJson(server.url, '/api/memory/restore', {})).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('记忆系统关闭：归档列表回空，恢复/重建回 409（面板不该因此报错）', async () => {
    const server = await RyAgentServer.create({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), 'ryagent-memory-off-')),
      memory: null,
    })
    tmpDirs.push(server.dataDir)
    try {
      const archived = await getJson(server.url, '/api/memory/archived')
      expect(archived.status).toBe(200)
      expect(archived.body.items).toEqual([])
      expect((await postJson(server.url, '/api/memory/restore', { id: 'x' })).status).toBe(409)
      expect((await postJson(server.url, '/api/memory/reembed')).status).toBe(409)
    } finally {
      await server.close()
    }
  })
})

describe('重建向量索引', () => {
  it('POST /api/memory/reembed 为存量记忆回填向量，跑两次第二次不再重复劳动', async () => {
    const { server, memory } = await startWithMemory('reembed')
    try {
      memory.store.insert({ agentId: 'ryen', kind: 'fact', content: '用户住在北京' })
      memory.store.insert({ agentId: 'ryen', kind: 'preference', content: '用户偏好川菜' })
      const archived = archiveDormant(memory, 'ryen', '归档的也要能恢复即用', 90)
      expect(memory.store.embeddingModelStats()['hash:test'] ?? 0).toBe(0)

      const res = await postJson(server.url, '/api/memory/reembed')
      expect(res.status).toBe(200)
      expect(res.body.reembedded).toBe(3)
      // 向量带模型溯源，检索按模型过滤才认它们。
      expect(memory.store.embeddingModelStats()['hash:test']).toBe(3)
      expect(memory.store.get(archived)?.embeddingModel).toBe('hash:test')
      expect(await memory.recall('ryen', '北京')).toContain('用户住在北京')

      // 幂等：当前模型下已有向量就不再重算。
      const again = await postJson(server.url, '/api/memory/reembed')
      expect(again.body.reembedded).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('没有 embedding 凭据（纯 FTS5）时回 409，而不是假装重建成功', async () => {
    const { server } = await startWithMemory('reembed-fts-only', new NullEmbeddings())
    try {
      const res = await postJson(server.url, '/api/memory/reembed')
      expect(res.status).toBe(409)
      expect(String(res.body.error)).toContain('embeddings are not configured')
    } finally {
      await server.close()
    }
  })
})
