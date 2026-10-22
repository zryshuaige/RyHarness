/**
 * 供应商设置的闭环面：连通性探测（verify）、引用关系（usedBy）、删除保护与凭据移除。
 *
 * 探测全部打在测试进程自己起的本地 HTTP 服务上（真 socket、真状态码），不会
 * 触达任何真实服务商；"服务没启动"用一条没人监听的回环端口制造。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const httpServers: Server[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-verify-${prefix}-`))
  tmpDirs.push(dir)
  return dir
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

/** 起一个本地假服务商：按路径给出固定状态码，并记录收到的 Authorization 头。 */
async function startFakeProvider(
  handler: (path: string, headers: Record<string, string | string[] | undefined>) => number,
): Promise<{ baseUrl: string; authHeaders: (string | undefined)[] }> {
  const authHeaders: (string | undefined)[] = []
  const server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization)
    res.statusCode = handler(req.url ?? '/', req.headers)
    res.end('{}')
  })
  httpServers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, authHeaders }
}

/** 一个确定没人监听的回环端口（先占再放，确保没人刚好抢到）。 */
async function closedPortBaseUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  return `http://127.0.0.1:${address.port}/v1`
}

/** 发一个 JSON 请求；T 是回执形状（默认按 Record 传给调用方自行断言）。 */
async function sendJson<T = Record<string, unknown>>(
  base: string,
  path: string,
  method: 'POST' | 'DELETE',
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

interface VerifyBody {
  ok: boolean
  code: string
  message: string
  latencyMs: number
}

describe('POST /api/providers/:id/verify', () => {
  it('OpenAI 兼容：带凭据打 models 列表端点，成功回 ok + 延迟', async () => {
    const fake = await startFakeProvider((path) => {
      return path === '/v1/models' ? 200 : 404
    })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('ok') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '假网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-test-key',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<VerifyBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.status).toBe(200)
      const body = res.body as VerifyBody
      expect(body.ok).toBe(true)
      expect(body.message).toContain('API Key')
      expect(body.latencyMs).toBeGreaterThanOrEqual(0)
      // 凭据真的带上了（不回显，只发）。
      expect(fake.authHeaders[0]).toBe('Bearer sk-test-key')
    } finally {
      await server.close()
    }
  })

  it('凭据无效（401）与服务没启动（连接被拒）与域名解析失败：三种中文诊断，都不是 500', async () => {
    const fake = await startFakeProvider(() => {
      return 401
    })
    const deadUrl = await closedPortBaseUrl()
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('fail') })
    try {
      const badKey = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '假网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-wrong',
      })
      const badKeyId = (badKey.body as { provider: { id: string } }).provider.id
      const unauthorized = await sendJson<VerifyBody>(server.url, `/api/providers/${badKeyId}/verify`, 'POST')
      expect(unauthorized.status).toBe(200)
      expect(unauthorized.body.ok).toBe(false)
      expect(unauthorized.body.code).toBe('bad-key')
      expect(unauthorized.body.message).toContain('API Key 无效')
      // 说清下一步：403/401 也可能是余额或模型权限，不是只有"key 填错"。
      expect(unauthorized.body.message).toContain('余额')

      const dead = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '没启动的服务',
        protocol: 'openai',
        baseUrl: deadUrl,
        models: ['m1'],
        apiKey: 'sk-any',
      })
      const deadId = (dead.body as { provider: { id: string } }).provider.id
      const refused = await sendJson<VerifyBody>(server.url, `/api/providers/${deadId}/verify`, 'POST')
      expect(refused.status).toBe(200)
      expect(refused.body.ok).toBe(false)
      expect(refused.body.code).toBe('service-down')
      expect(refused.body.message).toContain('连不上')

      // 域名解析不出来 → 单独一类诊断（改 baseUrl / 换网络，不是 key 的问题）。
      const badHost = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '不存在的域名',
        protocol: 'openai',
        baseUrl: 'http://ryharness-no-such-host.invalid/v1',
        models: ['m1'],
        apiKey: 'sk-any',
      })
      const badHostId = (badHost.body as { provider: { id: string } }).provider.id
      const unreachable = await sendJson<VerifyBody>(server.url, `/api/providers/${badHostId}/verify`, 'POST')
      expect(unreachable.status).toBe(200)
      expect(unreachable.body.ok).toBe(false)
      expect(unreachable.body.code).toBe('dns')
      expect(unreachable.body.message).toContain('域名解析不出来')
      // 内部错误码不进人话：ENOTFOUND 是排查看的，不是用户能处理的东西。
      expect(unreachable.body.message).not.toContain('ENOTFOUND')
    } finally {
      await server.close()
    }
  })

  it('限流（429）单独一类：说过一会儿再试，而不是当成服务错误', async () => {
    const fake = await startFakeProvider(() => {
      return 429
    })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('ratelimit') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '限流的网关',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-any',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<VerifyBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(false)
      expect(res.body.code).toBe('rate-limited')
      expect(res.body.message).toContain('限流')
      expect(res.body.message).toContain('Key 本身没问题')
    } finally {
      await server.close()
    }
  })

  it('地址写错（404）与本地服务未启动：各自给能照着做的一句话', async () => {
    const fake = await startFakeProvider(() => {
      return 404
    })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('notfound') })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '地址写错了',
        protocol: 'openai',
        baseUrl: fake.baseUrl,
        models: ['m1'],
        apiKey: 'sk-any',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      const res = await sendJson<VerifyBody>(server.url, `/api/providers/${providerId}/verify`, 'POST')
      expect(res.body.code).toBe('not-found')
      expect(res.body.message).toContain('/v1')
    } finally {
      await server.close()
    }
  })

  it('Ollama 探本机原生 tags 端点；没启动时提示先跑 ollama serve', async () => {
    const fake = await startFakeProvider((path) => {
      // 只认原生面：命中 /api/tags 才算"服务在跑"。
      return path === '/api/tags' ? 200 : 404
    })
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('ollama'), verifyTimeoutMs: 3000 })
    try {
      const alive = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '本地 Ollama',
        protocol: 'ollama',
        baseUrl: fake.baseUrl,
        models: ['qwen2.5:7b'],
      })
      const aliveId = (alive.body as { provider: { id: string } }).provider.id
      const ok = await sendJson<VerifyBody>(server.url, `/api/providers/${aliveId}/verify`, 'POST')
      expect(ok.body.ok).toBe(true)
      expect(ok.body.message).toContain('本地模型服务')

      const deadUrl = await closedPortBaseUrl()
      const dead = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '没启动的 Ollama',
        protocol: 'ollama',
        baseUrl: deadUrl,
        models: ['qwen2.5:7b'],
      })
      const deadId = (dead.body as { provider: { id: string } }).provider.id
      const refused = await sendJson<VerifyBody>(server.url, `/api/providers/${deadId}/verify`, 'POST')
      expect(refused.body.ok).toBe(false)
      expect(refused.body.message).toContain('ollama serve')
    } finally {
      await server.close()
    }
  })

  it('没配 Key 时直接给出人话提示，不去打网络；未知供应商 404', async () => {
    const server = await RyHarnessServer.create({ port: 0, dataDir: tempDataDir('nokey') })
    try {
      const noKey = await sendJson<VerifyBody>(server.url, '/api/providers/siliconflow/verify', 'POST')
      expect(noKey.status).toBe(200)
      expect(noKey.body.ok).toBe(false)
      // code 让界面不必再猜：「还没填 Key」里也有 "API Key"，按关键词重判会被
      // 改写成「凭据被供应商拒绝」。
      expect(noKey.body.code).toBe('no-key')
      expect(noKey.body.message).toContain('还没填 API Key')
      expect(noKey.body.latencyMs).toBe(0)
      expect((await sendJson(server.url, '/api/providers/nope/verify', 'POST')).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('供应商的引用关系（usedBy）', () => {
  it('GET /api/providers 每项带 usedBy；删除被引用的供应商回 409 并附引用者', async () => {
    const dataDir = tempDataDir('usedby')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      const created = await sendJson(server.url, '/api/providers', 'POST', {
        displayName: '私有网关',
        protocol: 'openai',
        baseUrl: 'http://127.0.0.1:9000/v1',
        models: ['my-model'],
        apiKey: 'sk-private',
      })
      const providerId = (created.body as { provider: { id: string } }).provider.id
      // 刚建好还没人用。
      const fresh = (await fetch(`${server.url}/api/providers`).then((r) => {
        return r.json()
      })) as { providers: { id: string; usedBy: unknown[] }[] }
      expect(
        fresh.providers.find((row) => {
          return row.id === providerId
        })?.usedBy,
      ).toEqual([])

      // 建一个用它的 agent。
      const agent = await sendJson(server.url, '/api/agents', 'POST', {
        templateKey: 'coding',
        name: 'Coder',
        provider: providerId,
        model: 'my-model',
      })
      const agentId = (agent.body as { agent: { id: string } }).agent.id

      const listed = (await fetch(`${server.url}/api/providers`).then((r) => {
        return r.json()
      })) as { providers: { id: string; usedBy: { agentId: string; agentName: string }[] }[] }
      expect(
        listed.providers.find((row) => {
          return row.id === providerId
        })?.usedBy,
      ).toEqual([{ agentId, agentName: 'Coder' }])

      // 被引用就不能删：否则那个 agent 直接变成转不起来的砖。
      const blocked = await sendJson(server.url, `/api/providers/${providerId}`, 'DELETE')
      expect(blocked.status).toBe(409)
      expect((blocked.body as { usedBy: { agentId: string }[] }).usedBy).toEqual([{ agentId, agentName: 'Coder' }])
      // 路由还在（没被静默删掉）。
      const stillThere = (await fetch(`${server.url}/api/providers`).then((r) => {
        return r.json()
      })) as { providers: { id: string }[] }
      expect(
        stillThere.providers.some((row) => {
          return row.id === providerId
        }),
      ).toBe(true)

      // 换掉 agent 的供应商后就能删了。
      await fetch(`${server.url}/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'siliconflow' }),
      })
      expect((await sendJson(server.url, `/api/providers/${providerId}`, 'DELETE')).status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('DELETE /api/settings/api-key/:id', () => {
  it('移除凭据并从 0600 文件里消失，适配器热更新后不再"已配置"', async () => {
    const dataDir = tempDataDir('delkey')
    const server = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      expect(
        (
          await sendJson(server.url, '/api/settings/api-key', 'POST', {
            providerId: 'siliconflow',
            apiKey: 'sk-silicon',
          })
        ).status,
      ).toBe(200)
      const keysPath = join(dataDir, 'config', 'api-keys.json')
      expect(readFileSync(keysPath, 'utf8')).toContain('sk-silicon')

      const removed = await sendJson(server.url, '/api/settings/api-key/siliconflow', 'DELETE')
      expect(removed.status).toBe(200)
      expect(removed.body).toEqual({ providerId: 'siliconflow', configured: false })

      const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, string>
      expect(keys.siliconflow).toBeUndefined()
      // 热更新：列表里也回到"没配"。
      const providers = (await fetch(`${server.url}/api/providers`).then((r) => {
        return r.json()
      })) as { providers: { id: string; apiKeyConfigured: boolean }[] }
      expect(
        providers.providers.find((row) => {
          return row.id === 'siliconflow'
        })?.apiKeyConfigured,
      ).toBe(false)

      // 未知供应商 404；删两次也安全。
      expect((await sendJson(server.url, '/api/settings/api-key/nope', 'DELETE')).status).toBe(404)
      expect((await sendJson(server.url, '/api/settings/api-key/siliconflow', 'DELETE')).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('删掉应用内 key 后跨重启依然是没有配（api-keys.json 是唯一事实源）', async () => {
    const dataDir = tempDataDir('delkey-restart')
    const first = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      await sendJson(first.url, '/api/settings/api-key', 'POST', { providerId: 'siliconflow', apiKey: 'sk-silicon' })
      expect((await sendJson(first.url, '/api/settings/api-key/siliconflow', 'DELETE')).status).toBe(200)
    } finally {
      await first.close()
    }
    const second = await RyHarnessServer.create({ port: 0, dataDir })
    try {
      const providers = (await fetch(`${second.url}/api/providers`).then((r) => {
        return r.json()
      })) as { providers: { id: string; apiKeyConfigured: boolean }[] }
      expect(
        providers.providers.find((row) => {
          return row.id === 'siliconflow'
        })?.apiKeyConfigured,
      ).toBe(false)
    } finally {
      await second.close()
    }
  })
})
