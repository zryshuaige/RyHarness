/**
 * 新一批能力的服务端接口面：工具清单、斜杠命令、计划审批、溢出文本。
 *
 * 这一族用例盯的是「接口说清楚自己有没有那件事」：清单给出的是**真正注册着的**
 * 工具，计划批不了就说没有计划，取不到就说取不到——不返回空数组糊弄过去。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-caps-'))
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

async function post(server: RyHarnessServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('工具清单', () => {
  it('给出当前真正注册着的工具：名字与说明', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/tools')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { tools: Array<{ name: string; description: string }> }
      const names = body.tools.map((tool) => tool.name)
      expect(names).toContain('fs_read')
      expect(names).toContain('web_search')
      expect(names).toContain('skill')
      expect(names).toContain('spill_read')
      for (const tool of body.tools) {
        expect(typeof tool.name).toBe('string')
        expect(typeof tool.description).toBe('string')
      }
    } finally {
      await server.close()
    }
  })
})

describe('斜杠命令', () => {
  it('清单给出命令名与说明', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/commands')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { commands: Array<{ name: string; description: string }> }
      const names = body.commands.map((command) => command.name)
      expect(names).toContain('help')
    } finally {
      await server.close()
    }
  })

  it('跑一条命令：回正文，且说清跑的是哪条', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/commands/execute', { line: '/help' })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { text: string; ran: boolean; name: string; isError?: boolean }
      expect(body.ran).toBe(true)
      expect(body.name).toBe('help')
      expect(body.text).toContain('/help')
    } finally {
      await server.close()
    }
  })

  it('不是命令的行不硬跑：回 400 与机器码', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/commands/execute', { line: '今天天气不错' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('NOT_A_COMMAND')
    } finally {
      await server.close()
    }
  })

  it('命令名没注册：回 404，不是 400（那是「敲错了」的意思）', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/commands/execute', { line: '/not-registered' })
      expect(response.status).toBe(404)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('UNKNOWN_COMMAND')
    } finally {
      await server.close()
    }
  })
})

describe('计划审批', () => {
  it('没有计划时状态是 none，批它回 404', async () => {
    const server = await startServer()
    try {
      const created = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const createdBody = (await created.json()) as { conversation: { id: string } }
      const conversationId = createdBody.conversation.id

      const read = await get(server, `/api/plans/${conversationId}`)
      expect(read.status).toBe(200)
      const readBody = (await read.json()) as { status: string; plan: unknown }
      expect(readBody.status).toBe('none')
      expect(readBody.plan).toBeNull()

      const approve = await post(server, `/api/plans/${conversationId}/approve`, {})
      expect(approve.status).toBe(404)
      const approveBody = (await approve.json()) as { code: string }
      expect(approveBody.code).toBe('PLAN_NOT_FOUND')
    } finally {
      await server.close()
    }
  })

  it('会话不存在回 404', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/plans/no-such-conversation')
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('能力预设', () => {
  it('清单由内置模板生成：每份预设都有工具清单', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/agent-presets')
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        presets: Array<{ id: string; name: string; description: string; tools: string[] }>
      }
      expect(body.presets.length).toBeGreaterThan(0)
      for (const preset of body.presets) {
        expect(preset.description.length).toBeGreaterThan(0)
      }
      // 至少有一份是带工具的（纯聊天的那种模板工具清单是空的，那是它的本意）。
      expect(body.presets.some((preset) => preset.tools.length > 0)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('给一位助理选一套能力：工具白名单换成预设那份，并记一版', async () => {
    const server = await startServer()
    try {
      const presets = (await (await get(server, '/api/agent-presets')).json()) as {
        presets: Array<{ id: string; tools: string[] }>
      }
      const preset = presets.presets[0]
      expect(preset).toBeDefined()

      const created = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      expect(created.status).toBe(201)

      const response = await post(server, '/api/agents/ryen/preset', { presetId: preset?.id })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        agent: { tools: string[] }
        revision: { revision: number; presetId: string }
      }
      expect(body.agent.tools).toEqual(preset?.tools)
      expect(body.revision.revision).toBe(1)
      expect(body.revision.presetId).toBe(preset?.id)
    } finally {
      await server.close()
    }
  })

  it('预设 id 不存在回 404，不静默忽略', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/agents/ryen/preset', { presetId: 'nope' })
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('溢出文本', () => {
  it('取一个不存在的定位符回 404，而不是空串', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/spills/no-such-spill')
      expect(response.status).toBe(404)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('NOT_FOUND')
    } finally {
      await server.close()
    }
  })
})
