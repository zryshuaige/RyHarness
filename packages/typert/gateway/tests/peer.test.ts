/**
 * JSON-RPC 对端：请求关联、超时、取消、断线。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryTransportPair, type JsonRpcNotification, JsonRpcPeer } from '../src/index.ts'

describe('JSON-RPC 对端', () => {
  it('请求能拿到回包', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide, {
      onRequest: (request) => `收到 ${request.method}`,
    })
    const client = new JsonRpcPeer(clientSide)
    await expect(client.request('ping', { n: 1 })).resolves.toBe('收到 ping')
    server.close()
  })

  it('回包按 id 对上号，两条并发请求不串', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide, {
      onRequest: async (request) => {
        const params = request.params as { delay: number; tag: string }
        await new Promise((resolve) => {
          setTimeout(resolve, params.delay)
        })
        return params.tag
      },
    })
    const client = new JsonRpcPeer(clientSide)
    const [slow, fast] = await Promise.all([
      client.request('m', { delay: 20, tag: '慢' }),
      client.request('m', { delay: 1, tag: '快' }),
    ])
    expect(slow).toBe('慢')
    expect(fast).toBe('快')
    server.close()
  })

  it('超时报 gateway/timeout', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide, {
      onRequest: () => new Promise(() => undefined),
    })
    const client = new JsonRpcPeer(clientSide)
    await expect(client.request('slow', undefined, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'gateway/timeout',
      details: { timeoutMs: 30 },
    })
    server.close()
  })

  it('取消报 gateway/cancelled', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide, {
      onRequest: () => new Promise(() => undefined),
    })
    const client = new JsonRpcPeer(clientSide)
    const controller = new AbortController()
    const pending = client.request('slow', undefined, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    server.close()
  })

  it('一开始就是取消过的信号，直接失败', async () => {
    const [clientSide] = createMemoryTransportPair()
    const client = new JsonRpcPeer(clientSide)
    const controller = new AbortController()
    controller.abort()
    await expect(client.request('x', undefined, { signal: controller.signal })).rejects.toMatchObject({
      code: 'gateway/cancelled',
    })
  })

  it('连接断了报 gateway/disconnected', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide, {
      onRequest: () => new Promise(() => undefined),
    })
    const client = new JsonRpcPeer(clientSide)
    const pending = client.request('slow')
    server.close()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/disconnected' })
  })

  it('通知不产生回包', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const seen: string[] = []
    const server = new JsonRpcPeer(serverSide, {
      onNotification: (notification: JsonRpcNotification) => {
        seen.push(notification.method)
      },
    })
    const client = new JsonRpcPeer(clientSide)
    client.notify('hello')
    expect(seen).toEqual(['hello'])
    server.close()
  })

  it('对端没有处理器时回「方法不存在」', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new JsonRpcPeer(serverSide)
    const client = new JsonRpcPeer(clientSide)
    await expect(client.request('nope')).rejects.toMatchObject({ rpcCode: -32601 })
    server.close()
  })
})
