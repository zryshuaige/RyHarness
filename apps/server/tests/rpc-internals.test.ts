/**
 * 进程外 RPC 的服务端侧：stdio 传输、远程服务、端点装配。
 *
 * 这一族盯的是「协议层对不对」：帧怎么切、消息怎么解析、方法名怎么映射。
 * 真起子进程的那部分在 `rpc.test.ts`。
 */
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RyHarnessRemoteService } from '../src/rpc/service.ts'
import { createStdioTransport } from '../src/rpc/stdio.ts'

/** 一个能读的内存流。 */
function readableOf(text: string): Readable {
  const stream = new Readable({ read() {} })
  stream.push(text)
  stream.push(null)
  return stream
}

/** 一个能写的内存流（把写进去的东西收起来）。 */
function writableOf(): Writable & { written: string } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  }) as Writable & { written: string }
  Object.defineProperty(stream, 'written', {
    get: () => chunks.join(''),
  })
  return stream
}

describe('stdio 传输', () => {
  it('收到的原始字节原样交给对端（分帧是���端的事）', async () => {
    const input = readableOf('{"a":1}\n{"b":2}\n')
    const output = writableOf()
    const transport = createStdioTransport({ input, output })
    const received: string[] = []
    transport.onData((chunk) => {
      received.push(chunk)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // **换行要留着**：对端靠它切帧，去掉了对端就拼不出完整的一帧。
    expect(received.join('')).toContain('{"a":1}\n')
    expect(received.join('')).toContain('{"b":2}\n')
  })

  it('写出去的内容带换行', () => {
    const output = writableOf()
    const transport = createStdioTransport({ input: readableOf(''), output })
    transport.write('{"x":1}')
    expect(output.written).toBe('{"x":1}\n')
  })

  it('已经带换行的不重复加', () => {
    const output = writableOf()
    const transport = createStdioTransport({ input: readableOf(''), output })
    transport.write('{"x":1}\n')
    expect(output.written).toBe('{"x":1}\n')
  })

  it('输入流结束时通知断开', async () => {
    const input = readableOf('')
    const transport = createStdioTransport({ input, output: writableOf() })
    let closed = false
    transport.onClose(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(true)
  })
})

describe('远程服务', () => {
  /** 建一个带替身依赖的服务。 */
  function makeService(): RyHarnessRemoteService {
    const conversations = [{ id: 'c1', kind: 'direct', title: '会话一', memberAgentIds: ['ryen'], updatedAt: 10 }]
    const messages = [
      {
        seq: 1,
        senderType: 'user',
        contentBlocks: [{ type: 'text', text: '你好' }],
        createdAt: 5,
      },
    ]
    return new RyHarnessRemoteService({
      store: {
        listConversations: () => conversations,
        listMessages: () => messages,
      } as never,
      listTools: () => [{ name: 'fs_read', description: '读文件' }],
      recallMemory: async () => [
        {
          id: 'm1',
          kind: 'fact',
          content: '记得你喜欢猫',
          agentId: 'a1',
          createdAt: 1,
          updatedAt: 2,
          score: 0.42,
        },
      ],
      writeSetting: async () => undefined,
    })
  }

  it('列会话', async () => {
    const service = makeService()
    const result = await service.listConversations(10)
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('会话一')
  })

  it('读消息：正文从内容块里取出来', async () => {
    const service = makeService()
    const result = await service.listMessages('c1', 10)
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe('你好')
  })

  it('列工具', () => {
    const service = makeService()
    const result = service.listTools()
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('fs_read')
  })

  it('召回记忆', async () => {
    const service = makeService()
    expect(await service.recallMemory('ryen', '喜欢什么')).toEqual([
      { id: 'm1', kind: 'fact', content: '记得你喜欢猫', agentId: 'a1', createdAt: 1, updatedAt: 2, score: 0.42 },
    ])
  })

  it('写设置', async () => {
    const service = makeService()
    await expect(service.writeSetting('k', 'v')).resolves.toBeUndefined()
  })
})
