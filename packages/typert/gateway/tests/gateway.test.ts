/**
 * 端到端：起一个宿主与一个客户端，走完整调用。
 */
import { describe, expect, it } from 'vitest'
import {
  createMemoryTransportPair,
  type RemoteBinding,
  RemoteGatewayClient,
  RemoteGatewayServer,
  RemoteRegistry,
} from '../src/index.ts'
import { GREETING_ANNOTATIONS, GreetingService } from './helpers.ts'

/** 一套起好的宿主与客户端。 */
function startGateway(
  bindings: readonly RemoteBinding[] = [
    { namespace: 'greeting', service: new GreetingService(), methods: GREETING_ANNOTATIONS },
  ],
) {
  const registry = new RemoteRegistry({ bindings })
  const server = new RemoteGatewayServer({ registry })
  const [clientSide, serverSide] = createMemoryTransportPair()
  server.attach(serverSide)
  const client = new RemoteGatewayClient({ transport: clientSide, graph: registry.graph })
  return { registry, server, client }
}

describe('网关端到端', () => {
  it('调一个方法，拿到结果', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'greet', ['世界'])).resolves.toBe('你好，世界')
    server.close()
  })

  it('线上名字和方法名不同时也能调', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'aliasName', ['小声'])).resolves.toBe('小声！')
    server.close()
  })

  it('异步方法的返回值照样能拿到', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'shout', ['hi'])).resolves.toBe('HI!')
    server.close()
  })

  it('宿主抛的错原样到客户端，还带机器码', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'boom')).rejects.toMatchObject({
      code: 'gateway/internal',
      message: '炸了',
    })
    server.close()
  })

  it('调一个图里没有的方法：客户端立刻报错，不发出去', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'nope')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    server.close()
  })

  it('参数个数不对时宿主拒收', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'add', [1])).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(client.call('greeting', 'add', [1, 2, 3])).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    server.close()
  })

  it('超时报 gateway/timeout', async () => {
    const { client, server } = startGateway()
    await expect(client.call('greeting', 'slow', [500], { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'gateway/timeout',
    })
    server.close()
  })

  it('取消报 gateway/cancelled', async () => {
    const { client, server } = startGateway()
    const controller = new AbortController()
    const pending = client.call('greeting', 'slow', [500], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    server.close()
  })

  it('连接断了报 gateway/disconnected', async () => {
    const { client, server } = startGateway()
    const pending = client.call('greeting', 'slow', [500])
    server.close()
    await expect(pending).rejects.toMatchObject({ code: 'gateway/disconnected' })
  })

  it('宿主自己关连接后客户端再调也报断了', async () => {
    const { client, server } = startGateway()
    server.close()
    await expect(client.call('greeting', 'greet', ['世界'])).rejects.toMatchObject({
      code: 'gateway/disconnected',
    })
  })

  it('类型图能直接交给客户端用', async () => {
    const { registry, client, server } = startGateway()
    expect(registry.graph.entries.map((entry) => `${entry.namespace}.${entry.name}`)).toContain('greeting.greet')
    expect(client).toBeDefined()
    server.close()
  })
})
