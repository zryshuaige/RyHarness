/**
 * 网关客户端：先看图再发。
 */
import { describe, expect, it } from 'vitest'
import {
  createMemoryTransportPair,
  REMOTE_GRAPH_METHOD,
  RemoteGatewayClient,
  RemoteGatewayServer,
  RemoteRegistry,
  type RpcTransport,
} from '../src/index.ts'
import { GREETING_ANNOTATIONS, GreetingService } from './helpers.ts'

/** 造一个登记表。 */
function greetingRegistry(): RemoteRegistry {
  return new RemoteRegistry({
    bindings: [{ namespace: 'greeting', service: new GreetingService(), methods: GREETING_ANNOTATIONS }],
  })
}

/** 在传输外面套一层，记下客户端写出去过什么。 */
function countingTransport(inner: RpcTransport): { transport: RpcTransport; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    transport: {
      write(chunk: string): void {
        sent.push(chunk)
        inner.write(chunk)
      },
      onData: (handler) => inner.onData(handler),
      onClose: (handler) => inner.onClose(handler),
      close: () => inner.close(),
    },
  }
}

describe('网关客户端', () => {
  it('照着图调方法', async () => {
    const registry = greetingRegistry()
    const server = new RemoteGatewayServer({ registry })
    const [clientSide, serverSide] = createMemoryTransportPair()
    server.attach(serverSide)
    const client = new RemoteGatewayClient({ transport: clientSide })
    await expect(client.call('greeting', 'greet', ['世界'])).resolves.toBe('你好，世界')
    server.close()
  })

  it('图里没有的方法：立刻报错，不发出去', async () => {
    const registry = greetingRegistry()
    const server = new RemoteGatewayServer({ registry })
    const [clientSide, serverSide] = createMemoryTransportPair()
    server.attach(serverSide)
    const counted = countingTransport(clientSide)
    const client = new RemoteGatewayClient({ transport: counted.transport })
    // 先把图拿到手，后面「立刻报错」才是真的「一个字节都没发」。
    await client.loadGraph()
    counted.sent.length = 0
    await expect(client.call('greeting', 'nope')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(counted.sent).toEqual([])
    server.close()
  })

  it('没给图时，第一次调用先去宿主要一张', async () => {
    const registry = greetingRegistry()
    const server = new RemoteGatewayServer({ registry })
    const [clientSide, serverSide] = createMemoryTransportPair()
    server.attach(serverSide)
    const client = new RemoteGatewayClient({ transport: clientSide })
    expect(client.graph).toBeUndefined()
    await expect(client.call('greeting', 'greet', ['世界'])).resolves.toBe('你好，世界')
    expect(client.graph?.namespaces).toEqual(['greeting'])
    server.close()
  })

  it('要图只会问一次', async () => {
    const registry = greetingRegistry()
    const server = new RemoteGatewayServer({ registry })
    const [clientSide, serverSide] = createMemoryTransportPair()
    server.attach(serverSide)
    const counted = countingTransport(clientSide)
    const client = new RemoteGatewayClient({ transport: counted.transport })
    const [first, second] = await Promise.all([client.loadGraph(), client.loadGraph()])
    expect(first.namespaces).toEqual(['greeting'])
    expect(second.namespaces).toEqual(['greeting'])
    const graphCalls = counted.sent.filter((chunk) => chunk.includes(REMOTE_GRAPH_METHOD))
    expect(graphCalls).toHaveLength(1)
    server.close()
  })

  it('宿主那边出问题时要图失败', async () => {
    const [clientSide, serverSide] = createMemoryTransportPair()
    const server = new RemoteGatewayServer({
      registry: () => {
        throw new Error('这张表是坏的')
      },
    })
    server.attach(serverSide)
    const client = new RemoteGatewayClient({ transport: clientSide })
    await expect(client.loadGraph()).rejects.toBeDefined()
    server.close()
  })
})
