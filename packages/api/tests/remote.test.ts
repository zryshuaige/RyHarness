/**
 * Remote 层端到端：真起一个宿主与一个客户端（同一台机器、不同连接）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMemoryTransportPair,
  createRemoteHostServer,
  JSON_RPC_VERSION,
  RemoteClient,
  RemoteHost,
  type RemoteHostServer,
} from '../src/index.ts'
import { COUNTER_ANNOTATIONS, CounterService } from './helpers.ts'

/** 已经起好的服务，测完要收掉。 */
const opened: RemoteHostServer[] = []

afterEach(async () => {
  while (opened.length > 0) {
    const server = opened.pop()
    await server?.close()
  }
})

/** 起一个挂着计数服务的宿主。 */
async function startHost(): Promise<RemoteHostServer> {
  const host = new RemoteHost()
  host.mount({ namespace: 'counter', service: new CounterService(), methods: COUNTER_ANNOTATIONS })
  const server = await createRemoteHostServer({ host })
  opened.push(server)
  return server
}

describe('Remote 层端到端', () => {
  it('连上 → 调一个方法 → 拿到结果', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'add', [2, 3])).resolves.toBe(5)
    client.close()
  })

  it('客户端拿到的是宿主真实的类型图', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    expect(client.graph.namespaces).toEqual(['counter'])
    expect(client.graph.entries.map((entry) => entry.name).sort()).toEqual(['add', 'boom', 'echo', 'slow'])
    const add = client.graph.entries.find((entry) => entry.name === 'add')
    expect(add?.method.params.map((param) => `${param.name}: ${param.type}`)).toEqual(['a: number', 'b: number'])
    expect(add?.method.returns).toBe('number')
    client.close()
  })

  it('异步方法也拿得到结果', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'echo', ['你好'])).resolves.toBe('你好')
    client.close()
  })

  it('宿主那边抛错 → 客户端收到带机器码的失败', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'boom')).rejects.toMatchObject({
      code: 'gateway/internal',
      message: '炸了',
    })
    client.close()
  })

  it('调一个宿主没有的方法 → 客户端立刻报错', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'nope')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    client.close()
  })

  it('参数个数不对时宿主拒收', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'add', [1])).rejects.toMatchObject({ code: 'gateway/bad-request' })
    client.close()
  })

  it('超时报 gateway/timeout', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await expect(client.call('counter', 'slow', [500], { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'gateway/timeout',
    })
    client.close()
  })

  it('取消报 gateway/cancelled', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    const controller = new AbortController()
    const pending = client.call('counter', 'slow', [500], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    client.close()
  })

  it('宿主停服后客户端再调报断了', async () => {
    const server = await startHost()
    const client = await RemoteClient.connect({ port: server.port })
    await server.close()
    opened.pop()
    await expect(client.call('counter', 'add', [1, 2])).rejects.toMatchObject({ code: 'gateway/disconnected' })
  })

  it('连不上时直接失败，不留半截连接', async () => {
    await expect(RemoteClient.connect({ port: 1, connectTimeoutMs: 500 })).rejects.toThrowError(/连不上/)
  })

  it('同进程也能用：内存传输当连接', async () => {
    const host = new RemoteHost()
    host.mount({ namespace: 'counter', service: new CounterService(), methods: COUNTER_ANNOTATIONS })
    const [clientSide, serverSide] = createMemoryTransportPair()
    host.serve(serverSide)
    const client = await RemoteClient.attach(clientSide)
    await expect(client.call('counter', 'add', [1, 1])).resolves.toBe(2)
    client.close()
  })

  it('线协议是 JSON-RPC 2.0，一套就够', () => {
    expect(JSON_RPC_VERSION).toBe('2.0')
  })
})
