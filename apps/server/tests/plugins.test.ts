/**
 * 插件底座：装配顺序、真实挂载/卸载、core 不可关、开关持久化与鉴权。
 *
 * 这些用例刻意走 HTTP 与真实 cordis fiber：只断言配置文件被改写的话，把
 * `ctx.plugin()` 换成 `states.set()` 也照样绿——而那正是要防的退化。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { PluginEntry, ProvidersConfigFile } from '@ryharness/server'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-plugins-'))
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

function probeTool(id: string): Tool {
  return {
    name: `probe_${id}`,
    description: `${id} probe`,
    parameters: { type: 'object', properties: {} },
    execute: () => {
      return Promise.resolve({ content: id })
    },
  }
}

/** 探针插件：注册一个工具，并把 apply/dispose 记进 order。 */
function probePlugin(id: string, order: string[], core = false): PluginEntry {
  return {
    id,
    name: `探针 ${id}`,
    description: `${id} 的测试插件`,
    core,
    inject: ['tools'],
    apply: (ctx: Context) => {
      order.push(`apply:${id}`)
      ctx.tools.register(probeTool(id))
      ctx.effect(() => {
        return () => {
          order.push(`dispose:${id}`)
        }
      })
    },
  }
}

async function start(extra: {
  plugins?: readonly PluginEntry[]
  authToken?: string
  providersConfig?: ProvidersConfigFile
}): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: dataDir(),
    memory: null,
    evolution: null,
    providersConfig: { providers: {} },
    ...(extra.plugins === undefined ? {} : { plugins: extra.plugins }),
    ...(extra.authToken === undefined ? {} : { authToken: extra.authToken }),
    ...(extra.providersConfig === undefined ? {} : { providersConfig: extra.providersConfig }),
  })
}

async function getJson(
  server: RyHarnessServer,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function patchJson(
  server: RyHarnessServer,
  path: string,
  payload: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface PluginRow {
  id: string
  name: string
  description: string
  group?: string
  capabilities?: { tools?: string[]; routes?: string[] }
  /** 声明里有、运行时却查不到的能力。 */
  missing?: string[]
  impact?: string
  enabled: boolean
  core: boolean
  status: string
}

function rows(body: Record<string, unknown>): PluginRow[] {
  return body.plugins as PluginRow[]
}

describe('插件装配', () => {
  it('能力声明与运行时事实对不上时，差集如实列出', async () => {
    // 声明是给人看的，注册表才是事实。两者对不上时把差的那几项点出来，而不是
    // 照着声明显示一个其实并不存在的能力。
    const server = await start({
      plugins: [
        {
          id: 'liar',
          name: '说谎的插件',
          description: '声明了它其实没有的工具与路由',
          capabilities: { tools: ['probe_here', 'probe_gone'], routes: ['GET /api/nope'] },
          inject: ['tools'],
          apply: (ctx: Context) => {
            ctx.tools.register(probeTool('here'))
          },
        },
      ],
    })
    try {
      const view = rows((await getJson(server, '/api/plugins')).body).find((row) => {
        return row.id === 'liar'
      })
      expect(view?.missing).toContain('probe_gone')
      expect(view?.missing).toContain('GET /api/nope')
      // 真的注册上了的那个不算差。
      expect(view?.missing).not.toContain('probe_here')

      // 关掉的插件工具本就不在注册表里——那不是「声明错了」，不该报差集。
      const off = await patchJson(server, '/api/plugins/liar', { enabled: false })
      expect(off.status).toBe(200)
      const stopped = rows((await getJson(server, '/api/plugins')).body).find((row) => {
        return row.id === 'liar'
      })
      expect(stopped?.missing).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('内置 core-tools 注册四个工具，llm-openai 装载默认供应商路由', async () => {
    const server = await start({
      providersConfig: {
        providers: {
          demo: { baseURL: 'https://example.test/v1', apiKey: 'test-key', models: [{ id: 'demo-model' }] },
        },
      },
    })
    try {
      for (const name of ['fs_read', 'fs_write', 'shell_exec', 'file_produce']) {
        expect(server.tools.get(name)).toBeDefined()
      }
      // 走的是 llm-openai 的 apply：手工挂载路径在 server 上只保留「零路由后补挂」。
      expect(server.llm.listProviders().map((provider) => provider.id)).toContain('demo')
      const { status, body } = await getJson(server, '/api/plugins')
      expect(status).toBe(200)
      const list = rows(body)
      expect(
        list.map((row) => {
          return row.id
        }),
      ).toEqual([
        'core-tools',
        'llm-openai',
        'voice',
        'voice-piper',
        'voice-minimax',
        'todo',
        'ask-user',
        'grill-me',
        'web-read',
        'mcp',
        'subagent',
      ])
      // 两个 core 恒开；其余是非 core，默认开着但可以在设置里关。
      expect(
        list
          .filter((row) => {
            return row.core
          })
          .map((row) => {
            return row.id
          }),
      ).toEqual(['core-tools', 'llm-openai'])
      expect(
        list
          .filter((row) => {
            return !row.core
          })
          .map((row) => {
            return row.id
          }),
      ).toEqual([
        'voice',
        'voice-piper',
        'voice-minimax',
        'todo',
        'ask-user',
        'grill-me',
        'web-read',
        'mcp',
        'subagent',
      ])
      expect(list.every((row) => row.enabled && row.status === 'running')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('GET /api/plugins 返回分组、能力清单与关闭影响，十一个内置插件齐全', async () => {
    const server = await start({})
    try {
      const { status, body } = await getJson(server, '/api/plugins')
      expect(status).toBe(200)
      const list = rows(body)
      expect(list).toHaveLength(11)
      expect(
        list.map((row) => {
          return row.group
        }),
      ).toEqual(['core', 'core', 'voice', 'voice', 'voice', 'feature', 'feature', 'feature', 'tool', 'tool', 'feature'])
      expect(
        list.every((row) => {
          return typeof row.impact === 'string' && row.impact.length > 0
        }),
      ).toBe(true)
      const byId = new Map(
        list.map((row) => {
          return [row.id, row]
        }),
      )
      expect(byId.get('core-tools')?.capabilities).toEqual({
        tools: ['fs_read', 'fs_write', 'fs_glob', 'fs_grep', 'fs_edit', 'shell_exec', 'file_produce'],
      })
      expect(byId.get('voice')?.capabilities).toEqual({
        routes: ['GET /api/voice/catalog', 'POST /api/voice/speak'],
      })
      expect(byId.get('voice-piper')).toMatchObject({
        name: 'Voice Piper',
        group: 'voice',
        capabilities: {
          routes: ['POST /api/voice/engines/piper/install', 'GET /api/voice/engines/piper/status'],
        },
        impact: '关闭后离线音色不可用，云端与系统语音不受影响。',
      })
      expect(byId.get('voice-piper')?.description).toContain('离线')
      expect(byId.get('todo')?.capabilities).toEqual({
        tools: ['todo'],
        routes: ['GET /api/todos', 'PATCH /api/todos/:id', 'DELETE /api/todos', 'POST /api/todos/restore'],
      })
      expect(byId.get('ask-user')?.capabilities).toEqual({
        tools: ['ask_user'],
        routes: ['GET /api/questions', 'POST /api/questions/:id/answer'],
      })
      expect(byId.get('web-read')?.capabilities).toEqual({ tools: ['read_url'] })
      expect(byId.get('llm-openai')?.capabilities).toEqual({})
      expect(byId.get('ask-user')?.impact).toContain('已有的问题记录保留')
    } finally {
      await server.close()
    }
  })

  it('plugins 选项按顺序装载，关闭时逆序卸载', async () => {
    const order: string[] = []
    const server = await start({ plugins: [probePlugin('a', order), probePlugin('b', order)] })
    try {
      expect(order).toEqual(['apply:a', 'apply:b'])
      expect(server.tools.get('probe_a')).toBeDefined()
      expect(server.tools.get('probe_b')).toBeDefined()
    } finally {
      await server.close()
    }
    expect(order.filter((entry) => entry.startsWith('dispose:'))).toEqual(['dispose:b', 'dispose:a'])
  })
})

describe('插件开关', () => {
  it('PATCH 真实卸载/重挂：注册表里的工具随之消失与回来', async () => {
    const order: string[] = []
    const server = await start({ plugins: [probePlugin('a', order)] })
    try {
      const off = await patchJson(server, '/api/plugins/a', { enabled: false })
      expect(off.status).toBe(200)
      const offRow = off.body.plugin as PluginRow
      expect(offRow).toMatchObject({ id: 'a', enabled: false, status: 'stopped' })
      expect(server.tools.get('probe_a')).toBeUndefined()
      expect(order.filter((entry) => entry === 'dispose:a')).toHaveLength(1)

      // 落盘的是开关，不是一次性的运行态。
      const saved = JSON.parse(readFileSync(join(server.dataDir, 'config', 'plugins.json'), 'utf8')) as Record<
        string,
        { enabled: boolean }
      >
      expect(saved.a).toEqual({ enabled: false })

      const on = await patchJson(server, '/api/plugins/a', { enabled: true })
      expect(on.status).toBe(200)
      expect((on.body.plugin as PluginRow).status).toBe('running')
      expect(server.tools.get('probe_a')).toBeDefined()
      expect(order.filter((entry) => entry === 'apply:a')).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it('core 插件不可关：403 CORE_PLUGIN，工具原样保留', async () => {
    const server = await start({})
    try {
      const response = await patchJson(server, '/api/plugins/core-tools', { enabled: false })
      expect(response.status).toBe(403)
      expect(response.body.code).toBe('CORE_PLUGIN')
      expect(server.tools.get('fs_read')).toBeDefined()
      const { body } = await getJson(server, '/api/plugins')
      expect(rows(body).find((row) => row.id === 'core-tools')?.enabled).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('未知插件 404，非布尔开关 400', async () => {
    const server = await start({})
    try {
      expect((await patchJson(server, '/api/plugins/nope', { enabled: true })).status).toBe(404)
      expect((await patchJson(server, '/api/plugins/core-tools', { enabled: 'yes' })).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('plugins.json 里关掉的非 core 插件启动后保持关闭，缺省条目视为启用', async () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'plugins.json'), JSON.stringify({ a: { enabled: false } }), 'utf8')
    const order: string[] = []
    const server = await RyHarnessServer.create({
      port: 0,
      dataDir: dir,
      memory: null,
      evolution: null,
      providersConfig: { providers: {} },
      plugins: [probePlugin('a', order), probePlugin('b', order)],
    })
    try {
      // 启动时 a 没 apply、b 按缺省启用；之后 PATCH 仍能真实挂上 a。
      expect(order).toEqual(['apply:b'])
      expect(server.tools.get('probe_a')).toBeUndefined()
      expect(server.tools.get('probe_b')).toBeDefined()
      const { body } = await getJson(server, '/api/plugins')
      expect(rows(body).find((row) => row.id === 'a')).toMatchObject({ enabled: false, status: 'stopped' })
      expect(rows(body).find((row) => row.id === 'b')).toMatchObject({ enabled: true, status: 'running' })

      const on = await patchJson(server, '/api/plugins/a', { enabled: true })
      expect(on.status).toBe(200)
      expect(server.tools.get('probe_a')).toBeDefined()
    } finally {
      await server.close()
    }
  })
})

describe('插件路由鉴权', () => {
  it('不带 token 的 GET/PATCH 一律 401，带 token 放行', async () => {
    const token = 'plugin-route-token-7c1f'
    const order: string[] = []
    const server = await start({ authToken: token, plugins: [probePlugin('a', order)] })
    try {
      expect((await getJson(server, '/api/plugins')).status).toBe(401)
      expect((await patchJson(server, '/api/plugins/a', { enabled: false })).status).toBe(401)
      expect((await getJson(server, '/api/plugins', token)).status).toBe(200)
      expect((await patchJson(server, '/api/plugins/a', { enabled: false }, token)).status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('插件自带路由', () => {
  it('voice 关闭后 catalog / speak 一起 404，重新打开恢复 200', async () => {
    const server = await start({})
    try {
      expect((await getJson(server, '/api/voice/catalog')).status).toBe(200)

      const off = await patchJson(server, '/api/plugins/voice', { enabled: false })
      expect(off.status).toBe(200)
      expect((off.body.plugin as PluginRow).status).toBe('stopped')
      expect((await getJson(server, '/api/voice/catalog')).status).toBe(404)
      const speak = await fetch(`${server.url}/api/voice/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好', profileId: 'sf-cosyvoice2-anna' }),
      })
      expect(speak.status).toBe(404)

      const on = await patchJson(server, '/api/plugins/voice', { enabled: true })
      expect(on.status).toBe(200)
      expect((await getJson(server, '/api/voice/catalog')).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('todo 关闭后工具与路由一起消失，重新打开都回来', async () => {
    const server = await start({})
    const conversation = server.store.createConversation({
      kind: 'direct',
      title: '待办测试',
      memberAgentIds: ['ryen'],
    })
    const path = `/api/todos?conversationId=${encodeURIComponent(conversation.id)}`
    try {
      expect(server.tools.get('todo')).toBeDefined()
      const initial = await getJson(server, path)
      expect(initial.status).toBe(200)
      expect(initial.body).toMatchObject({ conversationId: conversation.id, items: [] })

      const off = await patchJson(server, '/api/plugins/todo', { enabled: false })
      expect(off.status).toBe(200)
      expect(server.tools.get('todo')).toBeUndefined()
      expect((await getJson(server, path)).status).toBe(404)
      // 只关了 todo：voice 的路由与工具底座不受影响。
      expect(server.tools.get('fs_read')).toBeDefined()
      expect((await getJson(server, '/api/voice/catalog')).status).toBe(200)

      const on = await patchJson(server, '/api/plugins/todo', { enabled: true })
      expect(on.status).toBe(200)
      expect(server.tools.get('todo')).toBeDefined()
      expect((await getJson(server, path)).status).toBe(200)
    } finally {
      await server.close()
    }
  })
})
