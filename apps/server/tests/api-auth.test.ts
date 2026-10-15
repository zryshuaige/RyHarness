/**
 * 本地 API 的一次性 token 闸门。
 *
 * 后端固定监听回环端口，工具链里又有 shellExec：只靠回环地址等于对全机开放。
 * 这里覆盖两条通道——HTTP 中间件与 WebSocket upgrade——以及"校验失败必须回 401
 * 而不是静默断开"，后者是渲染层能给出正确提示的前提。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const TOKEN = 'unit-test-api-token-2f8c1a'
const WRONG = 'unit-test-api-token-WRONG'

const tmpDirs: string[] = []

async function startServer(token: string | undefined): Promise<RyAgentServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-auth-'))
  tmpDirs.push(dataDir)
  return RyAgentServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    ...(token === undefined ? {} : { authToken: token }),
  })
}

async function get(base: string, path: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, headers === undefined ? {} : { headers })
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

describe('本地 API 的一次性 token', () => {
  it('不带 token / 带错 token 一律 401，并回机器码 UNAUTHORIZED', async () => {
    const server = await startServer(TOKEN)
    try {
      const rejected: (Record<string, string> | undefined)[] = [
        undefined,
        { authorization: `Bearer ${WRONG}` },
        { 'x-ryagent-token': WRONG },
        { authorization: `Bearer ${TOKEN}x` },
      ]
      for (const headers of rejected) {
        const res = await get(server.url, '/api/agents', headers)
        expect(res.status).toBe(401)
        const body = (await res.json()) as { error: string; code: string }
        expect(body.code).toBe('UNAUTHORIZED')
        expect(typeof body.error).toBe('string')
      }
    } finally {
      await server.close()
    }
  })

  it('Authorization: Bearer、x-ryagent-token 头与 ?token= 三条路都放行', async () => {
    const server = await startServer(TOKEN)
    try {
      expect((await get(server.url, '/api/agents', { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
      expect((await get(server.url, '/api/agents', { 'x-ryagent-token': TOKEN })).status).toBe(200)
      expect((await get(server.url, `/api/agents?token=${TOKEN}`)).status).toBe(200)
      // 写操作同样过闸：闸门不能只拦读。
      const created = await fetch(`${server.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: '带 token 的助理' }),
      })
      expect(created.status).toBe(201)
      const anonymous = await fetch(`${server.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '没 token 的助理' }),
      })
      expect(anonymous.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('预检不放行也不拦：浏览器发 OPTIONS 时还没带凭据', async () => {
    const server = await startServer(TOKEN)
    try {
      const res = await fetch(`${server.url}/api/agents`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
    } finally {
      await server.close()
    }
  })

  it('没给 token 的实例（独立开发进程/测试）行为不变：不鉴权', async () => {
    const server = await startServer(undefined)
    try {
      expect((await get(server.url, '/api/agents')).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('未知路由回 404 且带机器码 NOT_FOUND', async () => {
    const server = await startServer(TOKEN)
    try {
      const res = await get(server.url, '/api/does-not-exist', { authorization: `Bearer ${TOKEN}` })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('NOT_FOUND')
    } finally {
      await server.close()
    }
  })
})

describe('WebSocket upgrade 的 token 闸门', () => {
  /** 握手结果：回 0 表示连上了，回 HTTP 状态码表示被 upgrade 层拒绝。 */
  function handshake(url: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
      })
      ws.on('open', () => {
        ws.close()
        resolve(0)
      })
      ws.on('error', () => {
        // unexpected-response 先到时这里只是收尾；没先到的就是握手直接失败。
      })
      setTimeout(() => {
        reject(new Error('websocket handshake timed out'))
      }, 5000)
    })
  }

  it('缺 token 的握手回 401（而不是静默掐断）', async () => {
    const server = await startServer(TOKEN)
    try {
      const wsBase = server.url.replace('http', 'ws')
      expect(await handshake(`${wsBase}/ws?conversationId=c1`)).toBe(401)
      expect(await handshake(`${wsBase}/ws?conversationId=c1&token=${WRONG}`)).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('带 token 的握手正常建立', async () => {
    const server = await startServer(TOKEN)
    try {
      const wsBase = server.url.replace('http', 'ws')
      expect(await handshake(`${wsBase}/ws?conversationId=c1&token=${TOKEN}`)).toBe(0)
    } finally {
      await server.close()
    }
  })
})
