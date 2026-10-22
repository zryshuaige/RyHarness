/**
 * 供应商设置面：预设目录、新增/删除自定义供应商、热注册适配器、凭据落盘权限、
 * 以及模型发现（verify 顺带回目录 / 未保存草稿的 discover）。
 *
 * 全部走真实 HTTP + 真实文件读写（临时目录），不触网：只到"路由与凭据就位"
 * 为止，不真的向任何供应商发请求。模型发现的探测打在测试进程自己起的回环服务上。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROVIDERS, loadProvidersConfig, type ProvidersConfigFile, RyHarnessServer } from '@ryharness/server'
import { SessionStore } from '@ryharness/session'
import { afterEach, describe, expect, it } from 'vitest'
import { Router } from '../src/router.ts'
import { parseDiscoveredModels, registerProviderRoutes } from '../src/routes/providers.ts'

const tmpDirs: string[] = []
const httpServers: Server[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-providers-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

/**
 * 起一个假的模型服务：按路径给出正文，并记录收到的 Authorization 头。
 *
 * 发现与探测都打在这上面，真 socket、真状态码，不会触达任何真实服务商。
 */
async function startFakeModelService(
  routes: Record<string, { status?: number; body: string }>,
): Promise<{ baseUrl: string; authHeaders: (string | undefined)[] }> {
  const authHeaders: (string | undefined)[] = []
  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization)
    const hit = routes[req.url ?? ''] ?? { status: 404, body: '{}' }
    res.statusCode = hit.status ?? 200
    res.end(hit.body)
  })
  httpServers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, authHeaders }
}

afterEach(async () => {
  while (httpServers.length > 0) {
    const server = httpServers.pop() as Server
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
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

async function sendJson<T = Record<string, unknown>>(
  base: string,
  path: string,
  method: 'POST' | 'DELETE' | 'PATCH',
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/**
 * 读 api-keys.json 里的 key 表。
 *
 * 这份文件带一层信封（`{ $schema, cipher, keys }`），但这里的断言关心的是
 * "哪个 id 存着哪个 key"，不是信封长什么样——换信封不该让它们失真。
 */
function readApiKeys(path: string): Record<string, string> {
  const raw = readJsonFile(path)
  const keys = raw.keys
  return (typeof keys === 'object' && keys !== null ? keys : raw) as Record<string, string>
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
  usedBy: { agentId: string; agentName: string }[]
}

async function listProviders(base: string): Promise<ProviderRow[]> {
  const res = await getJson(base, '/api/providers')
  return res.body.providers as ProviderRow[]
}

/** verify / discover 的回执：连通性结论 + 模型目录。 */
interface ProbeBody {
  ok: boolean
  code: string
  message: string
  latencyMs: number
  /** verify 叫 discovered，discover 叫 models。 */
  discovered?: { id: string; name?: string }[]
  models?: { id: string; name?: string }[]
}

/** OpenAI 兼容的 /v1/models 正文：只回 id，别的什么都不说。 */
const OPENAI_MODELS_BODY = JSON.stringify({
  object: 'list',
  data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }, { id: 'gpt-4o-mini' }],
})

/**
 * 模型发现：此前探测端点把 `/v1/models` 的响应体拿到手就直接丢掉，界面只能让
 * 用户手打精确的 model id。这里钉住"请求早就发了，正文要拿回来用"。
 */
describe('模型发现', () => {
  it('verify 顺带回 discovered：解析 OpenAI 兼容的 data[]，去重且不猜 contextWindow', async () => {
    const fake = await startFakeModelService({ '/v1/models': { body: OPENAI_MODELS_BODY } })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('discover-verify') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '假网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-test-key',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<ProbeBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      // 按端点顺序去重；只有端点真报出来的字段，没有 contextWindow / 价格。
      expect(res.body.discovered).toEqual([{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }])
      expect(JSON.stringify(res.body)).not.toContain('contextWindow')
      // 发现只是附赠：原来的连通性结论一个字没变。
      expect(res.body.code).toBe('ok')
      expect(res.body.message).toContain('API Key')
    } finally {
      await server.close()
    }
  })

  it('Ollama 原生 tags：认 models[].name，探不通时 discovered 为空', async () => {
    const fake = await startFakeModelService({
      '/api/tags': {
        body: JSON.stringify({
          models: [
            { name: 'qwen2.5:7b', model: 'qwen2.5:7b' },
            { name: 'llama3.2:3b', details: { parameter_size: '3B' } },
          ],
        }),
      },
    })
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: tempDataDir('discover-ollama'),
      verifyTimeoutMs: 3000,
    })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '本地 Ollama',
        protocol: 'ollama',
        baseUrl: fake.baseUrl,
        models: ['qwen2.5:7b'],
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<ProbeBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.body.ok).toBe(true)
      // name 就是 id 的那一份不重复带（界面上多显示一遍同样的字没有意义）。
      expect(res.body.discovered).toEqual([{ id: 'qwen2.5:7b' }, { id: 'llama3.2:3b' }])
    } finally {
      await server.close()
    }
  })

  it('探测失败仍回中文诊断，模型目录为空（连接不通就是没有目录可给）', async () => {
    const fake = await startFakeModelService({ '/v1/models': { status: 401, body: '{}' } })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('discover-fail') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '假网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-wrong',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<ProbeBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.body.ok).toBe(false)
      expect(res.body.code).toBe('bad-key')
      expect(res.body.discovered).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('POST /api/providers/discover：还没保存的草稿也能拉目录，凭据一次性使用', async () => {
    const fake = await startFakeModelService({ '/v1/models': { body: OPENAI_MODELS_BODY } })
    const dataDir = tempDataDir('discover-draft')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      const res = await sendJson<ProbeBody>(server.url, '/api/providers/discover', 'POST', {
        baseUrl: `${fake.baseUrl}/`, // 归一：去尾部斜杠
        protocol: 'openai',
        apiKey: 'sk-draft-only',
      })
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.models).toEqual([{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat' }])
      // 凭据只用于这一次请求，不落盘、不进供应商配置。
      expect(fake.authHeaders).toEqual(['Bearer sk-draft-only'])
      expect(readFileSync(join(dataDir, 'config', 'providers.json'), 'utf8')).not.toContain('sk-draft-only')
      expect(existsSync(join(dataDir, 'config', 'api-keys.json'))).toBe(false)
      expect(
        (await listProviders(server.url)).map((row) => {
          return row.id
        }),
      ).toEqual(['siliconflow'])
    } finally {
      await server.close()
    }
  })

  it('discover 的白名单：非绝对地址 / 未知协议 400；免 key 的本地服务照常探', async () => {
    const fake = await startFakeModelService({
      '/api/tags': { body: JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }) },
    })
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: tempDataDir('discover-invalid'),
      verifyTimeoutMs: 3000,
    })
    try {
      const bad = async (payload: unknown): Promise<number> => {
        return (await sendJson(server.url, '/api/providers/discover', 'POST', payload)).status
      }
      expect(await bad({ baseUrl: 'api.example.com/v1' })).toBe(400)
      expect(await bad({ baseUrl: 'https://x.dev/v1', protocol: 'anthropic' })).toBe(400)
      // 云端协议缺 Key 时说人话，而不是拿一个假 token 去换一个看不懂的 401。
      const noKey = await sendJson<ProbeBody>(server.url, '/api/providers/discover', 'POST', {
        baseUrl: 'https://api.deepseek.com/v1',
      })
      expect(noKey.body.code).toBe('no-key')
      expect(noKey.body.models).toEqual([])
      // 免 key 的本地服务不需要凭据，直接问。
      const local = await sendJson<ProbeBody>(server.url, '/api/providers/discover', 'POST', {
        baseUrl: fake.baseUrl,
        protocol: 'ollama',
      })
      expect(local.body.ok).toBe(true)
      expect(local.body.models).toEqual([{ id: 'qwen2.5:7b' }])
    } finally {
      await server.close()
    }
  })

  it('端点回的不是 JSON：探测照旧算通过，模型目录为空（附加信息不该推翻已成立的结论）', async () => {
    const fake = await startFakeModelService({ '/v1/models': { body: '<html>not json</html>' } })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('discover-garbage') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '假网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-test-key',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<ProbeBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.body.ok).toBe(true)
      expect(res.body.discovered).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('解析器本身：只认列表形状，畸形条目丢掉，其余原样透出', () => {
    expect(parseDiscoveredModels({ data: [{ id: 'a' }, { nope: 1 }, null, 'b'] }, 'openai')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
    // 少数网关只回 models 而不是 data。
    expect(parseDiscoveredModels({ models: [{ id: 'x' }] }, 'openai')).toEqual([{ id: 'x' }])
    // 名字与 id 不同才带：Ollama 的 name 就是 id。
    expect(parseDiscoveredModels({ models: [{ name: 'q', model: 'q' }] }, 'ollama')).toEqual([{ id: 'q' }])
    expect(parseDiscoveredModels({ models: [{ id: 'q', name: 'Qwen' }] }, 'openai')).toEqual([
      { id: 'q', name: 'Qwen' },
    ])
    expect(parseDiscoveredModels(null, 'openai')).toEqual([])
    expect(parseDiscoveredModels({ data: 'not-an-array' }, 'openai')).toEqual([])
  })
})

describe('供应商预设', () => {
  it('GET /api/provider-presets 返回常用服务商，字段齐全', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('presets') })
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
      // DeepSeek 预设与官方文档对齐：base_url 不带 /v1，模型名是 deepseek-flash
      // （即 DeepSeek-V4.1-Flash，2026-10 升级后模型名不变）——预设过期会让用户
      // 对着文档配出一个 404 的模型。
      const deepseek = presets.find((preset) => {
        return preset.id === 'deepseek'
      })
      expect(deepseek?.baseUrl).toBe('https://api.deepseek.com')
      expect(deepseek?.models).toContain('deepseek-flash')
      expect(deepseek?.models).toContain('deepseek-v4-pro')
    } finally {
      await server.close()
    }
  })
})

describe('新增供应商', () => {
  it('POST /api/providers：路由落 providers.json、key 落 api-keys.json（0600）、适配器热注册', async () => {
    const dataDir = tempDataDir('create')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
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
      expect(readApiKeys(keysPath)).toEqual({ deepseek: 'sk-test-key' })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('invalid') })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('dup') })
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

  it('同一个 baseUrl 不给建第二条：点已存在的预设回 409，而不是退化成 custom-xxxxxxxx', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('dup-endpoint') })
    try {
      // 内置 SiliconFlow 就指向这个地址：再点一次它的预设必须被挡住，
      // 否则用户会得到一条丢品牌图标、id 是随机串的重复项。
      const again = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: 'SiliconFlow 官方',
        protocol: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1/',
        models: ['deepseek-ai/DeepSeek-V3'],
        presetId: 'siliconflow',
      })
      expect(again.status).toBe(409)
      expect(again.body.existingId).toBe('siliconflow')
      // 说的是中文、点了下一步（去编辑），不是一句英文 conflict。
      expect(again.body.error).toContain('已经添加过')
      expect(again.body.error).toContain('SiliconFlow')
      expect(again.body.error).toContain('编辑')
      // 一条都没建出来（末尾斜杠也算同一个地址）。
      expect(
        (await listProviders(server.url)).map((row) => {
          return row.id
        }),
      ).toEqual(['siliconflow'])

      // 地址不同的「自定义」照旧能建——挡住的是重复，不是自定义。
      const gateway = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['m'],
      })
      expect(gateway.status).toBe(201)
    } finally {
      await server.close()
    }
  })

  it('落盘时剥掉合并进来的明文 key：改过 key 后再增删供应商也不会把它抄进 providers.json', async () => {
    const dataDir = tempDataDir('no-leak')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir })
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
      expect(readApiKeys(join(dataDir, 'config', 'api-keys.json'))).toEqual({})
    } finally {
      await server.close()
    }
  })
})

describe('编辑供应商', () => {
  it('PATCH /api/providers/:id 改名字 / 地址 / 模型 / 协议并热注册：不用删了重建', async () => {
    const dataDir = tempDataDir('patch')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['m-old'],
        apiKey: 'sk-private',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id

      const patched = await sendJson(server.url, `/api/providers/${providerId}`, 'PATCH', {
        displayName: '公司内网网关',
        baseUrl: 'http://127.0.0.1:9100/v1/',
        models: ['m-new', 'm-second'],
      })
      expect(patched.status).toBe(200)
      const provider = (patched.body as { provider: ProviderRow }).provider
      expect(provider.displayName).toBe('公司内网网关')
      expect(provider.baseUrl).toBe('http://127.0.0.1:9100/v1') // 归一：去尾部斜杠
      expect(
        provider.models.map((model) => {
          return model.id
        }),
      ).toEqual(['m-new', 'm-second'])
      // 没传的字段原样保留（协议没动，仍是 openai；凭据也别被顺手抹掉）。
      expect(provider.protocol).toBe('openai')
      expect(provider.apiKeyConfigured).toBe(true)
      expect(provider.custom).toBe(true)

      // 落盘 + 热注册：适配器立刻按新地址与新模型目录解析。
      const stored = (
        readJsonFile(join(dataDir, 'config', 'providers.json')).providers as Record<string, Record<string, unknown>>
      )[providerId] as Record<string, unknown>
      expect(stored.displayName).toBe('公司内网网关')
      expect(stored.baseURL).toBe('http://127.0.0.1:9100/v1')
      expect(stored.apiKey).toBeUndefined()
      expect(readFileSync(join(dataDir, 'config', 'api-keys.json'), 'utf8')).toContain('sk-private')
      expect(
        (await server.llm.listModels(providerId)).map((model) => {
          return model.id
        }),
      ).toEqual(['m-new', 'm-second'])
      const listed = (await listProviders(server.url)).find((row) => {
        return row.id === providerId
      })
      expect(listed?.baseUrl).toBe('http://127.0.0.1:9100/v1')
    } finally {
      await server.close()
    }
  })

  it('只认 displayName / baseUrl / models / protocol：凭据与归属标记改了也无效', async () => {
    const dataDir = tempDataDir('patch-whitelist')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      await sendJson(server.url, '/api/settings/api-key', 'POST', { providerId: 'siliconflow', apiKey: 'sk-silicon' })
      const patched = await sendJson(server.url, '/api/providers/siliconflow', 'PATCH', {
        displayName: 'SiliconFlow（公司采购）',
        // 白名单之外的键：不能靠它改凭据、把自己改成自定义、或抹掉内置路由的归属。
        apiKey: 'sk-injected',
        custom: true,
        presetId: 'nope',
        baseURL: 'http://127.0.0.1:9999/v1',
      })
      expect(patched.status).toBe(200)
      const provider = (patched.body as { provider: ProviderRow }).provider
      expect(provider.displayName).toBe('SiliconFlow（公司采购）')
      expect(provider.custom).toBe(false)
      expect(provider.baseUrl).toBe('https://api.siliconflow.cn/v1')
      // 存着的还是原来那个 key。
      expect(readApiKeys(join(dataDir, 'config', 'api-keys.json')).siliconflow).toBe('sk-silicon')
    } finally {
      await server.close()
    }
  })

  it('校验：空名字 / 相对地址 / 清空模型列表 / 未知 id 一律 400 或 404', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('patch-invalid') })
    try {
      const patch = async (payload: unknown): Promise<number> => {
        return (await sendJson(server.url, '/api/providers/siliconflow', 'PATCH', payload)).status
      }
      expect(await patch({ displayName: '   ' })).toBe(400)
      expect(await patch({ baseUrl: 'api.siliconflow.cn/v1' })).toBe(400)
      expect(await patch({ baseUrl: 'ftp://api.siliconflow.cn' })).toBe(400)
      expect(await patch({ models: [] })).toBe(400)
      expect(await patch({ models: ['ok', 7] })).toBe(400)
      expect(await patch({ protocol: 'anthropic' })).toBe(400)
      expect((await sendJson(server.url, '/api/providers/nope', 'PATCH', { displayName: 'X' })).status).toBe(404)
      // 一条都没被改坏。
      const listed = (await listProviders(server.url)).find((row) => {
        return row.id === 'siliconflow'
      })
      expect(listed?.displayName).toBe('SiliconFlow')
      expect(listed?.baseUrl).toBe('https://api.siliconflow.cn/v1')
    } finally {
      await server.close()
    }
  })

  it('改成另一条已存在的 baseUrl：回 409 并点名那一条（不静默产生重复项）', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('patch-dup') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['m'],
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const clash = await sendJson(server.url, `/api/providers/${providerId}`, 'PATCH', {
        baseUrl: 'https://api.siliconflow.cn/v1',
      })
      expect(clash.status).toBe(409)
      expect(clash.body.existingId).toBe('siliconflow')
      expect(clash.body.error).toContain('SiliconFlow')
      // 地址没被改掉。
      expect(
        (await listProviders(server.url)).find((row) => {
          return row.id === providerId
        })?.baseUrl,
      ).toBe('http://127.0.0.1:9000/v1')
    } finally {
      await server.close()
    }
  })

  it('删掉还挂在 agent 上的模型：回 409 并点名是哪个 agent 在用（而不是静默变砖）', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('patch-model-in-use') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['m-in-use', 'm-free'],
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const agent = await sendJson(server.url, '/api/agents', 'POST', {
        templateKey: 'coding',
        name: '小译',
        provider: providerId,
        model: 'm-in-use',
      })
      const agentId = (agent.body as { agent: { id: string } }).agent.id

      // 删掉没人用的那个：放行。
      const harmless = await sendJson(server.url, `/api/providers/${providerId}`, 'PATCH', {
        models: ['m-in-use', 'm-brand-new'],
      })
      expect(harmless.status).toBe(200)

      // 删掉正在被用的那个：拦下，并点名。
      const blocked = await sendJson(server.url, `/api/providers/${providerId}`, 'PATCH', {
        models: ['m-brand-new'],
      })
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toContain('m-in-use')
      expect(blocked.body.error).toContain('小译')
      expect(blocked.body.models).toEqual([{ modelId: 'm-in-use', agents: [{ agentId, agentName: '小译' }] }])
      // 模型列表原样保留：被拦下的编辑不能有一半生效。
      expect(
        (await listProviders(server.url))
          .find((row) => {
            return row.id === providerId
          })
          ?.models.map((model) => {
            return model.id
          }),
      ).toEqual(['m-in-use', 'm-brand-new'])

      // agent 改绑到别的模型后就能删了。
      await fetch(`${server.url}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm-brand-new' }),
      })
      expect(
        (await sendJson(server.url, `/api/providers/${providerId}`, 'PATCH', { models: ['m-brand-new'] })).status,
      ).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('内置供应商视图', () => {
  it('GET /api/providers 的 ProviderInfo 带 custom / protocol / baseUrl，内置条目 custom=false', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('builtin') })
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
        // 模型目录本身由 provider-model-catalog.test.ts 钉住（真实 id / 上下文长度），
        // 这里只证明 HTTP 视图原样带出它，不再抄一份十几条的清单。
        models: DEFAULT_PROVIDERS.siliconflow?.models,
        usedBy: [
          // 内置小队三位都走这条路由（Ryen + 首启种下的两位常驻成员）。
          { agentId: 'ryen', agentName: 'Ryen' },
          { agentId: 'ryen-team-coding', agentName: '工程师' },
          { agentId: 'ryen-team-writing', agentName: '文案' },
        ],
      })
    } finally {
      await server.close()
    }
  })

  it('自定义供应商跨重启仍在（providers.json 是唯一事实源）', async () => {
    const dataDir = tempDataDir('persist')
    const first = await RyHarnessServer.create({ port: 0, dataDir })
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
    const second = await RyHarnessServer.create({ port: 0, dataDir })
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
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('apikey') })
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

/**
 * 热注册失败时的回滚。
 *
 * providers.json 是先写完、热注册后做的，而 `LlmRuntime` 的 `replace()` 会在候选集
 * 撞名 / 名称非法 / 注册已释放时抛。只抛不退回，磁盘就留下一份**从未验证过能否注册**
 * 的路由集合：界面上这次编辑明明"没生效"，下一次启动却带着它起来炸。
 *
 * 这里直接把路由挂到一个会抛的 refreshProviders 上（真服务器里那次抛来自适配器注册
 * 的校验），断言两件事：providers.json 退回原样，且失败不会被报成成功。
 */
describe('热注册失败：落盘一起退回', () => {
  /** 能被 Router 读 body 的假请求（异步可迭代即可）。 */
  function fakeRequest(method: string, payload?: unknown): IncomingMessage {
    const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
    return {
      method,
      headers: {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as IncomingMessage
  }

  /** 只记状态码与响应体的假响应。 */
  function fakeResponse(): { res: ServerResponse; status: () => number; body: () => string } {
    let status = 0
    let text = ''
    const res = {
      writeHead(code: number) {
        status = code
        return res
      },
      end(payload?: string) {
        text = payload ?? ''
        return res
      },
    } as unknown as ServerResponse
    return {
      res,
      status: () => {
        return status
      },
      body: () => {
        return text
      },
    }
  }

  /** 起一份只含一条内置路由的配置与临时数据目录。 */
  function fixture(prefix: string): { dataDir: string; providers: ProvidersConfigFile; store: SessionStore } {
    const dataDir = tempDataDir(prefix)
    mkdirSync(join(dataDir, 'config'), { recursive: true })
    writeFileSync(
      join(dataDir, 'config', 'providers.json'),
      JSON.stringify({
        providers: {
          siliconflow: {
            baseURL: 'https://api.siliconflow.cn/v1',
            protocol: 'openai',
            displayName: 'SiliconFlow',
            models: [{ id: 'Qwen/Qwen2.5-7B-Instruct' }],
          },
        },
      }),
    )
    return {
      dataDir,
      providers: loadProvidersConfig(join(dataDir, 'config', 'providers.json')),
      store: new SessionStore(':memory:'),
    }
  }

  it('PATCH 热注册抛了：providers.json 退回原样，内存也退回原样', async () => {
    const { dataDir, providers, store } = fixture('rollback-patch')
    const registered: string[][] = []
    const router = new Router()
    registerProviderRoutes(router, {
      store,
      dataDir,
      providers,
      verifyTimeoutMs: 8000,
      refreshProviders: (next) => {
        registered.push(Object.keys(next.providers))
        // 第一次（改名的这次）抛；回滚那次放行，替身要能退回去。
        if (registered.length === 1) throw new Error('route already registered')
        for (const [id, provider] of Object.entries(next.providers)) providers.providers[id] = provider
      },
    })
    const configPath = join(dataDir, 'config', 'providers.json')
    const before = readFileSync(configPath, 'utf8')

    const out = fakeResponse()
    // dispatch 只把 HttpRequestError 转成 4xx；注册失败是普通 Error，会往上冒——
    // 真服务器顶层再转 500。无论如何它不能被吞成一个 200。
    await expect(
      router.dispatch(fakeRequest('PATCH', { displayName: '改个名' }), out.res, '/api/providers/siliconflow'),
    ).rejects.toThrow('route already registered')
    expect(out.status()).toBe(0)

    // 磁盘退回：没有留下那份从未验证过能否注册的路由集合。
    // 比内容不比字节——写回走的是 writePrivateJson，行尾格式与手写的种子文件未必一致。
    expect(readJsonFile(configPath)).toEqual(JSON.parse(before))
    // 内存也退回：路由集合回到改动前那一份。
    expect(registered).toHaveLength(2)
    expect(registered[1]).toEqual(['siliconflow'])
    expect(providers.providers.siliconflow?.displayName).toBe('SiliconFlow')
  })

  it('POST 热注册抛了：providers.json 与凭据都不留残骸', async () => {
    const { dataDir, providers, store } = fixture('rollback-post')
    const router = new Router()
    let calls = 0
    registerProviderRoutes(router, {
      store,
      dataDir,
      providers,
      verifyTimeoutMs: 8000,
      refreshProviders: () => {
        calls += 1
        if (calls === 1) throw new Error('route already registered')
      },
    })
    const configPath = join(dataDir, 'config', 'providers.json')
    const keysPath = join(dataDir, 'config', 'api-keys.json')
    const before = readFileSync(configPath, 'utf8')

    await expect(
      router.dispatch(
        fakeRequest('POST', {
          displayName: 'DeepSeek',
          protocol: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          models: ['deepseek-chat'],
          apiKey: 'sk-test-key',
        }),
        fakeResponse().res,
        '/api/providers',
      ),
    ).rejects.toThrow('route already registered')

    expect(readJsonFile(configPath)).toEqual(JSON.parse(before))
    // 凭据也不能留下孤儿条目：它指向一条已经不存在的路由（文件本身仍在，只是空了）。
    expect(readApiKeys(keysPath)).toEqual({})
  })
})
