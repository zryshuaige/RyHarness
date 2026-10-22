/**
 * 历史改写与**在途轮次**的竞态（服务端半边）。
 *
 * 「编辑并重发 / 重新生成」要改的是会话历史，而历史是同会话所有轮次共用的。在途的
 * 那一轮正按**旧历史**生成，它收工时还会往库里写最后几条消息（半截回复、工具结果）。
 * 截断若不就地排进该会话的串行链，就会出现"问 B 答 A"：被截掉的那段后面又冒出来
 * 一句旧答案，重放那一轮的前置条件（末尾必须是用户消息）也不成立。
 *
 * 这个文件盯住三件事：
 *
 * - 在途那一轮被顶掉后，库里**不能**留下它的旧答案；
 * - 202 回执回来时，历史**已经**改完（客户端收到回执就重拉历史，重拉到的必须是
 *   真值，不是"改了一半"的中间态）；
 * - 被顶掉的那一轮**不弹**「已停止生成」红条——那是用户主动要求重来，不是故障。
 *
 * @module @ryharness/server/tests/history-rewrite-race
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import type { RyHarnessServer, WsEvent } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'
import { startMockServer } from './helpers/server.ts'
import { hangUntilAbort } from './helpers/stream.ts'
import { eventsOfType, watchConversation } from './helpers/ws.ts'

/**
 * 第一轮吐半截后挂起（占住链条），被中止后收工；后面的每一轮都回一句「新答案」。
 *
 * 第一轮那半截是关键：它模拟真实供应商被掐断时**已经落库**的半截回复——正是那条
 * 会在截断之后又冒出来、把库里写成"问 B 答 A"的消息。
 */
class HalfThenHangAdapter extends LlmAdapter {
  /** 第一轮开始时兑现：测试据此知道"它已经占住链了"。 */
  readonly started: Promise<void>
  private announceStarted: () => void = () => {}
  /** 真正跑起来的轮次数：被顶掉/被丢掉的排队轮次不该让它增长。 */
  calls = 0

  constructor() {
    super()
    this.started = new Promise((resolve) => {
      this.announceStarted = resolve
    })
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'HalfHang' }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls += 1
    if (this.calls > 1) {
      yield { type: 'text-delta', index: 0, text: '重放后的新答案' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '重放后的新答案' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: '旧答案写到一半' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '旧答案写到一半' } }
    this.announceStarted()
    await hangUntilAbort(options.signal)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []
/** 还没收工的会话（收尾时先把它们停掉，服务才关得掉）。 */
const openTurns: { base: string; id: string }[] = []

afterEach(async () => {
  // 先把还挂着的轮次停掉：不这么做，服务关的时候会等那一轮等到天荒地老
  // （停机流程要等 turn 链收工）。
  while (openTurns.length > 0) {
    const entry = openTurns.pop()
    if (entry === undefined) continue
    await fetch(`${entry.base}/api/conversations/${entry.id}/cancel`, { method: 'POST' }).catch(() => {})
  }
  while (running.length > 0) {
    const server = running.pop()
    await server?.close()
  }
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

/** 一个新数据目录（重启同一个目录就能测"重启后发生了什么"）。 */
function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-rewrite-race-'))
  tmpDirs.push(dir)
  return dir
}

/** 起一个服务并登记（关的时候一起关）。 */
async function boot(adapter: HalfThenHangAdapter, dataDir: string): Promise<{ server: RyHarnessServer; base: string }> {
  const handle = await startMockServer({ adapter, dataDir })
  running.push(handle.server)
  return { server: handle.server, base: handle.base }
}

/** POST 一个 JSON 接口。 */
async function post(base: string, path: string, payload: unknown): Promise<number> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return response.status
}

/** 一条消息的全部正文（把各块的 text 拼起来）。 */
function textOf(message: { contentBlocks: unknown[] }): string {
  return message.contentBlocks
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

/** 等到条件成立（轮次是异步跑的，202 只表示"排进队列了"）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error('等待条件超时')
}

/** 配好 mock 供应商、有一条用户消息与一条 agent 消息的单聊。 */
async function seedConversation(server: RyHarnessServer, base: string): Promise<{ id: string; userSeq: number }> {
  await fetch(`${base}/api/agents/ryen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock', model: 'mock' }),
  })
  const conversation = server.store.createConversation({ kind: 'direct', title: '竞态测试', memberAgentIds: ['ryen'] })
  const user = server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    senderId: 'user',
    contentBlocks: [{ type: 'text', text: '第一句' }],
  })
  server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '第一句的回复' }],
  })
  // 登记：收尾时先把这个会话里挂着的轮次停掉，服务才关得掉。
  openTurns.push({ base, id: conversation.id })
  return { id: conversation.id, userSeq: user.seq }
}

describe('编辑并重发 × 在途轮次', () => {
  it('在途那一轮被顶掉后，库里不留下它的旧答案', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id, userSeq } = await seedConversation(server, base)

    // 发一条新消息：这一轮会吐半截然后挂住，占着会话的串行链。
    expect(await post(base, `/api/conversations/${id}/messages`, { text: '再来一句' })).toBe(202)
    await adapter.started

    // 前提：在途那一轮已经往库里写了东西（它自己那条用户消息）。
    // 正是这条消息让"截断"和在途轮次撞上——它是在途轮次写完才落库的。
    expect(
      server.store.listMessages(id).map((message) => {
        return textOf(message)
      }),
    ).toContain('再来一句')

    // 在它还在生成时编辑更早的那一句。
    expect(await post(base, `/api/conversations/${id}/messages/${userSeq}/edit`, { text: '改过的第一句' })).toBe(202)

    await waitUntil(() => {
      return server.store.listMessages(id).some((message) => {
        return textOf(message) === '重放后的新答案'
      })
    })

    const texts = server.store.listMessages(id).map((message) => {
      return textOf(message)
    })
    // 库里只剩：改过的那句 + 重放后的新答案。
    expect(texts).toEqual(['改过的第一句', '重放后的新答案'])
    // 在途那一轮的半截回复、以及它自己那条用户消息，都不能还留在库里。
    expect(texts).not.toContain('旧答案写到一半')
    expect(texts).not.toContain('再来一句')
  })

  it('202 回来时历史已经改完（客户端重拉拿到的就是真值）', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id, userSeq } = await seedConversation(server, base)
    await post(base, `/api/conversations/${id}/messages`, { text: '再来一句' })
    await adapter.started

    await post(base, `/api/conversations/${id}/messages/${userSeq}/edit`, { text: '改过的第一句' })

    // 回执一到，库里就该已经是改写后的样子：不需要客户端再等一次轮询。
    const texts = server.store.listMessages(id).map((message) => {
      return textOf(message)
    })
    expect(texts).toContain('改过的第一句')
    expect(texts).not.toContain('第一句的回复')
    expect(texts).not.toContain('旧答案写到一半')
  })

  it('排队里还没开始的轮次被丢掉，一次都不跑', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id, userSeq } = await seedConversation(server, base)
    await post(base, `/api/conversations/${id}/messages`, { text: '再来一句' })
    await adapter.started
    // 第二条只能排队：第一条还占着链。
    await post(base, `/api/conversations/${id}/messages`, { text: '排队的第三句' })
    const callsBeforeEdit = adapter.calls

    await post(base, `/api/conversations/${id}/messages/${userSeq}/edit`, { text: '改过的第一句' })
    await waitUntil(() => {
      return server.store.listMessages(id).some((message) => {
        return textOf(message) === '重放后的新答案'
      })
    })

    // 只多跑了重放那一轮；被丢掉的排队轮次一次都没跑。
    expect(adapter.calls).toBe(callsBeforeEdit + 1)
    const texts = server.store.listMessages(id).map((message) => {
      return textOf(message)
    })
    expect(texts).not.toContain('排队的第三句')
  })

  it('被顶掉的那一轮不弹「已停止生成」红条', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id, userSeq } = await seedConversation(server, base)
    const window = watchConversation(base, id, 2500)
    await window.ready

    await post(base, `/api/conversations/${id}/messages`, { text: '再来一句' })
    await adapter.started
    await post(base, `/api/conversations/${id}/messages/${userSeq}/edit`, { text: '改过的第一句' })

    const events = await window.events
    const aborted = events.filter((event) => {
      return event.type === 'error' && event.code === 'ABORTED'
    })
    expect(aborted).toHaveLength(0)
  })
})

describe('重新生成 × 在途轮次', () => {
  it('换掉那条回复，在途那一轮的旧答案不会跟着写回来', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id } = await seedConversation(server, base)
    const agentSeq = server.store.listMessages(id)[1]?.seq
    expect(agentSeq).toBeGreaterThan(0)

    await post(base, `/api/conversations/${id}/messages`, { text: '再来一句' })
    await adapter.started

    expect(await post(base, `/api/conversations/${id}/messages/${agentSeq}/regenerate`, {})).toBe(202)

    await waitUntil(() => {
      return server.store.listMessages(id).some((message) => {
        return textOf(message) === '重放后的新答案'
      })
    })

    const texts = server.store.listMessages(id).map((message) => {
      return textOf(message)
    })
    // 用户那句话原地不动，旧回复被换成新答案。
    expect(texts).toEqual(['第一句', '重放后的新答案'])
    expect(texts).not.toContain('旧答案写到一半')
    expect(texts).not.toContain('再来一句')
  })
})

describe('排队轮次的序号', () => {
  it('同一会话排队的两轮各拿各的轮次序号', async () => {
    const adapter = new HalfThenHangAdapter()
    const { server, base } = await boot(adapter, newDataDir())
    const { id } = await seedConversation(server, base)
    const window = watchConversation(base, id, 2000)
    await window.ready

    await post(base, `/api/conversations/${id}/messages`, { text: '第一条' })
    await adapter.started
    await post(base, `/api/conversations/${id}/messages`, { text: '第二条' })

    const events: WsEvent[] = await window.events
    const starts = eventsOfType(events, 'message-start').filter((event) => {
      return event.senderId === 'user'
    })
    // 两条排队消息各报各的序号：共用一个号的话，渲染层只能认出第一条，
    // 第二条会永远停在"排队中"。
    expect(starts).toHaveLength(2)
    expect(
      new Set(
        starts.map((event) => {
          return event.turnIndex
        }),
      ).size,
    ).toBe(2)
  })
})
