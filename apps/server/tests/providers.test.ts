/**
 * 供应商设置面：预设目录、新增/删除自定义供应商、热注册适配器、凭据落盘权限。
 *
 * 全部走真实 HTTP + 真实文件读写（临时目录），不触网：只到"路由与凭据就位"
 * 为止，不真的向任何供应商发请求。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryagent-providers-${prefix}-`))
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

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function sendJson(
  base: string,
  path: string,
  method: 'POST' | 'DELETE',
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

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** POSIX 下断言配置文件权限；Windows 的 mode 语义有限，跳过。 */
function expectPrivateFile(path: string): void {
  if (process.platform === 'win32') return
  expect(statSync(path).mode & 0o777).toBe(0o600)
}

interface ProviderRow {
  id: string
  displayName: string
  protocol: string
  baseUrl: string
  custom: boolean
  apiKeyConfigured: boolean
  models: { id: string }[]
}

async function listProviders(base: string): Promise<ProviderRow[]> {
  const res = await getJson(base, '/api/providers')
  return res.body.providers as ProviderRow[]
}

describe('供应商预设', () => {
  it('GET /api/provider-presets 返回常用服务商，字段齐全', async () => {
    const server = await RyAgentServer.create({ port: 0, dataDir: tempDataDir('presets') })
    try {
      const res = await getJson(server.url, '/api/provider-presets')
      expect(res.status).toBe(200)
      const presets = res.body.presets as {
        id: string
        displayName: string
        protocol: string
        baseUrl: string
        models: string[]
        docsUrl?: string
      }[]
      expect(
        presets.map((preset) => {
          return preset.id
        }),
      ).toEqual(
        expect.arrayContaining([
          'siliconflow',
          'deepseek',
          'moonshot',
          'zhipu',
          'minimax',
          'openrouter',
          'openai',
          'ollama',
        ]),
      )
      for (const preset of presets) {
        expect(preset.displayName.length).toBeGreaterThan(0)
        expect(preset.protocol.length).toBeGreaterThan(0)
        expect(() => {
          return new URL(preset.baseUrl)
        }).not.toThrow()
        expect(preset.models.length).toBeGreaterThan(0)
        expect(preset.docsUrl ?? '').toMatch(/^https:\/\//)
      }
      expect(presets.find((preset) => preset.id === 'ollama')?.protocol).toBe('ollama')
    } finally {
      await server.close()
    }
  })
})

describe('新增供应商', () => {
  it('POST /api/providers：路由落 providers.json、key 落 api-keys.json（0600）、适配器热注册', async () => {
    const dataDir = tempDataDir('create')
    const server = await RyAgentServer.create({ port: 0, dataDir })
    try {
      // 启动时只有内置 SiliconFlow 一条路由。
      expect(
        server.llm.listProviders().map((provider) => {
          return provider.id
        }),
      ).toEqual(['siliconflow'])

      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        apiKey: 'sk-test-key',
        presetId: 'deepseek',
      })
      expect(created.status).toBe(201)
      const provider = (created.body as { provider: ProviderRow }).provider
      expect(provider.id).toBe('deepseek') // 预设 id 未被占用时直接沿用（图标/文档链接对得上品牌）
      expect(provider.custom).toBe(true)
      expect(provider.protocol).toBe('openai')
      expect(provider.baseUrl).toBe('https://api.deepseek.com/v1')
      expect(provider.apiKeyConfigured).toBe(true)
      expect(
        provider.models.map((model) => {
          return model.id
        }),
      ).toEqual(['deepseek-chat', 'deepseek-reasoner'])

      // 落盘：路由进 providers.json 且不含明文 key；key 单独进 0600 的文件。
      const configPath = join(dataDir, 'config', 'providers.json')
      const config = readJsonFile(configPath)
      const stored = (config.providers as Record<string, Record<string, unknown>>).deepseek as Record<string, unknown>
      expect(stored.baseURL).toBe('https://api.deepseek.com/v1')
      expect(stored.custom).toBe(true)
      expect(stored.apiKey).toBeUndefined()
      expect(readFileSync(configPath, 'utf8')).not.toContain('sk-test-key')
      const keysPath = join(dataDir, 'config', 'api-keys.json')
      expect(readJsonFile(keysPath)).toEqual({ deepseek: 'sk-test-key' })
      expectPrivateFile(keysPath)
      expectPrivateFile(configPath)

      // 热注册：不重启就能被 LLM 运行时按新模型目录解析到。
      expect(
        server.llm.listProviders().map((entry) => {
          return entry.id
        }),
      ).toEqual(expect.arrayContaining(['siliconflow', 'deepseek']))
      const models = await server.llm.listModels('deepseek')
      expect(
        models.map((model) => {
          return model.id
        }),
      ).toEqual(['deepseek-chat', 'deepseek-reasoner'])

      // GET /api/providers 能看到它，且凭据只回"配没配"。
      const listed = await listProviders(server.url)
      const deepseek = listed.find((row) => {
        return row.id === 'deepseek'
      })
      expect(deepseek?.apiKeyConfigured).toBe(true)
      expect(JSON.stringify(listed)).not.toContain('sk-test-key')
    } finally {
      await server.close()
    }
  })

  it('Ollama 允许空 key：建成免 key 供应商，且不影响适配器构造', async () => {
    const dataDir = tempDataDir('ollama')
    const server = await RyAgentServer.create({ port: 0, dataDir })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '本地 Ollama',
        protocol: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['qwen2.5:7b'],
      })
      expect(created.status).toBe(201)
      const provider = (created.body as { provider: ProviderRow }).provider
      expect(provider.protocol).toBe('ollama')
      // 免 key：UI 按协议判定"已配置"，这里如实回 false（没有任何凭据）。
      expect(provider.apiKeyConfigured).toBe(false)
      // 没有 key 就不该凭空造一个 key 文件；路由本身也不带任何凭据字段。
      expect(existsSync(join(dataDir, 'config', 'api-keys.json'))).toBe(false)
      const stored = (
        readJsonFile(join(dataDir, 'config', 'providers.json')).providers as Record<string, Record<string, unknown>>
      )[provider.id] as Record<string, unknown>
      expect(stored.apiKey).toBeUndefined()
      expect(stored.apiKeyEnv).toBeUndefined()
      // 适配器构造要求每条路由都有凭据来源：免 key 协议由配置层补占位，路由照常可用。
      expect(await server.llm.listModels(provider.id)).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('白名单校验：非法 protocol / baseUrl / 空模型 / 未知预设一律 400', async () => {
    const server = await RyAgentServer.create({ port: 0, dataDir: tempDataDir('invalid') })
    try {
      const bad = async (payload: unknown): Promise<number> => {
        return (await sendJson(server.url, '/api/providers', 'POST', payload)).status
      }
      expect(await bad({ protocol: 'openai', baseUrl: 'https://x.dev/v1', models: ['m'] })).toBe(400) // 缺 displayName
      expect(await bad({ displayName: 'X', protocol: 'anthropic', baseUrl: 'https://x.dev/v1', models: ['m'] })).toBe(
        400,
      )
      expect(await bad({ displayName: 'X', protocol: 'openai', baseUrl: 'not-a-url', models: ['m'] })).toBe(400)
      expect(await bad({ displayName: 'X', protocol: 'openai', baseUrl: 'https://x.dev/v1', models: [] })).toBe(400)
      expect(await bad({ displayName: 'X', protocol: 'openai', baseUrl: 'https://x.dev/v1', models: ['ok', 7] })).toBe(
        400,
      )
      expect(
        await bad({
          displayName: 'X',
          protocol: 'openai',
          baseUrl: 'https://x.dev/v1',
          models: ['m'],
          presetId: 'no-such-preset',
        }),
      ).toBe(400)
      // 一个都没建成功。
      expect(
        (await listProviders(server.url)).map((row) => {
          return row.id
        }),
      ).toEqual(['siliconflow'])
    } finally {
      await server.close()
    }
  })

  it('同一个预设加第二次：换个 id 存下，不覆盖已有路由', async () => {
    const server = await RyAgentServer.create({ port: 0, dataDir: tempDataDir('dup') })
    try {
      const first = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: 'DeepSeek 官方',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        presetId: 'deepseek',
      })
      const second = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '我的 DeepSeek 网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['deepseek-chat'],
      })
      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      const ids = (await listProviders(server.url)).map((row) => {
        return row.id
      })
      expect(ids).toContain('deepseek')
      expect(
        ids.some((id) => {
          return id.startsWith('custom-')
        }),
      ).toBe(true)
      expect(ids).toHaveLength(3)
    } finally {
      await server.close()
    }
  })

  it('落盘时剥掉合并进来的明文 key：改过 key 后再增删供应商也不会把它抄进 providers.json', async () => {
    const dataDir = tempDataDir('no-leak')
    const server = await RyAgentServer.create({ port: 0, dataDir })
    try {
      await sendJson(server.url, '/api/settings/api-key', 'POST', {
        providerId: 'siliconflow',
        apiKey: 'sk-silicon-secret',
      })
      // 此时内存配置里的 siliconflow 已经并入明文 key。
      await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['m'],
      })
      const configPath = join(dataDir, 'config', 'providers.json')
      expect(readFileSync(configPath, 'utf8')).not.toContain('sk-silicon-secret')
      const stored = readJsonFile(configPath).providers as Record<string, Record<string, unknown>>
      expect(stored.siliconflow?.apiKey).toBeUndefined()
      expect(stored.siliconflow?.apiKeyEnv).toBe('SILICONFLOW_API_KEY')

      const ids = (await listProviders(server.url)).map((row) => {
        return row.id
      })
      const customId = ids.find((id) => {
        return id.startsWith('custom-')
      }) as string
      await sendJson(server.url, `/api/providers/${customId}`, 'DELETE')
      expect(readFileSync(configPath, 'utf8')).not.toContain('sk-silicon-secret')
      // 内置条目在内存里仍是"已配置"（key 从 api-keys.json 并进来的）。
      expect(
        (await listProviders(server.url)).find((row) => {
          return row.id === 'siliconflow'
        })?.apiKeyConfigured,
      ).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('手改过的 providers.json（残留空 apiKey）也能起来：适配器要求恰好一个凭据来源', async () => {
    const dataDir = tempDataDir('hand-edited')
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    writeFileSync(
      join(dataDir, 'config', 'providers.json'),
      JSON.stringify({
        providers: {
          broken: {
            baseURL: 'http://127.0.0.1:9100/v1',
            apiKey: '', // 半路而废的一次粘贴
            displayName: '半成品',
            models: [{ id: 'm1' }],
          },
          local: {
            baseURL: 'http://127.0.0.1:11434/v1',
            apiKeyEnv: 'OLLAMA_UNUSED', // 免 key 却残留了环境变量引用
            protocol: 'ollama',
            displayName: '本地',
            models: [{ id: 'qwen2.5:7b' }],
          },
        },
      }),
      'utf8',
    )
    const server = await RyAgentServer.create({ port: 0, dataDir })
    try {
      expect(await server.llm.listModels('broken')).toHaveLength(1)
      expect(await server.llm.listModels('local')).toHaveLength(1)
      // 空 key 不算"已配置"：UI 该提示去填，而不是显示一个转不起来的绿点。
      expect(
        (await listProviders(server.url)).find((row) => {
          return row.id === 'broken'
        })?.apiKeyConfigured,
      ).toBe(false)
    } finally {
      await server.close()
    }
  })
})

describe('删除供应商', () => {
  it('DELETE /api/providers/:id 摘掉路由与 key，内置条目 409，未知 404', async () => {
    const dataDir = tempDataDir('delete')
    const server = await RyAgentServer.create({ port: 0, dataDir })
    try {
      await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['my-model'],
        apiKey: 'sk-private',
      })
      const ids = (await listProviders(server.url)).map((row) => {
        return row.id
      })
      const customId = ids.find((id) => {
        return id.startsWith('custom-')
      }) as string
      expect(customId).toBeDefined()

      // 内置条目删不动。
      const builtin = await sendJson(server.url, '/api/providers/siliconflow', 'DELETE')
      expect(builtin.status).toBe(409)
      const missing = await sendJson(server.url, '/api/providers/nope', 'DELETE')
      expect(missing.status).toBe(404)

      const deleted = await sendJson(server.url, `/api/providers/${customId}`, 'DELETE')
      expect(deleted.status).toBe(200)
      expect(deleted.body.deleted).toBe(customId)
      expect(
        (await listProviders(server.url)).map((row) => {
          return row.id
        }),
      ).toEqual(['siliconflow'])
      // 路由热摘：LLM 运行时里也不再有这条。
      expect(
        server.llm.listProviders().map((entry) => {
          return entry.id
        }),
      ).toEqual(['siliconflow'])
      // 路由与 key 一起落盘清掉，不留孤儿。
      const config = readJsonFile(join(dataDir, 'config', 'providers.json'))
      expect((config.providers as Record<string, unknown>)[customId]).toBeUndefined()
      expect(readJsonFile(join(dataDir, 'config', 'api-keys.json'))).toEqual({})
    } finally {
      await server.close()
    }
  })
})

describe('内置供应商视图', () => {
  it('GET /api/providers 的 ProviderInfo 带 custom / protocol / baseUrl，内置条目 custom=false', async () => {
    const server = await RyAgentServer.create({ port: 0, dataDir: tempDataDir('builtin') })
    try {
      const builtin = (await listProviders(server.url)).find((row) => {
        return row.id === 'siliconflow'
      })
      expect(builtin).toEqual({
        id: 'siliconflow',
        displayName: 'SiliconFlow',
        protocol: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1',
        custom: false,
        apiKeyConfigured: false, // 未设 SILICONFLOW_API_KEY
        models: [
          { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', contextWindow: 64_000 },
          { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek-R1', contextWindow: 64_000 },
          { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B', contextWindow: 32_000 },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('自定义供应商跨重启仍在（providers.json 是唯一事实源）', async () => {
    const dataDir = tempDataDir('persist')
    const first = await RyAgentServer.create({ port: 0, dataDir })
    try {
      await sendJson(first.url, '/api/providers', 'POST', {
        displayName: 'OpenRouter',
        protocol: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: ['openai/gpt-4o-mini'],
        apiKey: 'sk-or-test',
        presetId: 'openrouter',
      })
    } finally {
      await first.close()
    }
    const second = await RyAgentServer.create({ port: 0, dataDir })
    try {
      const openrouter = (await listProviders(second.url)).find((row) => {
        return row.id === 'openrouter'
      })
      expect(openrouter?.custom).toBe(true)
      expect(openrouter?.apiKeyConfigured).toBe(true)
      // 凭据在启动时就并进适配器配置：路由可解析出模型目录。
      expect(await second.llm.listModels('openrouter')).toHaveLength(1)
    } finally {
      await second.close()
    }
  })

  it('POST /api/settings/api-key 热更新凭据，不重启（重复挂适配器会撞 DUPLICATE_ADAPTER）', async () => {
    const server = await RyAgentServer.create({ port: 0, dataDir: tempDataDir('apikey') })
    try {
      const saved = await sendJson(server.url, '/api/settings/api-key', 'POST', {
        providerId: 'siliconflow',
        apiKey: 'sk-silicon',
      })
      expect(saved.status).toBe(200)
      expect(saved.body.configured).toBe(true)
      const builtin = (await listProviders(server.url)).find((row) => {
        return row.id === 'siliconflow'
      })
      expect(builtin?.apiKeyConfigured).toBe(true)
      // 第二次调用同样成功：路由集合被原地替换而不是重复注册。
      expect(
        (
          await sendJson(server.url, '/api/settings/api-key', 'POST', {
            providerId: 'siliconflow',
            apiKey: 'sk-silicon-2',
          })
        ).status,
      ).toBe(200)
      expect(
        server.llm.listProviders().map((entry) => {
          return entry.id
        }),
      ).toEqual(['siliconflow'])
      const unknown = await sendJson(server.url, '/api/settings/api-key', 'POST', {
        providerId: 'nope',
        apiKey: 'sk-x',
      })
      expect(unknown.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
