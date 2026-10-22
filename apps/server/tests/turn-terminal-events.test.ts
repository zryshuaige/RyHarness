/**
 * 一轮对话的**终局事件**与**排队语义**（服务端半边）：
 *
 * - 终局事件：不管这一轮怎么结束（正常 message-done / 上游裸 error / 被取消），渲染
 *   层都必须能拿到一条收口事件。曾经只有前两种结束方式带 message-done，上游直接报
 *   错时那条气泡永远没人收口——光标不灭、停止按钮长亮，整轮停在"生成中"。
 * - 排队语义：/cancel 不只中止在途那一轮，还清掉本会话还没开始的排队轮次，在回执
 *   里如实报告清了几条；被清掉的每一轮都要有自己的收口事件。
 * - queued 事件不报 turnIndex：入队时刻那一轮还没有序号，报出来的只会是「排队者」
 *   的值。
 * @module @ryharness/server/tests/turn-terminal-events
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { HarnessError, LlmAdapter } from '@ryharness/llm'
import type { WsEvent } from '@ryharness/server'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { hangUntilAbort } from './helpers/stream.ts'

/** 正常回一句就收工。 */
class OkAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Ok' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: '答完了' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '答完了' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

/**
 * 上游模型调用直接炸掉（真实 provider 的 500 / 断流就是这条路径）：AgentLoop 只会
 * yield 一条 error，**不会再有 done**。
 */
class FailingAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Failing' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 上游一次内容都没吐就断：迭代器第一次 next() 就失败。
    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: () => {
            return Promise.reject(new HarnessError('mock 上游炸了', 'TRANSPORT'))
          },
        }
      },
    }
  }
}

/**
 * 一个字都不吐就挂起，直到调用方的 signal 被掐断。
 *
 * 与「取消但已有半截回复」相对：循环只在已经写出半截内容时才补一条 done 再抛
 * AbortedError，所以这条路径上整轮**没有**任何 message-done。
 */
class SilentAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private markStarted: () => void = () => {}

  constructor() {
    super()
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Silent' }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { signal } = options
    const markStarted = this.markStarted
    return (async function* (): AsyncGenerator<StreamChunk> {
      markStarted()
      await hangUntilAbort(signal)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/**
 * 第一条消息吐半截后挂起（占住链条），后面进来的消息只能排队；一旦真跑起来就会
 * 回一句「迟到的回复」——用来证明被取消的排队轮次一次都没跑。
 */
class GateAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private markStarted: () => void = () => {}
  /** 每次 stream 进来记一笔：被取消的排队轮次不该让它增长。 */
  calls = 0

  constructor() {
    super()
    this.started = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Gate' }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { signal } = options
    const markStarted = this.markStarted
    const first = this.calls === 0
    this.calls += 1
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (!first) {
        yield { type: 'text-delta', index: 0, text: '迟到的回复' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '迟到的回复' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: '写到一半就' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '写到一半就' } }
      markStarted()
      await hangUntilAbort(signal)
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

async function startServer(adapter: LlmAdapter) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-terminal-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
  return { server, base: server.url }
}

async function postJson(base: string, path: string, payload: unknown): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  ).json()) as Record<string, unknown>
}

async function getJson(base: string, path: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>
}

/** 订阅会话 WS；连上后先等 open（订阅就绪），再按条件收满事件。 */
function collectWs(base: string, conversationId: string, until: (events: WsEvent[]) => boolean, timeoutMs = 10_000) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
  const events: WsEvent[] = []
  const ready = new Promise<void>((resolve) => {
    ws.on('open', () => {
      resolve()
    })
  })
  const done = new Promise<WsEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`WS timed out; events: ${typesOf(events).join(',')}`))
    }, timeoutMs)
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as WsEvent
      events.push(event)
      if (until(events)) {
        clearTimeout(timer)
        ws.terminate()
        resolve(events)
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { ready, done }
}

/** 订阅后一直收到第 ms 毫秒（用来数「到底发了几条收口事件」）。 */
function collectFor(base: string, conversationId: string, ms: number) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?conversationId=${conversationId}`)
  const events: WsEvent[] = []
  const ready = new Promise<void>((resolve) => {
    ws.on('open', () => {
      resolve()
    })
  })
  const done = new Promise<WsEvent[]>((resolve) => {
    ws.on('message', (data) => {
      events.push(JSON.parse(String(data)) as WsEvent)
    })
    setTimeout(() => {
      ws.terminate()
      resolve(events)
    }, ms)
  })
  return { ready, done }
}

async function newDirectConversation(base: string): Promise<string> {
  await fetch(`${base}/api/agents/ryen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock', model: 'mock' }),
  })
  const created = await postJson(base, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
  return (created.conversation as { id: string }).id
}

const typesOf = (events: WsEvent[]): string[] => {
  return events.map((event) => {
    return event.type
  })
}

const doneOf = (events: WsEvent[], senderId: string) => {
  return events.filter((event) => {
    return event.type === 'message-done' && event.senderId === senderId
  })
}

const settle = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('一轮对话的终局事件', () => {
  it('上游裸 error（循环只 yield error、没有 done）：错误照发，同时补一条 message-done 收口', async () => {
    /**
     * 钉的是「三种结束方式只处理了两种」：正常走完有 done、取消时有 ABORTED，而
     * 上游直接失败时循环只 yield 一条 error 就 return——服务端这边已经收工，渲染层
     * 那条气泡却没人收口（光标不灭、停止按钮长亮，整轮停在"生成中"）。
     */
    const { server, base } = await startServer(new FailingAdapter())
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return doneOf(events, 'ryen').length > 0
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      const events = await collector.done

      // 失败原因照实发出去，收口补在它后面（不能被吞掉）。
      const error = events.find((event) => {
        return event.type === 'error'
      }) as { code: string }
      expect(error.code).not.toBe('ABORTED')
      const done = doneOf(events, 'ryen')
      expect(done, `错误结束后没有收口事件：${typesOf(events).join(',')}`).toHaveLength(1)
      const start = events.find((event) => {
        return event.type === 'message-start'
      })
      expect((done[0] as { turnIndex: number }).turnIndex).toBe((start as { turnIndex: number }).turnIndex)
    } finally {
      await server.close()
    }
  }, 20_000)

  it('取消且一个字都没写出来（循环只抛 ABORTED、没有 done）：ABORTED 之后仍要收口', async () => {
    const adapter = new SilentAdapter()
    const { server, base } = await startServer(adapter)
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return doneOf(events, 'ryen').length > 0
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      await adapter.started // 流已挂起：一个字都没吐
      await postJson(base, `/api/conversations/${conversationId}/cancel`, {})
      const events = await collector.done

      expect(
        events.some((event) => {
          return event.type === 'error' && event.code === 'ABORTED'
        }),
        `取消没有以 ABORTED 收尾：${typesOf(events).join(',')}`,
      ).toBe(true)
      const done = doneOf(events, 'ryen')
      expect(done, `取消后没有收口事件：${typesOf(events).join(',')}`).toHaveLength(1)
    } finally {
      await server.close()
    }
  }, 20_000)

  it('正常走完仍只有一条 message-done（兜底不重复发）', async () => {
    const { server, base } = await startServer(new OkAdapter())
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectFor(base, conversationId, 1500)
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '在吗' })
      const events = await collector.done
      expect(doneOf(events, 'ryen'), `收口事件数量不对：${typesOf(events).join(',')}`).toHaveLength(1)
    } finally {
      await server.close()
    }
  }, 20_000)
})

describe('取消的排队语义', () => {
  it('取消会清掉本会话排队未开始的轮次：它们一次都不跑，每条都拿到收口事件，回执如实报数', async () => {
    const adapter = new GateAdapter()
    const { server, base } = await startServer(adapter)
    try {
      const conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return doneOf(events, 'user').length >= 2
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '第一条' })
      await adapter.started // 第一条在途（挂起中）
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '第二条' })
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '第三条' })

      const cancelled = await postJson(base, `/api/conversations/${conversationId}/cancel`, {})
      expect(cancelled).toMatchObject({ cancelled: true, queueCleared: 2 })

      const events = await collector.done
      // 被清掉的每一轮都拿到一条 senderId 为 'user' 的收口事件——它正对上 POST 时
      // 推过的那条 message-start(user)，渲染层靠这对事件把排队的用户气泡收口。
      expect(doneOf(events, 'user'), `排队轮次没有被收口：${typesOf(events).join(',')}`).toHaveLength(2)
      // 在途那一轮照旧以 ABORTED 收工，半截回复正常落库。
      expect(
        events.some((event) => {
          return event.type === 'error' && event.code === 'ABORTED'
        }),
      ).toBe(true)

      // 排队里的两条**一次都没跑**：既没有迟到的回复，也不进历史。
      await settle(600)
      expect(adapter.calls).toBe(1)
      const messages = await getJson(base, `/api/conversations/${conversationId}/messages`)
      const rows = messages.messages as { contentBlocks: { text?: string }[] }[]
      expect(
        rows.map((row) => {
          return row.contentBlocks[0]?.text
        }),
      ).toEqual(['第一条', '写到一半就'])
    } finally {
      await server.close()
    }
  }, 25_000)

  it('空闲会话取消：cancelled=false 且 queueCleared=0（如实说"什么都没动"）', async () => {
    const { server, base } = await startServer(new OkAdapter())
    try {
      const conversationId = await newDirectConversation(base)
      const cancelled = await postJson(base, `/api/conversations/${conversationId}/cancel`, {})
      expect(cancelled).toMatchObject({ cancelled: false, queueCleared: 0 })
    } finally {
      await server.close()
    }
  }, 20_000)

  it('取消只影响本会话：别的会话照常在途', async () => {
    const { server, base } = await startServer(new OkAdapter())
    try {
      const first = await newDirectConversation(base)
      const second = await newDirectConversation(base)
      const collector = collectWs(base, second, (events) => {
        return doneOf(events, 'ryen').length > 0
      })
      await collector.ready
      await postJson(base, `/api/conversations/${second}/messages`, { text: '照跑' })
      const cancelled = await postJson(base, `/api/conversations/${first}/cancel`, {})
      expect(cancelled).toMatchObject({ cancelled: false, queueCleared: 0 })
      const events = await collector.done
      expect(doneOf(events, 'ryen')).toHaveLength(1)
    } finally {
      await server.close()
    }
  }, 20_000)
})

describe('queued 事件不带 turnIndex', () => {
  it('入队事件里没有 turnIndex（那一轮此刻还没有序号，报出来只会是排队者的值）', async () => {
    const adapter = new GateAdapter()
    const { server, base } = await startServer(adapter)
    let conversationId = ''
    try {
      conversationId = await newDirectConversation(base)
      const collector = collectWs(base, conversationId, (events) => {
        return typesOf(events).includes('queued')
      })
      await collector.ready
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '第一条' })
      await adapter.started
      await postJson(base, `/api/conversations/${conversationId}/messages`, { text: '第二条' })
      const events = await collector.done
      const queued = events.find((event) => {
        return event.type === 'queued'
      })
      expect(queued).toBeDefined()
      expect(queued, 'queued 事件仍在报一个会骗人的 turnIndex').not.toHaveProperty('turnIndex')
      expect(queued).toMatchObject({ senderId: 'user', conversationId })
    } finally {
      // 先把挂起的那一轮停掉：否则 close() 要等满 shutdownTimeoutMs 才收工。
      await postJson(base, `/api/conversations/${conversationId}/cancel`, {}).catch(() => {})
      await server.close()
    }
  }, 20_000)
})
