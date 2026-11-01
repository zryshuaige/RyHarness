/**
 * 沙箱路由的接口面：模式清单、会话级覆盖的读写与报错。
 *
 * 这一族用例盯的是三件事：
 * - 模式清单要**带上隔离强度**（Windows 上的围栏不是内核边界，界面不能显示成同一种）。
 * - 覆盖写进去要读得回来，撤掉要真撤（回到助理档位，而不是留一个"看起来清了"的残留）。
 * - 非法输入报错，不静默忽略——静默忽略会让人以为已经收紧了权限。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-sandbox-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpSyncDir(), { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

function tmpSyncDir(): string {
  return tmpDirs.pop() as string
}

async function startServer(): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: tempDir(),
    memory: null,
    evolution: null,
    proactive: false,
  })
}

async function post(server: RyHarnessServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 建一个会话（拿它的 id 用来挂覆盖）。 */
async function createConversation(server: RyHarnessServer): Promise<string> {
  const response = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
  const body = (await response.json()) as { conversation: { id: string } }
  return body.conversation.id
}

describe('沙箱', () => {
  it('模式清单由服务端给出：三种模式各带一句话与隔离强度', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/api/sandbox/modes`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        modes: Array<{ id: string; name: string; summary: string; strength: string; strengthNote: string }>
        workspaceRoot: string
      }
      expect(body.modes.map((mode) => mode.id)).toEqual(['read-only', 'workspace-write', 'full-access'])
      for (const mode of body.modes) {
        expect(mode.name.length).toBeGreaterThan(0)
        expect(mode.summary.length).toBeGreaterThan(0)
        // 强度必须说清楚：Windows 上是围栏，不是内核级隔离。
        expect(['kernel', 'fence']).toContain(mode.strength)
        expect(mode.strengthNote.length).toBeGreaterThan(0)
      }
      expect(body.workspaceRoot.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('会话覆盖写进去读得回来', async () => {
    const server = await startServer()
    try {
      const conversationId = await createConversation(server)
      const set = await post(server, `/api/sandbox/conversations/${conversationId}`, { mode: 'read-only' })
      expect(set.status).toBe(200)
      const setBody = (await set.json()) as { override: string | null }
      expect(setBody.override).toBe('read-only')

      const read = await fetch(`${server.url}/api/sandbox/conversations/${conversationId}`)
      const readBody = (await read.json()) as { override: string | null }
      expect(readBody.override).toBe('read-only')
    } finally {
      await server.close()
    }
  })

  it('传 null 撤掉覆盖：回到助理自己的档位，而不是留一个残留', async () => {
    const server = await startServer()
    try {
      const conversationId = await createConversation(server)
      await post(server, `/api/sandbox/conversations/${conversationId}`, { mode: 'full-access' })
      const cleared = await post(server, `/api/sandbox/conversations/${conversationId}`, { mode: null })
      expect(cleared.status).toBe(200)
      const clearedBody = (await cleared.json()) as { override: string | null }
      expect(clearedBody.override).toBeNull()

      const read = await fetch(`${server.url}/api/sandbox/conversations/${conversationId}`)
      const readBody = (await read.json()) as { override: string | null }
      expect(readBody.override).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('非法模式报 400 并带机器码，不静默忽略', async () => {
    const server = await startServer()
    try {
      const conversationId = await createConversation(server)
      const response = await post(server, `/api/sandbox/conversations/${conversationId}`, { mode: 'whatever' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: string; code: string }
      expect(body.code).toBe('SANDBOX_BAD_MODE')
      // 没写进去就不该算数。
      const read = await fetch(`${server.url}/api/sandbox/conversations/${conversationId}`)
      const readBody = (await read.json()) as { override: string | null }
      expect(readBody.override).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('会话不存在报 404', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/sandbox/conversations/no-such-conversation', { mode: 'read-only' })
      expect(response.status).toBe(404)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('SANDBOX_UNKNOWN_CONVERSATION')
    } finally {
      await server.close()
    }
  })

  it('覆盖一览：所有设过的会话都在，撤掉的不在', async () => {
    const server = await startServer()
    try {
      const first = await createConversation(server)
      const second = await createConversation(server)
      await post(server, `/api/sandbox/conversations/${first}`, { mode: 'read-only' })
      await post(server, `/api/sandbox/conversations/${second}`, { mode: 'workspace-write' })
      await post(server, `/api/sandbox/conversations/${second}`, { mode: null })

      const response = await fetch(`${server.url}/api/sandbox/overrides`)
      const body = (await response.json()) as { overrides: Record<string, string> }
      expect(body.overrides[first]).toBe('read-only')
      expect(body.overrides[second]).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
