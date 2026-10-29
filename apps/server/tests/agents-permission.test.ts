/**
 * 权限档位的接口面：档位清单、存档位、档位与工具清单的一致性。
 *
 * 一致性是这一族用例的核心：界面上写着「只读」、工具箱里却还挂着执行命令，
 * 是最坏的一种不一致——用户以为收窄了，其实没有。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-permission-'))
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

async function post(server: RyHarnessServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patch(server: RyHarnessServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('权限档位', () => {
  it('档位清单由服务端给出：id、名字、一句话与它放行的工具', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/api/permission-presets`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        presets: { id: string; name: string; summary: string; tools: string[] }[]
      }
      const ids = body.presets.map((preset) => {
        return preset.id
      })
      expect(ids).toContain('read-only')
      expect(ids).toContain('workspace-write')
      expect(ids).toContain('full-access')
      const readOnly = body.presets.find((preset) => {
        return preset.id === 'read-only'
      })
      expect(readOnly?.tools).not.toContain('shell_exec')
      expect(readOnly?.summary.length).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  it('新建时给档位：工具清单按档位收窄', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/agents', {
        name: '只读助理',
        systemPrompt: '你是助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: ['fs_read', 'fs_write', 'shell_exec', 'todo'],
        permissionPreset: 'read-only',
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as {
        agent: { tools: string[]; permissionPreset?: string }
      }
      expect(body.agent.permissionPreset).toBe('read-only')
      expect(body.agent.tools).toContain('fs_read')
      // 插件工具原样保留，内置工具按档位收窄。
      expect(body.agent.tools).toContain('todo')
      expect(body.agent.tools).not.toContain('fs_write')
      expect(body.agent.tools).not.toContain('shell_exec')
    } finally {
      await server.close()
    }
  })

  it('编辑时换档：按新档位重算工具清单', async () => {
    const server = await startServer()
    try {
      const created = await post(server, '/api/agents', {
        name: '换档助理',
        systemPrompt: '你是助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: ['fs_read'],
        permissionPreset: 'read-only',
      })
      const body = (await created.json()) as { agent: { id: string } }
      const updated = await patch(server, `/api/agents/${body.agent.id}`, {
        permissionPreset: 'full-access',
      })
      expect(updated.status).toBe(200)
      const after = (await updated.json()) as { agent: { tools: string[]; permissionPreset?: string } }
      expect(after.agent.permissionPreset).toBe('full-access')
      expect(after.agent.tools).toContain('shell_exec')
      expect(after.agent.tools).toContain('fs_write')
    } finally {
      await server.close()
    }
  })

  it('档位不认识时回 400，且不写库', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/agents', {
        name: '坏档位',
        systemPrompt: '你是助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: ['fs_read'],
        permissionPreset: 'whatever',
      })
      expect(response.status).toBe(400)
      const list = (await (await fetch(`${server.url}/api/agents`)).json()) as { agents: { name: string }[] }
      expect(
        list.agents.some((agent) => {
          return agent.name === '坏档位'
        }),
      ).toBe(false)
    } finally {
      await server.close()
    }
  })
})
