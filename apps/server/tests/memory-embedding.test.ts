/**
 * 向量模型的配置接口：换供应商、换模型、撤销配置。
 *
 * 此前向量模型只能手改 providers.json：换一家非 SiliconFlow 的供应商，语义召回
 * 就静默退化成纯 FTS5，界面上只留一句「未配置 embedding」——用户既不知道为什么，
 * 也没有办法在应用里改。这条接口就是那个「在应用里改」的路。
 *
 * 用例走真实 HTTP 与真实记忆服务：断言的是「改完之后记忆服务确实换了向量来源」
 * （/api/memory/health 里的 embeddings.label 与 model），不是「配置文件被改了」。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-embedding-'))
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

/**
 * 起一个带记忆的服务端。
 *
 * 默认供应商给的是 SiliconFlow（自动判定会套上它的默认向量模型），所以第一条
 * 用例一开始就是「有向量模型」的状态；换模型之后再看 label 与 model 是否跟着变。
 */
async function start(dir: string, providers: Record<string, unknown> = {}): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: dir,
    evolution: null,
    proactive: false,
    providersConfig: {
      providers: {
        siliconflow: {
          baseURL: 'https://api.siliconflow.cn/v1',
          apiKey: 'test-key',
          models: [{ id: 'demo-model' }],
        },
        ...providers,
      },
    },
  })
}

async function getJson(server: RyHarnessServer, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`)
  return { status: response.status, body: await response.json() }
}

async function send(
  server: RyHarnessServer,
  method: 'POST' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  return { status: response.status, body: await response.json() }
}

describe('向量模型配置', () => {
  it('换模型：写盘、热替换，并立刻反映到健康度里', async () => {
    const dir = dataDir()
    const server = await start(dir)
    try {
      const before = await getJson(server, '/api/memory/health')
      expect(before.status).toBe(200)
      expect(before.body.embeddings.label).toBe('configured')

      const saved = await send(server, 'POST', '/api/memory/embedding', {
        providerId: 'siliconflow',
        model: 'custom/embedding-model',
      })
      expect(saved.status).toBe(200)
      expect(saved.body.embedding).toEqual({ providerId: 'siliconflow', model: 'custom/embedding-model' })

      // 记忆服务已经换了向量来源（不是只改了配置文件）。
      const after = await getJson(server, '/api/memory/health')
      expect(after.body.embeddings.model).toBe('custom/embedding-model')

      // 配置落盘：重启后仍然是这一套。
      const written = JSON.parse(readFileSync(join(dir, 'config', 'providers.json'), 'utf8')) as {
        embedding?: { providerId: string; model: string }
      }
      expect(written.embedding).toEqual({ providerId: 'siliconflow', model: 'custom/embedding-model' })
    } finally {
      await server.close()
    }
  })

  it('可以给非 SiliconFlow 的供应商指定向量模型（此前只能退回纯 FTS5）', async () => {
    const dir = dataDir()
    const server = await start(dir, {
      openai: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        models: [{ id: 'gpt-test' }],
      },
    })
    try {
      const saved = await send(server, 'POST', '/api/memory/embedding', {
        providerId: 'openai',
        model: 'text-embedding-3-small',
      })
      expect(saved.status).toBe(200)
      const health = await getJson(server, '/api/memory/health')
      expect(health.body.embeddings.label).toBe('configured')
      expect(health.body.embeddings.model).toBe('text-embedding-3-small')
    } finally {
      await server.close()
    }
  })

  it('供应商不存在 / 没有凭据时如实回 400，且不写盘', async () => {
    const dir = dataDir()
    const server = await start(dir, {
      nokey: {
        baseURL: 'https://api.example.test/v1',
        models: [{ id: 'demo-model' }],
      },
    })
    try {
      const unknown = await send(server, 'POST', '/api/memory/embedding', {
        providerId: 'missing',
        model: 'whatever',
      })
      expect(unknown.status).toBe(400)
      expect(String(unknown.body.error)).toContain('供应商不存在')

      const noKey = await send(server, 'POST', '/api/memory/embedding', {
        providerId: 'nokey',
        model: 'whatever',
      })
      expect(noKey.status).toBe(400)
      expect(String(noKey.body.error)).toContain('API Key')

      // 缺参数也回 400，而不是被当成「清空配置」。
      const incomplete = await send(server, 'POST', '/api/memory/embedding', { providerId: 'siliconflow' })
      expect(incomplete.status).toBe(400)

      // 没写盘：配置文件要么压根不存在（这次是这种情况，服务端拿的是内存配置），
      // 要么里面没有 embedding 这一段。
      const configPath = join(dir, 'config', 'providers.json')
      if (existsSync(configPath)) {
        const written = JSON.parse(readFileSync(configPath, 'utf8')) as { embedding?: unknown }
        expect(written.embedding).toBeUndefined()
      }
    } finally {
      await server.close()
    }
  })

  it('撤销配置后回到自动判定', async () => {
    const dir = dataDir()
    const server = await start(dir)
    try {
      await send(server, 'POST', '/api/memory/embedding', {
        providerId: 'siliconflow',
        model: 'custom/embedding-model',
      })
      const cleared = await send(server, 'DELETE', '/api/memory/embedding')
      expect(cleared.status).toBe(200)
      const written = JSON.parse(readFileSync(join(dir, 'config', 'providers.json'), 'utf8')) as {
        embedding?: unknown
      }
      expect(written.embedding).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
