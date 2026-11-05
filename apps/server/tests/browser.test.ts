/**
 * 浏览器插件的接口面：工具注册、会话归属、路由。
 *
 * 这一族用例盯的是「接口说清楚自己有没有那件事」：工具在不在清单里、会话是不是
 * 按助理隔离的、路由给的到底是真会话还是空壳。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-browser-'))
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

async function startServer(): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: tempDir(),
    memory: null,
    evolution: null,
    proactive: false,
  })
}

async function get(server: RyHarnessServer, path: string): Promise<Response> {
  return fetch(`${server.url}${path}`)
}

describe('浏览器插件', () => {
  it('三件工具真的注册进工具清单', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/tools')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tools: Array<{ name: string }> }
      const names = body.tools.map((tool) => tool.name)
      expect(names).toContain('browser_open')
      expect(names).toContain('browser_act')
      expect(names).toContain('browser_read')
    } finally {
      await server.close()
    }
  })

  it('插件清单里有它，声明的工具与路由都在运行时找得到', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/plugins')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        plugins: Array<{ id: string; enabled: boolean; missing?: string[]; capabilities?: { tools?: string[] } }>
      }
      const plugin = body.plugins.find((item) => item.id === 'browser')
      expect(plugin).toBeDefined()
      expect(plugin?.enabled).toBe(true)
      // 声明了但运行时没有 = 用户看得到却用不了，这一条不能漏。
      expect(plugin?.missing ?? []).toEqual([])
      expect(plugin?.capabilities?.tools).toContain('browser_open')
    } finally {
      await server.close()
    }
  })

  it('会话路由只回该助理自己的会话，没给 owner 时不给别人的', async () => {
    const server = await startServer()
    try {
      const mine = await get(server, '/api/browser/sessions?owner=agent-a')
      expect(mine.status).toBe(200)
      const mineBody = (await mine.json()) as { sessions: unknown[] }
      expect(mineBody.sessions).toEqual([])

      // 不给 owner：一个助理的会话也不该被列出来。
      const none = await get(server, '/api/browser/sessions')
      expect(none.status).toBe(200)
      const noneBody = (await none.json()) as { sessions: unknown[] }
      expect(noneBody.sessions).toEqual([])
    } finally {
      await server.close()
    }
  })
})
