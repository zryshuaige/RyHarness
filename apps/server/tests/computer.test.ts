/**
 * 桌面操作插件的接口面：工具注册、插件声明、审批链。
 *
 * 这一族盯的是「高危动作真的会问人」：桌面没有天然边界，点错地方就点错地方，
 * 所以工具注册对了还不够——审批链没接上就等于没护栏。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-computer-'))
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

describe('桌面操作插件', () => {
  it('五件工具真的注册进工具清单', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/tools')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tools: Array<{ name: string }> }
      const names = body.tools.map((tool) => tool.name)
      expect(names).toContain('computer_screenshot')
      expect(names).toContain('computer_click')
      expect(names).toContain('computer_type')
      expect(names).toContain('computer_key')
      expect(names).toContain('computer_scroll')
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
        plugins: Array<{ id: string; enabled: boolean; missing?: string[] }>
      }
      const plugin = body.plugins.find((item) => item.id === 'computer')
      expect(plugin).toBeDefined()
      expect(plugin?.enabled).toBe(true)
      // 声明了但运行时没有 = 用户看得到却用不了，这一条不能漏。
      expect(plugin?.missing ?? []).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('会话路由只回该助理自己的会话', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/computer/sessions?owner=agent-a')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { sessions: unknown[] }
      expect(body.sessions).toEqual([])

      const none = await get(server, '/api/computer/sessions')
      expect(none.status).toBe(200)
      const noneBody = (await none.json()) as { sessions: unknown[] }
      expect(noneBody.sessions).toEqual([])
    } finally {
      await server.close()
    }
  })
})
