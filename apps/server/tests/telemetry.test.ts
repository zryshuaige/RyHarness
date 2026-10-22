/**
 * 运行时可观测性：请求计时与轮次耗时（GET /api/telemetry）。
 *
 * 一半是纯单元（环形缓冲与单轮累计器的语义），一半是端到端：一轮真实对话跑完后
 * 遥测里要有一条带首 token 延迟/总耗时/记忆召回计量与结局的记录，且**不含**
 * 任何消息正文。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMemoryHooks } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Telemetry } from '../src/telemetry.ts'

const tmpDirs: string[] = []

function tempDataDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ryharness-telemetry-${prefix}-`))
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

/** 固定回复的适配器（每次调用都真的走一轮）。 */
class SimpleAdapter extends LlmAdapter {
  constructor(private readonly text: string) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Simple' }
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: this.text },
      { type: 'block-end', index: 0, block: { type: 'text', text: this.text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

/** 固定注入两行记忆的假记忆钩子（用来验证召回条数计量）。 */
function fakeMemory(): AgentMemoryHooks {
  return {
    recall: () => {
      return Promise.resolve('[记忆] 用户画像：\n- 喜欢蓝色\n相关记忆：\n- 杯子在第二个柜子')
    },
    enqueueExtraction: () => {},
  }
}

async function startServer(memory?: AgentMemoryHooks): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir: tempDataDir('server'),
    ...(memory === undefined ? {} : { memory }),
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new SimpleAdapter('好的，都记下了。'))
    },
  })
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function postJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface TurnTiming {
  conversationId: string
  kind: 'direct' | 'group'
  turnIndex: number
  firstTokenMs?: number
  totalMs: number
  memoryRecallMs: number
  memoryItems: number
  status: string
  finishedAt: number
}

interface RequestTiming {
  method: string
  path: string
  status: number
  durationMs: number
}

describe('遥测环形缓冲', () => {
  it('写满容量后丢最旧的；快照按时间倒序且条数受 limit 约束', () => {
    const telemetry = new Telemetry(3)
    for (let index = 0; index < 5; index++) {
      const recorder = telemetry.beginTurn(`c${index}`, 'direct', index)
      telemetry.endTurn(recorder, 'ok')
    }
    const snapshot = telemetry.getSnapshot(10)
    expect(snapshot.capacity).toBe(3)
    expect(
      snapshot.turns.map((turn) => {
        return turn.conversationId
      }),
    ).toEqual(['c4', 'c3', 'c2'])
    expect(snapshot.turns[0]?.firstTokenMs).toBeUndefined()
    expect(telemetry.getSnapshot(1).turns).toHaveLength(1)
    expect(telemetry.getSnapshot(0).turns).toEqual([])
  })

  it('单轮累计器：首 token 只认第一次，召回耗时与条数累加', () => {
    const telemetry = new Telemetry()
    const recorder = telemetry.beginTurn('conv-1', 'group', 7)
    const startedAt = Date.now()
    recorder.markFirstToken(startedAt + 120)
    recorder.markFirstToken(startedAt + 900)
    recorder.addRecall(12, 2)
    recorder.addRecall(3, 1)
    const timing = telemetry.endTurn(recorder, 'error')
    expect(timing.conversationId).toBe('conv-1')
    expect(timing.kind).toBe('group')
    expect(timing.turnIndex).toBe(7)
    // 只认第一次打点（120ms 而不是 900ms）。
    expect(timing.firstTokenMs).toBeGreaterThanOrEqual(100)
    expect(timing.firstTokenMs).toBeLessThan(500)
    expect(timing.memoryRecallMs).toBe(15)
    expect(timing.memoryItems).toBe(3)
    expect(timing.status).toBe('error')
    // 收完之后没有在途轮次，记忆钩子再来的计量无处可归。
    expect(telemetry.currentTurn()).toBeUndefined()
  })

  it('同一个会话重开一轮：结束的是新一轮而不是上一轮的记录', () => {
    const telemetry = new Telemetry()
    const first = telemetry.beginTurn('conv-1', 'direct', 0)
    const second = telemetry.beginTurn('conv-1', 'direct', 1)
    telemetry.endTurn(first, 'ok')
    telemetry.endTurn(second, 'aborted')
    expect(
      telemetry.getSnapshot().turns.map((turn) => {
        return turn.turnIndex
      }),
    ).toEqual([1, 0])
    expect(telemetry.getSnapshot().turns[0]?.status).toBe('aborted')
    expect(telemetry.currentTurn()).toBeUndefined()
  })

  it('轮次上下文：recallTurn 认作用域里指名的会话，没有作用域才退回最近一轮', () => {
    const telemetry = new Telemetry()
    const older = telemetry.beginTurn('conv-1', 'direct', 0)
    const newer = telemetry.beginTurn('conv-2', 'direct', 0)

    // 没有上下文：退回最近启动的那一轮（旧行为）。
    expect(telemetry.recallTurn()).toBe(newer)

    // 上下文指名谁就记给谁，哪怕它是更早启动的那一轮。
    void telemetry.scopedTurn('conv-1', () => {
      expect(telemetry.recallTurn()).toBe(older)
    })
    void telemetry.scopedTurn('conv-2', () => {
      expect(telemetry.recallTurn()).toBe(newer)
    })
    // 上下文异步传下去后仍认得出（await 出来的续链也在同一上下文里）。
    return telemetry
      .scopedTurn('conv-1', async () => {
        await Promise.resolve()
        telemetry.recallTurn()?.addRecall(5, 1)
        return telemetry.recallTurn()
      })
      .then((scoped) => {
        expect(scoped).toBe(older)
        expect(telemetry.endTurn(older, 'ok').memoryItems).toBe(1)
        expect(telemetry.endTurn(newer, 'ok').memoryItems).toBe(0)
      })
  })

  it('上下文指名的会话已经收轮时无处可归（不硬塞给别的会话）', () => {
    const telemetry = new Telemetry()
    const recorder = telemetry.beginTurn('conv-1', 'direct', 0)
    telemetry.endTurn(recorder, 'ok')
    void telemetry.scopedTurn('conv-1', () => {
      expect(telemetry.recallTurn()).toBeUndefined()
    })
  })
})

describe('GET /api/telemetry', () => {
  it('一轮对话结束后：记一条轮次耗时与请求计时，且不含消息正文', async () => {
    const server = await startServer(fakeMemory())
    try {
      await fetch(`${server.url}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id

      expect(
        (await postJson(server.url, `/api/conversations/${conversationId}/messages`, { text: '帮我泡杯茶' })).status,
      ).toBe(202)
      // 等这一轮真的结束（消息落库 = AgentLoop 组装完成 = 遥测出账紧随其后）。
      let turns: TurnTiming[] = []
      for (let attempt = 0; attempt < 100; attempt++) {
        const snapshot = (await getJson(server.url, '/api/telemetry')).body as { turns: TurnTiming[] }
        turns = snapshot.turns
        if (turns.length > 0) break
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
      }
      expect(turns).toHaveLength(1)
      const turn = turns[0] as TurnTiming
      expect(turn.conversationId).toBe(conversationId)
      expect(turn.kind).toBe('direct')
      expect(turn.status).toBe('ok')
      expect(turn.firstTokenMs).toBeGreaterThanOrEqual(0)
      expect(turn.totalMs).toBeGreaterThanOrEqual(turn.firstTokenMs as number)
      // 假记忆钩子注入了两行，条数与耗时都该被计量到。
      expect(turn.memoryItems).toBe(2)
      expect(turn.memoryRecallMs).toBeGreaterThanOrEqual(0)

      const snapshot = (await getJson(server.url, '/api/telemetry?limit=5')).body as {
        turns: TurnTiming[]
        requests: RequestTiming[]
        capacity: number
      }
      expect(snapshot.capacity).toBeGreaterThan(0)
      expect(snapshot.requests.length).toBeGreaterThan(0)
      const posted = snapshot.requests.find((row) => {
        return row.method === 'POST' && row.path === `/api/conversations/${conversationId}/messages`
      })
      expect(posted?.status).toBe(202)
      expect(posted?.durationMs).toBeGreaterThanOrEqual(0)
      // 查询串不进遥测：搜索词不该被记下来。
      expect(JSON.stringify(snapshot)).not.toContain('?')
      expect(JSON.stringify(snapshot)).not.toContain('帮我泡杯茶')
      expect(JSON.stringify(snapshot)).not.toContain('好的，都记下了')
    } finally {
      await server.close()
    }
  })

  it('出错的一轮记 status=error；还没发过消息时快照为空数组', async () => {
    const server = await startServer()
    try {
      const empty = (await getJson(server.url, '/api/telemetry')).body as { turns: unknown[] }
      expect(empty.turns).toEqual([])
      // ryen 的 provider 是 siliconflow（没有这条路由），这一轮必然失败。
      const created = await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ryen' })
      const conversationId = (created.body as { conversation: { id: string } }).conversation.id
      await postJson(server.url, `/api/conversations/${conversationId}/messages`, { text: '在吗' })

      let turns: TurnTiming[] = []
      for (let attempt = 0; attempt < 100; attempt++) {
        turns = ((await getJson(server.url, '/api/telemetry')).body as { turns: TurnTiming[] }).turns
        if (turns.length > 0) break
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
      }
      expect(turns[0]?.status).toBe('error')
    } finally {
      await server.close()
    }
  })

  it('两个会话并发时，召回耗时与条数各自记到发起它的那一轮', async () => {
    // 记忆钩子的契约只有 (agentId, inputText)，拿不到会话 id。两条并发轮次的
    // 召回各自慢在不同长度上：A 的召回落地时 B 那一轮还在跑——这正是"记给
    // 最近启动的一轮"会记串的窗口。
    const delays: Record<string, number> = { SLOW: 150, SLOWER: 400 }
    const memory: AgentMemoryHooks = {
      recall: (_agentId, inputText) => {
        const delay = delays.SLOWER !== undefined && inputText.includes('SLOWER') ? delays.SLOWER : delays.SLOW
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              inputText.includes('SLOWER') ? '[记忆] 用户画像：\n- 一\n相关记忆：\n- 二' : '[记忆] 用户画像：\n- 一',
            )
          }, delay ?? 0)
        })
      },
      enqueueExtraction: () => {},
    }
    const server = await startServer(memory)
    try {
      await fetch(`${server.url}/api/agents/ryen`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mock', model: 'mock' }),
      })
      const first = (await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ryen' })).body as {
        conversation: { id: string }
      }
      const second = (await postJson(server.url, '/api/conversations', { kind: 'direct', agentId: 'ryen' })).body as {
        conversation: { id: string }
      }

      await postJson(server.url, `/api/conversations/${first.conversation.id}/messages`, { text: 'SLOW 一下' })
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      await postJson(server.url, `/api/conversations/${second.conversation.id}/messages`, { text: 'SLOWER 一点' })

      let turns: TurnTiming[] = []
      for (let attempt = 0; attempt < 100; attempt++) {
        turns = ((await getJson(server.url, '/api/telemetry')).body as { turns: TurnTiming[] }).turns
        if (
          turns.some((turn) => {
            return turn.conversationId === first.conversation.id
          }) &&
          turns.some((turn) => {
            return turn.conversationId === second.conversation.id
          })
        ) {
          break
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
      }

      const slowTurn = turns.find((turn) => {
        return turn.conversationId === first.conversation.id
      })
      const slowerTurn = turns.find((turn) => {
        return turn.conversationId === second.conversation.id
      })
      expect(slowTurn?.memoryItems).toBe(1)
      expect(slowerTurn?.memoryItems).toBe(2)
      // 慢轮确实等到了自己那次召回，不是把耗时记到了别人头上。
      expect(slowTurn?.memoryRecallMs).toBeGreaterThanOrEqual(100)
      expect(slowerTurn?.memoryRecallMs).toBeGreaterThanOrEqual(300)
    } finally {
      await server.close()
    }
  })
})
