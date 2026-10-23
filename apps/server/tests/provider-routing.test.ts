/**
 * 供应商路由：内置助理跟着**用户自己挑的那家**走。
 *
 * 此前内置助理的 provider 是写死的 `siliconflow`——用户在设置里配好 DeepSeek 也没用，
 * 第一句话就报「没有凭据」。这里钉住四件事：
 * 1. 用户给别家配好 key 之后，内置助理跟着切过去（模型 id 也换成那家的）；
 * 2. 用户手动改过的那位助理不被覆盖；
 * 3. 新建助理（走模板）也用当前有凭据的那家，而不是模板里写死的那家；
 * 4. 自动搬过一次之后还能再搬（删掉那家的 key 再配别家，内置助理不能卡死在没凭据的
 *    那家上——这是被真实用户操作触发过的卡死，不是理论问题）。
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

async function patchJson(
  server: RyHarnessServer,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function deleteJson(server: RyHarnessServer, path: string): Promise<number> {
  const response = await fetch(`${server.url}${path}`, { method: 'DELETE' })
  return response.status
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

  it('用户手动挑过路由的助理不动：切走等于把用户的选择抹掉', async () => {
    const server = await startServer(tempDir('manual'))
    try {
      // 用户把一位内置助理手动改到了本地 Ollama（还没起服务、暂时不可用）。
      // 「我就是要用这家，只是还没配好」是一个合法的中间状态，不能被替他改掉。
      // 走真实的编辑接口：这个「手动挑过」得由接口自己记下来，不能靠调用方自觉。
      const target = server.store.listAgents()[0]
      if (target === undefined) throw new Error('没有内置助理')
      const patched = await patchJson(server, `/api/agents/${target.id}`, {
        provider: 'ollama',
        model: 'qwen2.5:7b',
      })
      expect(patched.status).toBe(200)

      await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
        presetId: 'deepseek',
      })

      const manual = server.store.getAgent(target.id)
      expect(manual?.provider).toBe('ollama')
      expect(manual?.model).toBe('qwen2.5:7b')
      // 其他没被手动改过的内置助理照旧跟着走。
      const others = server.store.listAgents().filter((agent) => {
        return agent.id !== target.id
      })
      for (const agent of others) {
        expect(agent.provider).toBe('deepseek')
      }
    } finally {
      await server.close()
    }
  })

  it('只改名字不算挑过路由：改完名字的助理仍然跟着用户新配的那家走', async () => {
    const server = await startServer(tempDir('rename'))
    try {
      const target = server.store.listAgents()[0]
      if (target === undefined) throw new Error('没有内置助理')
      // 助理编辑表单会把整张表单原样 PATCH 回来，改个名字也带着 provider。
      // 那一次并没有「挑路由」的意思，锁上就会让这位内置助理再也不跟着走。
      const renamed = await patchJson(server, `/api/agents/${target.id}`, {
        name: 'Ryen 猫',
        provider: target.provider,
        model: target.model,
      })
      expect(renamed.status).toBe(200)

      await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
        presetId: 'deepseek',
      })

      expect(server.store.getAgent(target.id)?.provider).toBe('deepseek')
    } finally {
      await server.close()
    }
  })

  it('自动搬过一次之后还能再搬：删掉那家的 key 再配别家，不能卡死在没凭据的那家上', async () => {
    const server = await startServer(tempDir('remap'))
    try {
      // 第一步：配 DeepSeek，内置助理跟过去。
      const first = await postJson(server, '/api/providers', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-chat'],
        apiKey: 'sk-test-key',
        presetId: 'deepseek',
      })
      expect(first.status).toBe(201)
      expect(
        server.store.listAgents().every((agent) => {
          return agent.provider === 'deepseek'
        }),
      ).toBe(true)

      // 第二步：用户把 DeepSeek 的 key 删了（换家、key 过期、填错了改主意）。
      expect(await deleteJson(server, '/api/settings/api-key/deepseek')).toBe(200)

      // 第三步：配了月之暗面。此时内置助理指着的 DeepSeek 已经没有凭据，
      // 必须跟着换过去——早先的判据（provider 是否还等于种子默认值）在第一步之后
      // 就失效了，于是它们会永远卡在「没有凭据」上。
      const second = await postJson(server, '/api/providers', {
        displayName: 'Moonshot',
        protocol: 'openai',
        baseUrl: 'https://api.moonshot.cn/v1',
        models: ['kimi-k2.6'],
        apiKey: 'sk-second-key',
        presetId: 'moonshot',
      })
      expect(second.status).toBe(201)
      for (const agent of server.store.listAgents()) {
        expect(agent.provider).toBe('moonshot')
        expect(agent.model).toBe('kimi-k2.6')
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
