/**
 * 插件路由注册表：注册/注销、冲突、大小写与方法匹配。
 *
 * 用例刻意走真实 HTTP 分发而不是只查 `list()`：真正的契约是「请求打得到/打不到」，
 * 只断言表里有几条记录的话，把 Router 的注销实现删掉也照样绿。
 */
import { createServer, type Server } from 'node:http'
import { Context } from '@ryharness/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { RouteRegistry } from '../src/plugins/routes.ts'
import { type Handler, json, Router } from '../src/router.ts'

const servers: Server[] = []

function okHandler(body: Record<string, unknown> = { ok: true }): Handler {
  return async (_req, res) => {
    json(res, 200, body)
  }
}

/** 起一个只做分发的回环服务；未命中统一回 404。 */
async function serve(router: Router): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void router
      .dispatch(req, res, url.pathname + url.search)
      .then((handled) => {
        if (!handled) json(res, 404, { error: 'not found', code: 'NOT_FOUND' })
      })
      .catch((error: unknown) => {
        if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        res.end()
      })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务没有拿到端口')
  return `http://127.0.0.1:${address.port}`
}

async function get(url: string, method = 'GET'): Promise<Response> {
  return fetch(url, { method })
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as Server
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
})

describe('RouteRegistry', () => {
  it('注册后真实分发；method 大小写不敏感，路径参数与 query 都到得了 handler', async () => {
    const ctx = new Context()
    await ctx.plugin(RouteRegistry)
    const router = new Router()
    router.get('/api/core', okHandler({ core: true }))
    ctx.routes.attach(router)
    const fiber = await ctx.plugin({
      name: 'route-probe',
      inject: ['routes'],
      apply: (inner: Context) => {
        inner.routes.register('get', '/api/demo/:id', async (req, res) => {
          json(res, 200, { method: req.method, id: req.params.id, q: req.query.get('q') })
        })
      },
    })
    const base = await serve(router)
    try {
      expect(ctx.routes.list().map((route) => `${route.method} ${route.pattern}`)).toEqual(['GET /api/demo/:id'])
      const response = await get(`${base}/api/demo/42?q=hi`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ method: 'GET', id: '42', q: 'hi' })
      // 同路径换方法不命中；方法必须真的参与匹配。
      expect((await get(`${base}/api/demo/42`, 'POST')).status).toBe(404)
      // 核心路由照常可达。
      expect((await get(`${base}/api/core`)).status).toBe(200)
    } finally {
      await fiber.dispose()
    }
  })

  it('插件卸载后它注册的路由从 Router 上消失；重新挂载又回来', async () => {
    const ctx = new Context()
    await ctx.plugin(RouteRegistry)
    const router = new Router()
    router.get('/api/core', okHandler({ core: true }))
    ctx.routes.attach(router)
    const base = await serve(router)
    const plugin = {
      name: 'route-probe',
      inject: ['routes'],
      apply: (inner: Context) => {
        inner.routes.register('GET', '/api/probe', okHandler({ mounted: true }))
      },
    }
    const first = await ctx.plugin(plugin)
    expect((await get(`${base}/api/probe`)).status).toBe(200)
    expect(ctx.routes.list()).toHaveLength(1)

    await first.dispose()
    expect((await get(`${base}/api/probe`)).status).toBe(404)
    expect(ctx.routes.list()).toEqual([])
    // 卸载一个插件不会误伤核心路由。
    expect((await get(`${base}/api/core`)).status).toBe(200)

    const second = await ctx.plugin(plugin)
    expect((await get(`${base}/api/probe`)).status).toBe(200)
    await second.dispose()
  })

  it('同 method+pattern 冲突显式报错：大小写与尾斜杠归一后仍算同一条', async () => {
    const ctx = new Context()
    await ctx.plugin(RouteRegistry)
    const router = new Router()
    router.get('/api/core', okHandler())
    ctx.routes.attach(router)

    const remove = ctx.routes.register('GET', '/api/dup', okHandler())
    expect(() => {
      ctx.routes.register('get', '/api/dup/', okHandler())
    }).toThrow(/already registered/)

    // 与核心路由冲突同样在注册那一刻报错，而不是静默覆盖掉核心 handler。
    expect(() => {
      ctx.routes.register('GET', '/api/core', okHandler())
    }).toThrow(/already registered/)

    // 同路径不同方法是两条合法的路由。
    const removePost = ctx.routes.register('POST', '/api/dup', okHandler())
    expect(ctx.routes.list().map((route) => route.method)).toEqual(['GET', 'POST'])
    remove()
    removePost()
    expect(ctx.routes.list()).toEqual([])
  })

  it('注销句柄幂等：重复调用不会删掉后来注册的同路径路由', async () => {
    const ctx = new Context()
    await ctx.plugin(RouteRegistry)
    const router = new Router()
    ctx.routes.attach(router)

    const removeFirst = ctx.routes.register('GET', '/api/again', okHandler({ version: 1 }))
    removeFirst()
    ctx.routes.register('GET', '/api/again', okHandler({ version: 2 }))
    removeFirst()
    const base = await serve(router)
    const response = await get(`${base}/api/again`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 2 })
    expect(ctx.routes.list()).toHaveLength(1)
  })
})
