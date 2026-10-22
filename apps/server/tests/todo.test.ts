/**
 * 待办：存储持久化、并发写、工具语义与 HTTP 路由。
 *
 * 并发用例同时检查磁盘文件——只在内存里断言长度的话，最后一份 rename 覆盖掉
 * 前面所有条目也照样绿。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer, type TodoGroup } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createTodoTool, TodoError, TodoStore } from '../src/plugins/todo.ts'

const tmpDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-todo-${prefix}-`))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

function readTodos(path: string): { conversations: TodoGroup[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { conversations: TodoGroup[] }
}

describe('TodoStore', () => {
  it('增 / 查 / 勾选 / 清空，重开实例仍读得回来', async () => {
    const path = join(tempDir('store'), 'todos.json')
    const store = new TodoStore(path)
    expect(store.list('c1')).toEqual({ conversationId: 'c1', items: [] })
    expect(store.list('c2').items).toEqual([])

    await store.add('c1', '  买牛奶  ')
    const second = await store.add('c1', '交房租')
    const first = store.list('c1').items[0]
    expect(first).toMatchObject({ text: '买牛奶', done: false })

    await store.setDone('c1', first?.id as string)
    expect(store.list('c1').items[0]?.done).toBe(true)
    await store.setDone('c1', first?.id as string, false)
    expect(store.list('c1').items[0]?.done).toBe(false)

    // 另一个会话不串。
    await store.add('c2', '给妈妈打电话')
    expect(store.list('c1').items).toHaveLength(2)
    expect(store.list('c2').items).toHaveLength(1)

    const reopened = new TodoStore(path)
    expect(reopened.list('c1').items.map((item) => item.text)).toEqual(['买牛奶', '交房租'])
    expect(reopened.list('c2').items.map((item) => item.text)).toEqual(['给妈妈打电话'])

    await reopened.clear('c1')
    expect(reopened.list('c1').items).toEqual([])
    expect(reopened.list('c2').items).toHaveLength(1)
    // 清空只删目标会话，文件里另一个会话原样保留。
    expect(readTodos(path).conversations.map((group) => group.conversationId)).toEqual(['c2'])
    expect(second.items).toHaveLength(2)
  })

  it('并发 add 串行落盘：每一条都在内存与文件里，且文件始终是完整 JSON', async () => {
    const path = join(tempDir('concurrent'), 'todos.json')
    const store = new TodoStore(path)
    const texts = Array.from({ length: 24 }, (_, index) => {
      return `第 ${index} 件`
    })
    await Promise.all(
      texts.map((text) => {
        return store.add('c1', text)
      }),
    )
    expect(
      store
        .list('c1')
        .items.map((item) => item.text)
        .sort(),
    ).toEqual([...texts].sort())
    const onDisk = readTodos(path)
    expect(onDisk.conversations).toHaveLength(1)
    expect(onDisk.conversations[0]?.items.map((item) => item.text).sort()).toEqual([...texts].sort())
    // 原子写的临时文件不该留到下一次启动。
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('无效入参有码，未知待办 404 语义', async () => {
    const store = new TodoStore(join(tempDir('errors'), 'todos.json'))
    expect(() => store.add('c1', '   ')).toThrow(TodoError)
    expect(() => store.list('')).toThrow(TodoError)
    await expect(store.setDone('c1', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('todo 工具', () => {
  it('按 ToolContext.conversationId 分组；add/list/toggle/clear 返回清单', async () => {
    const store = new TodoStore(join(tempDir('tool'), 'todos.json'))
    const tool = createTodoTool(store)
    const context = { workspaceRoot: tempDir('workspace'), conversationId: 'c-a' }

    const empty = await tool.execute({ action: 'list' }, context)
    expect(empty.isError).not.toBe(true)
    expect(empty.content).toContain('还没有待办')

    for (const text of ['买牛奶', '交房租', '给妈妈打电话']) {
      const added = await tool.execute({ action: 'add', text }, context)
      expect(added.isError).not.toBe(true)
      expect(added.content).toContain(text)
    }
    const listed = await tool.execute({ action: 'list' }, context)
    expect(listed.content).toContain('共 3 项')
    const id = store.list('c-a').items[1]?.id as string
    const toggled = await tool.execute({ action: 'toggle', id }, context)
    expect(toggled.content).toContain('已标记完成')
    expect(store.list('c-a').items[1]?.done).toBe(true)

    // 另一个会话看不到这三条。
    expect((await tool.execute({ action: 'list' }, { ...context, conversationId: 'c-b' })).content).toContain(
      '还没有待办',
    )
    const cleared = await tool.execute({ action: 'clear' }, context)
    expect(cleared.content).toContain('已清空')
    expect(store.list('c-a').items).toEqual([])
  })

  it('没有会话上下文 / 未知 action / 空文本都回工具错误而不是抛异常', async () => {
    const store = new TodoStore(join(tempDir('tool-errors'), 'todos.json'))
    const tool = createTodoTool(store)
    const context = { workspaceRoot: tempDir('workspace'), conversationId: 'c1' }
    expect(await tool.execute({ action: 'add', text: 'x' }, { workspaceRoot: context.workspaceRoot })).toMatchObject({
      isError: true,
    })
    expect(await tool.execute({ action: 'nope' }, context)).toMatchObject({ isError: true })
    expect(await tool.execute({ action: 'add', text: '  ' }, context)).toMatchObject({ isError: true })
    expect(await tool.execute({ action: 'toggle', id: 'missing' }, context)).toMatchObject({ isError: true })
  })
})

describe('GET/PATCH/DELETE /api/todos', () => {
  it('鉴权、校验与勾选：工具写入的条目路由读得到，清空后文件也空', async () => {
    const dataDir = tempDir('api')
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir,
      memory: null,
      evolution: null,
      proactive: false,
      authToken: 'todo-api-token',
    })
    const conversation = server.store.createConversation({
      kind: 'direct',
      title: '待办 API',
      memberAgentIds: ['ryen'],
    })
    const auth = { authorization: 'Bearer todo-api-token' }
    const path = `/api/todos?conversationId=${encodeURIComponent(conversation.id)}`
    try {
      expect((await fetch(`${server.url}${path}`)).status).toBe(401)
      const missing = await fetch(`${server.url}/api/todos`, { headers: auth })
      expect(missing.status).toBe(400)
      const unknown = await fetch(`${server.url}/api/todos?conversationId=nope`, { headers: auth })
      expect(unknown.status).toBe(404)
      expect(((await unknown.json()) as { code: string }).code).toBe('TODO_UNKNOWN_CONVERSATION')

      const tool = server.tools.get('todo')
      expect(tool).toBeDefined()
      await tool?.execute(
        { action: 'add', text: '买牛奶' },
        { workspaceRoot: server.workspaceRoot, conversationId: conversation.id },
      )
      await tool?.execute(
        { action: 'add', text: '交房租' },
        { workspaceRoot: server.workspaceRoot, conversationId: conversation.id },
      )

      const listed = await fetch(`${server.url}${path}`, { headers: auth })
      expect(listed.status).toBe(200)
      const group = (await listed.json()) as TodoGroup
      expect(group.items.map((item) => item.text)).toEqual(['买牛奶', '交房租'])

      const id = group.items[0]?.id as string
      const patched = await fetch(`${server.url}/api/todos/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id, done: true }),
      })
      expect(patched.status).toBe(200)
      expect(((await patched.json()) as TodoGroup).items[0]?.done).toBe(true)

      const badDone = await fetch(`${server.url}/api/todos/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id, done: 'yes' }),
      })
      expect(badDone.status).toBe(400)

      const missingItem = await fetch(`${server.url}/api/todos/nope`, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.id, done: true }),
      })
      expect(missingItem.status).toBe(404)
      expect(((await missingItem.json()) as { code: string }).code).toBe('TODO_NOT_FOUND')

      const cleared = await fetch(`${server.url}${path}`, { method: 'DELETE', headers: auth })
      expect(cleared.status).toBe(200)
      expect(((await cleared.json()) as TodoGroup).items).toEqual([])
      expect(readTodos(join(dataDir, 'todos.json')).conversations).toEqual([])
    } finally {
      await server.close()
    }
  })
})
