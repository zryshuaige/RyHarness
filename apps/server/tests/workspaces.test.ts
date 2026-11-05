/**
 * 工作区的接口面：清单、新建、会话归属，以及**归属真的改变了工具的文件边界**。
 *
 * 最后一族用例是这一族的核心：光看接口返回 200 不算「工作区能用」——助理在
 * 别的项目里干活时，工具读写文件的边界必须真的跟着走。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-ws-'))
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

async function patch(server: RyHarnessServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('工作区', () => {
  it('清单一开始是空的', async () => {
    const server = await startServer()
    try {
      const response = await get(server, '/api/workspaces')
      expect(response.status).toBe(200)
      const body = (await response.json()) as { workspaces: unknown[]; ungroupedSessionCount: number }
      expect(body.workspaces).toEqual([])
      expect(body.ungroupedSessionCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('新建一个工作区：名字与根目录都记下来', async () => {
    const server = await startServer()
    try {
      const root = tempDir()
      const created = await post(server, '/api/workspaces', { name: '我的项目', rootPath: root })
      expect(created.status).toBe(201)
      const createdBody = (await created.json()) as {
        workspace: { id: string; name: string; rootPath: string; rootExists: boolean }
      }
      expect(createdBody.workspace.name).toBe('我的项目')
      expect(createdBody.workspace.rootPath).toBe(root)
      expect(createdBody.workspace.rootExists).toBe(true)

      const listed = await get(server, '/api/workspaces')
      const listedBody = (await listed.json()) as { workspaces: Array<{ id: string }> }
      expect(listedBody.workspaces).toHaveLength(1)
      expect(listedBody.workspaces[0]?.id).toBe(createdBody.workspace.id)
    } finally {
      await server.close()
    }
  })

  it('根目录不存在回 400 并说清，不静默忽略', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/workspaces', {
        name: '不存在的',
        rootPath: join(tempDir(), 'no-such-dir'),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('ROOT_NOT_FOUND')
    } finally {
      await server.close()
    }
  })

  it('缺名字或缺根目录都回 400', async () => {
    const server = await startServer()
    try {
      const noName = await post(server, '/api/workspaces', { rootPath: tempDir() })
      expect(noName.status).toBe(400)
      const noRoot = await post(server, '/api/workspaces', { name: 'x' })
      expect(noRoot.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('文件系统根不能当工作区（那等于把整台机器交给助理）', async () => {
    const server = await startServer()
    try {
      const response = await post(server, '/api/workspaces', { name: '整台机器', rootPath: 'C:\\' })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { code: string }
      expect(body.code).toBe('INVALID_ROOT')
    } finally {
      await server.close()
    }
  })

  it('把会话归到工作区：清单里显示它在那儿', async () => {
    const server = await startServer()
    try {
      const root = tempDir()
      const created = await post(server, '/api/workspaces', { name: '项目 A', rootPath: root })
      const createdBody = (await created.json()) as { workspace: { id: string } }
      const workspaceId = createdBody.workspace.id

      const conversation = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationBody = (await conversation.json()) as { conversation: { id: string } }
      const conversationId = conversationBody.conversation.id

      const assigned = await patch(server, `/api/conversations/${conversationId}/workspace`, { workspaceId })
      expect(assigned.status).toBe(200)
      const assignedBody = (await assigned.json()) as { workspaceId: string | null }
      expect(assignedBody.workspaceId).toBe(workspaceId)

      const listed = await get(server, '/api/workspaces')
      const listedBody = (await listed.json()) as {
        workspaces: Array<{ id: string; sessionCount: number }>
        ungroupedSessionCount: number
      }
      const workspace = listedBody.workspaces.find((item) => item.id === workspaceId)
      expect(workspace?.sessionCount).toBe(1)
      expect(listedBody.ungroupedSessionCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('归属写进了会话行（重启后还在）', async () => {
    const dataDir = tempDir()
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    const root = tempDir()
    let conversationId = ''
    let workspaceId = ''
    try {
      const created = await post(server, '/api/workspaces', { name: '项目 B', rootPath: root })
      const createdBody = (await created.json()) as { workspace: { id: string } }
      workspaceId = createdBody.workspace.id
      const conversation = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationBody = (await conversation.json()) as { conversation: { id: string } }
      conversationId = conversationBody.conversation.id
      await patch(server, `/api/conversations/${conversationId}/workspace`, { workspaceId })
    } finally {
      await server.close()
    }

    // 重开一次：归属必须还在。
    const reopened = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
    })
    try {
      const listed = await get(reopened, '/api/workspaces')
      const listedBody = (await listed.json()) as {
        workspaces: Array<{ id: string; sessionCount: number }>
      }
      const workspace = listedBody.workspaces.find((item) => item.id === workspaceId)
      expect(workspace?.sessionCount).toBe(1)
    } finally {
      await reopened.close()
    }
  })

  it('摘出来：会话回到未分组', async () => {
    const server = await startServer()
    try {
      const created = await post(server, '/api/workspaces', { name: '项目 C', rootPath: tempDir() })
      const createdBody = (await created.json()) as { workspace: { id: string } }
      const conversation = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationBody = (await conversation.json()) as { conversation: { id: string } }
      const conversationId = conversationBody.conversation.id

      await patch(server, `/api/conversations/${conversationId}/workspace`, {
        workspaceId: createdBody.workspace.id,
      })
      const cleared = await patch(server, `/api/conversations/${conversationId}/workspace`, { workspaceId: null })
      expect(cleared.status).toBe(200)

      const listed = await get(server, '/api/workspaces')
      const listedBody = (await listed.json()) as {
        workspaces: Array<{ sessionCount: number }>
        ungroupedSessionCount: number
      }
      expect(listedBody.workspaces[0]?.sessionCount).toBe(0)
      expect(listedBody.ungroupedSessionCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('归到不存在的工作区回 404', async () => {
    const server = await startServer()
    try {
      const conversation = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationBody = (await conversation.json()) as { conversation: { id: string } }
      const response = await patch(server, `/api/conversations/${conversationBody.conversation.id}/workspace`, {
        workspaceId: 'no-such-workspace',
      })
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('会话不存在回 404', async () => {
    const server = await startServer()
    try {
      const response = await patch(server, '/api/conversations/no-such-conversation/workspace', {
        workspaceId: 'whatever',
      })
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('工具的文件边界真的跟着会话走：归到工作区后读得到那边的文件、读不到默认区的', async () => {
    const server = await startServer()
    try {
      // 默认工作区里放一个文件，工作区里放另一个。
      const defaultRoot = join(server.dataDir, 'workspace')
      mkdirSync(defaultRoot, { recursive: true })
      writeFileSync(join(defaultRoot, 'default.txt'), '默认区的内容', 'utf8')

      const projectRoot = tempDir()
      writeFileSync(join(projectRoot, 'project.txt'), '项目区的内容', 'utf8')

      const created = await post(server, '/api/workspaces', { name: '项目 D', rootPath: projectRoot })
      const createdBody = (await created.json()) as { workspace: { id: string } }
      const conversation = await post(server, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationBody = (await conversation.json()) as { conversation: { id: string } }
      const conversationId = conversationBody.conversation.id

      const tool = server.tools.get('fs_read')
      if (tool === undefined) throw new Error('fs_read 没有注册')

      // 归到工作区之前：读默认区的文件读得到。
      const before = await tool.execute({ path: 'default.txt' }, { workspaceRoot: defaultRoot, conversationId })
      expect(before.isError).toBeUndefined()
      expect(before.content).toContain('默认区的内容')

      // 归到工作区之后：工具的根目录换成工作区的根。
      await patch(server, `/api/conversations/${conversationId}/workspace`, {
        workspaceId: createdBody.workspace.id,
      })
      const resolved = server.turnEngine.resolveWorkspaceRoot(conversationId)
      expect(resolved).toBe(projectRoot)

      // 读工作区里的文件读得到；读默认区的读不到了（它在这个边界之外）。
      const after = await tool.execute({ path: 'project.txt' }, { workspaceRoot: resolved, conversationId })
      expect(after.isError).toBeUndefined()
      expect(after.content).toContain('项目区的内容')

      const outside = await tool.execute({ path: 'default.txt' }, { workspaceRoot: resolved, conversationId })
      expect(outside.isError).toBe(true)
    } finally {
      await server.close()
    }
  })
})
