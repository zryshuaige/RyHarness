/**
 * 语音路由：目录与云端合成。
 *
 * 合成打在一个测试进程自己起的回环服务上——真 socket、真状态码、真音频字节，
 * 不触达任何真实供应商，也不需要真凭据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@ryharness/cordis'
import { RyHarnessServer, type VoiceProvider, VoiceRegistry } from '@ryharness/server'
import { VOICE_ERROR_CODES, type VoiceProfile } from '@ryharness/voice'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const httpServers: Server[] = []
const TOKEN = 'unit-test-voice-token-4a1e'

/** 一段真的 mp3 会有的头（ID3），用来断言回的是音频而不是一段 JSON。 */
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x21, 0xff, 0xfb, 0x90, 0x64])

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-voice-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

/**
 * 把数据目录里的 providers.json 写成"只有一条 siliconflow 路由，端点指到回环服务"。
 *
 * 路由 id 就用 `siliconflow`：引擎凭据的查找以这条路由为先，而这里要证明的正是
 * "用户在设置里配好的凭据与端点被真正用上了"。传 undefined 模拟"没填 Key"。
 */
function writeSiliconflowConfig(dataDir: string, baseUrl: string, apiKey: string | undefined): void {
  mkdirSync(join(dataDir, 'config'), { recursive: true })
  writeFileSync(
    join(dataDir, 'config', 'providers.json'),
    JSON.stringify({
      providers: {
        siliconflow: {
          baseURL: baseUrl,
          protocol: 'openai',
          displayName: 'SiliconFlow',
          models: [{ id: 'deepseek-ai/DeepSeek-V3' }],
          ...(apiKey === undefined ? {} : { apiKey }),
        },
      },
    }),
    'utf8',
  )
}

/** 合成请求的记录：路径 / 凭据头 / 请求体。 */
interface TtsCall {
  path: string
  auth: string | undefined
  body: Record<string, unknown>
}

/** 起一个假的语音服务；reply 留空则回一段真 mp3。 */
async function startFakeTts(reply: { status?: number; contentType?: string; body?: Buffer } = {}): Promise<{
  baseUrl: string
  calls: TtsCall[]
}> {
  const calls: TtsCall[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      calls.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      })
      res.statusCode = reply.status ?? 200
      res.setHeader('content-type', reply.contentType ?? 'audio/mpeg')
      res.end(reply.body ?? MP3_BYTES)
    })
  })
  httpServers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls }
}

/** POST 一条合成请求。 */
function speak(url: string, payload: unknown): Promise<Response> {
  return fetch(`${url}/api/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 起一个不鉴权的服务端（鉴权另有专门的用例钉）。 */
async function startPlainServer(prefix: string): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: tempDataDir(prefix),
    memory: null,
    evolution: null,
    proactive: false,
  })
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

describe('鉴权', () => {
  it('两条路由都过 token 闸门：缺失 token 一律 401 + UNAUTHORIZED', async () => {
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: tempDataDir('auth'),
      memory: null,
      evolution: null,
      proactive: false,
      authToken: TOKEN,
    })
    try {
      const catalog = await fetch(`${server.url}/api/voice/catalog`)
      expect(catalog.status).toBe(401)
      expect(((await catalog.json()) as { code: string }).code).toBe('UNAUTHORIZED')

      const missing = await speak(server.url, { text: '你好', profileId: 'sf-cosyvoice2-anna' })
      expect(missing.status).toBe(401)
      expect(((await missing.json()) as { code: string }).code).toBe('UNAUTHORIZED')
      // 带 token 才放行（闸门不能只拦读）。
      const allowed = await fetch(`${server.url}/api/voice/catalog`, { headers: { authorization: `Bearer ${TOKEN}` } })
      expect(allowed.status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('GET /api/voice/catalog', () => {
  it('返回引擎与音色：系统恒可用，云端看有没有配凭据；目录不回显任何凭据', async () => {
    const server = await startPlainServer('catalog-plain')
    try {
      const response = await fetch(`${server.url}/api/voice/catalog`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        engines: { id: string; name: string; available: boolean; note?: string; reason?: string }[]
        profiles: { id: string; name: string; engine: string; voice: string; sampleText: string }[]
      }
      expect(
        body.engines.map((engine) => {
          return engine.id
        }),
      ).toEqual(['system', 'siliconflow', 'piper'])
      // 系统音色不依赖任何配置，恒可用；没设 SILICONFLOW_API_KEY 时云端不可用。
      expect(body.engines.find((engine) => engine.id === 'system')?.available).toBe(true)
      expect(body.engines.find((engine) => engine.id === 'siliconflow')?.available).toBe(false)
      // 离线引擎没下载时也必须列出来（UI 要显示「需要先下载」），并给出原因。
      const piper = body.engines.find((engine) => engine.id === 'piper')
      expect(piper?.available).toBe(false)
      expect(piper?.reason).toContain('离线语音包还没下载')
      // 三类音色都在，且云端那组的 voice 带模型前缀（端点只认这种写法）。
      expect(body.profiles.some((profile) => profile.engine === 'system')).toBe(true)
      expect(body.profiles.some((profile) => profile.engine === 'piper')).toBe(true)
      expect(body.profiles.some((profile) => profile.voice.includes(':'))).toBe(true)
      for (const profile of body.profiles) {
        expect(profile.sampleText.length).toBeGreaterThan(0)
      }
      expect(JSON.stringify(body)).not.toContain('sk-')
    } finally {
      await server.close()
    }
  })

  it('配了 SiliconFlow Key 之后云端引擎转为可用', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('catalog-key')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const body = (await (await fetch(`${server.url}/api/voice/catalog`)).json()) as {
        engines: { id: string; available: boolean }[]
      }
      expect(body.engines.find((engine) => engine.id === 'siliconflow')?.available).toBe(true)
    } finally {
      await server.close()
    }
  })
})

describe('POST /api/voice/speak', () => {
  it('成功：回音频字节流，带 Content-Type 与 X-Voice-Profile，凭据与端点都用配置里那份', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-ok')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const response = await speak(server.url, {
        text: '你好，我是 Ryen。',
        profileId: 'sf-cosyvoice2-anna',
        speed: 1.1,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('audio/mpeg')
      expect(response.headers.get('x-voice-profile')).toBe('sf-cosyvoice2-anna')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(MP3_BYTES)
      // 真的打到了配置里的端点，且用的是设置里存的那份凭据。
      expect(fake.calls).toHaveLength(1)
      const call = fake.calls[0]
      expect(call.path).toBe('/v1/audio/speech')
      expect(call.auth).toBe('Bearer sk-unit-test-key')
      expect(call.body.model).toBe('FunAudioLLM/CosyVoice2-0.5B')
      expect(call.body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:anna')
      expect(call.body.input).toBe('你好，我是 Ryen。')
      expect(call.body.speed).toBe(1.1)
    } finally {
      await server.close()
    }
  })

  it('超长文本：截断到 2000 字并回 X-Voice-Truncated（界面要能说明只念了前半段）', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-long')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const response = await speak(server.url, { text: '啊'.repeat(2500), profileId: 'sf-cosyvoice2-anna' })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-voice-truncated')).toBe('true')
      expect(String(fake.calls[0].body.input)).toHaveLength(2000)
    } finally {
      await server.close()
    }
  })

  it('没配凭据：VOICE_NO_CREDENTIAL，且不打上游（不拿注定失败的请求去换错误）', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-nokey')
    writeSiliconflowConfig(dataDir, fake.baseUrl, undefined)
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const response = await speak(server.url, { text: '你好', profileId: 'sf-cosyvoice2-anna' })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { code: string }).code).toBe('VOICE_NO_CREDENTIAL')
      expect(fake.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('系统音色：VOICE_ENGINE_LOCAL，前端据此降级到 speechSynthesis', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-local')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const response = await speak(server.url, { text: '你好', profileId: 'system-huihui' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string; error: string }
      expect(body.code).toBe('VOICE_ENGINE_LOCAL')
      expect(body.error).toContain('系统语音')
      expect(fake.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('入参校验：未知音色 / 空文本 / 缺 profileId 各自有码，且都不打上游', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-invalid')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const post = async (payload: unknown): Promise<{ status: number; code: string }> => {
        const response = await speak(server.url, payload)
        return { status: response.status, code: ((await response.json()) as { code: string }).code }
      }
      expect(await post({ text: '你好', profileId: 'no-such-voice' })).toEqual({
        status: 400,
        code: 'VOICE_PROFILE_NOT_FOUND',
      })
      expect(await post({ text: '   ', profileId: 'sf-cosyvoice2-anna' })).toEqual({
        status: 400,
        code: 'VOICE_BAD_REQUEST',
      })
      expect(await post({ text: '你好' })).toEqual({ status: 400, code: 'VOICE_BAD_REQUEST' })
      expect(fake.calls).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('连点同一个音色：第二次被节流挡下，429 VOICE_RATE_LIMITED，不打上游', async () => {
    const fake = await startFakeTts()
    const dataDir = tempDataDir('speak-throttle')
    writeSiliconflowConfig(dataDir, fake.baseUrl, 'sk-unit-test-key')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const first = await speak(server.url, { text: '你好', profileId: 'sf-cosyvoice2-anna' })
      expect(first.status).toBe(200)
      await first.arrayBuffer()
      // 同一音色在最小间隔内的第二次：一次按字符计费的请求都不该多发。
      const second = await speak(server.url, { text: '在吗', profileId: 'sf-cosyvoice2-anna' })
      expect(second.status).toBe(429)
      expect(((await second.json()) as { code: string }).code).toBe('VOICE_RATE_LIMITED')
      expect(fake.calls).toHaveLength(1)
      // 换一个音色不受牵连：节流是按音色算的，不是全局一刀切。
      const other = await speak(server.url, { text: '在吗', profileId: 'sf-cosyvoice2-alex' })
      expect(other.status).toBe(200)
      await other.arrayBuffer()
      expect(fake.calls).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('上游非 2xx：502 VOICE_UPSTREAM，并透传上游的状态码与业务码', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 20047, message: 'Invalid voice.' }))
    })
    httpServers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    const dataDir = tempDataDir('speak-upstream')
    writeSiliconflowConfig(dataDir, `http://127.0.0.1:${port}/v1`, 'sk-unit-test-key')
    const app = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const response = await speak(app.url, { text: '你好', profileId: 'sf-cosyvoice2-anna' })
      expect(response.status).toBe(502)
      const body = (await response.json()) as { code: string; upstreamStatus: number; upstreamCode: string }
      expect(body.code).toBe('VOICE_UPSTREAM')
      expect(body.upstreamStatus).toBe(400)
      expect(body.upstreamCode).toBe('20047')
    } finally {
      await app.close()
    }
  })
})

describe('VoiceRegistry 的 provider seam', () => {
  const profile: VoiceProfile = {
    id: 'local-test-voice',
    name: '测试离线音色',
    engine: 'local-test',
    voice: 'test-model',
    sampleText: '你好。',
    description: '测试用',
  }

  it('注册后目录合并、speak 按 engine 路由并透传 AbortSignal；注销后引擎与音色都消失', async () => {
    const registry = new VoiceRegistry(new Context(), { providers: {} })
    const calls: { text: string; signaled: boolean }[] = []
    const provider: VoiceProvider = {
      engine: 'local-test',
      describe: () => {
        return { name: '离线（测试）', available: true, note: '测试引擎' }
      },
      profiles: () => [profile],
      synthesize: async (request, deps) => {
        calls.push({ text: request.text, signaled: deps.signal !== undefined })
        return { audio: new Uint8Array([82, 73, 70, 70]), mime: 'audio/wav', format: 'wav' }
      },
    }
    const dispose = registry.registerProvider(provider)
    try {
      const catalog = registry.catalog()
      expect(
        catalog.engines.map((engine) => {
          return engine.id
        }),
      ).toEqual(['system', 'siliconflow', 'local-test'])
      expect(catalog.engines.find((engine) => engine.id === 'local-test')).toMatchObject({
        name: '离线（测试）',
        available: true,
      })
      expect(catalog.profiles).toContainEqual(profile)

      const controller = new AbortController()
      const result = await registry.speak(
        { text: '  你好  ', profileId: 'local-test-voice' },
        { signal: controller.signal },
      )
      expect(calls).toEqual([{ text: '  你好  ', signaled: true }])
      expect(result).toMatchObject({ mime: 'audio/wav', profileId: 'local-test-voice', truncated: false })
    } finally {
      dispose()
    }

    expect(registry.registeredEngines()).toEqual([])
    expect(
      registry.catalog().engines.some((engine) => {
        return engine.id === 'local-test'
      }),
    ).toBe(false)
    // 目录刚消失的瞬间仍要报准「引擎没注册」，而不是把用户引去改 profileId。
    await expect(registry.speak({ text: '你好', profileId: 'local-test-voice' })).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.engineUnavailable,
    })
  })

  it('引擎不可用时目录带 reason，speak 直接拒绝且不调用 synthesize', async () => {
    const registry = new VoiceRegistry(new Context(), { providers: {} })
    let synthesized = 0
    registry.registerProvider({
      engine: 'local-test',
      describe: () => {
        return { name: '离线（测试）', available: false, reason: '离线语音包还没下载' }
      },
      profiles: () => [profile],
      synthesize: async () => {
        synthesized += 1
        return { audio: new Uint8Array([1]), mime: 'audio/wav', format: 'wav' }
      },
    })
    const engine = registry.catalog().engines.find((candidate) => {
      return candidate.id === 'local-test'
    })
    expect(engine).toMatchObject({ available: false, reason: '离线语音包还没下载' })
    await expect(registry.speak({ text: '你好', profileId: 'local-test-voice' })).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.engineUnavailable,
    })
    expect(synthesized).toBe(0)
  })

  it('同一个 engine 重复注册直接报错（静默覆盖会让先注册的插件永远收不到请求）', () => {
    const registry = new VoiceRegistry(new Context(), { providers: {} })
    const provider: VoiceProvider = {
      engine: 'local-test',
      profiles: () => [profile],
      synthesize: async () => {
        return { audio: new Uint8Array([1]), mime: 'audio/wav', format: 'wav' }
      },
    }
    registry.registerProvider(provider)
    expect(() => {
      registry.registerProvider(provider)
    }).toThrow(/already registered/)
  })

  it('provider 抛普通 Error 时包成 VOICE_UPSTREAM（HTTP 层不会掉进 INTERNAL）', async () => {
    const registry = new VoiceRegistry(new Context(), { providers: {} })
    registry.registerProvider({
      engine: 'local-test',
      profiles: () => [profile],
      synthesize: async () => {
        throw new Error('模型文件坏了')
      },
    })
    await expect(registry.speak({ text: '你好', profileId: 'local-test-voice' })).rejects.toMatchObject({
      code: VOICE_ERROR_CODES.upstream,
      message: expect.stringContaining('模型文件坏了'),
    })
  })
})
