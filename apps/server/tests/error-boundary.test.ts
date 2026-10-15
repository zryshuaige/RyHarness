/**
 * HTTP 边缘的错误边界：响应恒为 `{error, code}`，且状态码说的是实话。
 *
 * 特别盯住两条：非法 JSON → 400 BAD_REQUEST（调用方的错），而落库失败 → 500
 * INTERNAL（服务端故障）。后者此前被 catch 成 400，调用方会以为改改请求体重试就行，
 * 而它会一直失败。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyAgentServer } from '@ryagent/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

async function startServer(): Promise<RyAgentServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryagent-errors-'))
  tmpDirs.push(dataDir)
  return RyAgentServer.create({ port: 0, dataDir, memory: null, evolution: null })
}

async function postJson(
  base: string,
  path: string,
  payload: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
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

describe('错误响应形状', () => {
  it('非法 JSON 是 400 + BAD_REQUEST（调用方的错）', async () => {
    const server = await startServer()
    try {
      const res = await postJson(server.url, '/api/conversations', '{ not json')
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('BAD_REQUEST')
    } finally {
      await server.close()
    }
  })

  it('校验不过的请求体是 400 + BAD_REQUEST，且消息仍可读', async () => {
    const server = await startServer()
    try {
      const res = await postJson(server.url, '/api/conversations', JSON.stringify({ kind: 'direct' }))
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('BAD_REQUEST')
      expect(String(res.body.error)).toContain('agentId')
    } finally {
      await server.close()
    }
  })

  it('未知路由是 404 + NOT_FOUND', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/api/nope`)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { code: string }).code).toBe('NOT_FOUND')
    } finally {
      await server.close()
    }
  })

  it('落库失败是 500 + INTERNAL，不再伪装成 400', async () => {
    const server = await startServer()
    try {
      // 关掉 SQLite 制造一次真实的写失败：请求体本身完全合法。
      server.store.close()
      const res = await postJson(server.url, '/api/conversations', JSON.stringify({ kind: 'direct', agentId: 'ryen' }))
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('INTERNAL')
    } finally {
      await server.close().catch(() => {})
    }
  })
})
