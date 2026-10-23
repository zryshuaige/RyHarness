/**
 * 供应商路由：内置助理跟着**用户自己挑的那家**走。
 *
 * 此前内置助理的 provider 是写死的 `siliconflow`——用户在设置里配好 DeepSeek 也没用，
 * 第一句话就报「没有凭据」。这里钉住三件事：
 * 1. 用户给别家配好 key 之后，内置助理跟着切过去（模型 id 也换成那家的）；
 * 2. 用户手动改过的那位助理不被覆盖；
 * 3. 新建助理（走模板）也用当前有凭据的那家，而不是模板里写死的那家。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-routing-${prefix}-`))
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

async function startServer(dataDir: string): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    proactive: false,
  })
}

async function postJson(
  server: RyHarnessServer,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function getJson(
  server: RyHarnessServer,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface AgentRow {
  id: string
  name: string
  provider: string
  model: string
  isBuiltin: boolean
}

describe('内置助理的供应商路由', () => {
  it('用户给别家配好 key 之后：内置助理跟着切过去，模型 id 也换', async () => {
    const server = await startServer(tempDir('retarget'))
    try {
      const before = server.store.listAgents()
      expect(before.length).toBeGreaterThan(0)
      // 起始状态：内置助理指着内置那家（此时它没有凭据）。
      expect(
        before.every((agent) => {
          return agent.provider === 'siliconflow'
        }),
      ).toBe(true)

      const created = await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
        presetId: 'deepseek',
      })
      expect(created.status).toBe(201)

      const after = server.store.listAgents()
      for (const agent of after) {
        expect(agent.provider).toBe('deepseek')
        expect(agent.model).toBe('deepseek-chat')
      }
    } finally {
      await server.close()
    }
  })

  it('已经能用的那家不动：用户有意把某位助理留在别家就别改', async () => {
    const server = await startServer(tempDir('keep'))
    try {
      // 先给内置那家配上凭据：此时内置助理是能用的。
      const keyed = await postJson(server, '/api/settings/api-key', {
        providerId: 'siliconflow',
        apiKey: 'sk-builtin-key',
      })
      expect(keyed.status).toBe(200)
      expect(
        server.store.listAgents().every((agent) => {
          return agent.provider === 'siliconflow'
        }),
      ).toBe(true)

      // 再给别家配上：内置助理已经在一家能用的上面了，不该被搬走。
      await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
      })
      expect(
        server.store.listAgents().every((agent) => {
          return agent.provider === 'siliconflow'
        }),
      ).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('新建助理（走模板）用当前有凭据的那家，而不是模板里写死的那家', async () => {
    const server = await startServer(tempDir('new-agent'))
    try {
      const added = await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
      })
      expect(added.status).toBe(201)
      const providerId = (added.body.provider as { id: string }).id
      const created = await postJson(server, '/api/agents', {
        templateKey: 'general',
        name: '新来的',
      })
      expect(created.status).toBe(201)
      const agent = created.body.agent as AgentRow
      expect(agent.provider).toBe(providerId)
      expect(agent.model).toBe('deepseek-chat')
    } finally {
      await server.close()
    }
  })

  it('供应商清单里能看到刚加的那家', async () => {
    const server = await startServer(tempDir('list'))
    try {
      await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
      })
      const listed = await getJson(server, '/api/providers')
      const providers = listed.body.providers as { id: string; displayName: string; apiKeyConfigured: boolean }[]
      expect(
        providers.some((provider) => {
          return provider.displayName === 'DeepSeek' && provider.apiKeyConfigured
        }),
      ).toBe(true)
    } finally {
      await server.close()
    }
  })
})
