import type { AgentDefinition } from '@ryagent/agent'
import type { GroupEvent } from '@ryagent/group'
import { DEFAULT_FANOUT_CONCURRENCY, GroupDispatcher } from '@ryagent/group'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryagent/llm'
import { describe, expect, it } from 'vitest'

function agent(id: string, name: string, systemPrompt = `你是${name}。`): AgentDefinition {
  return { id, name, systemPrompt, provider: 'mock', model: 'mock', tools: [] }
}

const RYEN = agent('ryen', 'Ryen')
const CODEBOT = agent('codebot', 'CodeBot')
const REVIEWER = agent('reviewer', 'Reviewer')
const ALPHA = agent('alpha', 'Alpha')
const BETA = agent('beta', 'Beta')

interface Reply {
  text: string
  delayMs?: number
}

/** 按 system prompt 首行的成员名分发回复的假 LlmRuntime，并记录 start/end。 */
function mockLlm(replies: Record<string, Reply>, log?: string[]): LlmRuntime {
  return {
    stream(options: GenerateOptions) {
      const system = options.system ?? ''
      const head = system.split('\n')[0] ?? ''
      const name = Object.keys(replies).find((key) => {
        return head.includes(key)
      })
      const reply = name === undefined ? { text: '' } : (replies[name] as Reply)
      const tag = name ?? 'unknown'
      return (async function* (): AsyncGenerator<StreamChunk> {
        log?.push(`${tag}:start`)
        if (reply.delayMs !== undefined) {
          await new Promise((resolve) => {
            setTimeout(resolve, reply.delayMs)
          })
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
        log?.push(`${tag}:end`)
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  } as unknown as LlmRuntime
}

async function collect(events: AsyncGenerator<GroupEvent>): Promise<GroupEvent[]> {
  const out: GroupEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function speakersOf(events: readonly GroupEvent[]): string[] {
  return events
    .filter((event) => {
      return event.type === 'agent-message'
    })
    .map((event) => {
      return event.type === 'agent-message' ? event.agentId : ''
    })
}

describe('GroupDispatcher 并行扇出', () => {
  it('多个 @ 目标并发起跑，结果按 @ 出现顺序提交', async () => {
    const log: string[] = []
    const llm = mockLlm(
      {
        CodeBot: { text: '我来写。', delayMs: 20 },
        Reviewer: { text: '我看过了。' },
      },
      log,
    )
    const dispatcher = new GroupDispatcher({
      llm,
      members: [RYEN, CODEBOT, REVIEWER],
      dispatcherId: 'ryen',
      tools: [],
    })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Reviewer 一起看下',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )
    // 并发：两个成员都先 start 才各自 end（串行会是 CodeBot start/end → Reviewer start/end）。
    expect(log).toEqual(['CodeBot:start', 'Reviewer:start', 'Reviewer:end', 'CodeBot:end'])
    // 提交顺序按 @ 顺序，与谁先跑完无关。
    expect(speakersOf(events)).toEqual(['codebot', 'reviewer'])
    const deltas = events
      .filter((event) => {
        return event.type === 'text-delta'
      })
      .map((event) => {
        return event.type === 'text-delta' ? `${event.agentId}:${event.text}` : ''
      })
    expect(deltas).toEqual(['codebot:我来写。', 'reviewer:我看过了。'])
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 2 })
  })

  it('并发不超过 fanoutConcurrency（默认 3）', async () => {
    let inFlight = 0
    let peak = 0
    const llm = {
      stream(options: GenerateOptions) {
        const system = options.system ?? ''
        return (async function* (): AsyncGenerator<StreamChunk> {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => {
            setTimeout(resolve, 5)
          })
          yield { type: 'text-delta', index: 0, text: system.includes('你是Alpha') ? 'a' : 'x' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }
          inFlight--
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime
    const dispatcher = new GroupDispatcher({
      llm,
      members: [RYEN, CODEBOT, REVIEWER, ALPHA, BETA],
      dispatcherId: 'ryen',
      tools: [],
    })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Reviewer @Alpha @Beta 一起',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )
    expect(DEFAULT_FANOUT_CONCURRENCY).toBe(3)
    expect(peak).toBe(3)
    expect(speakersOf(events)).toEqual(['codebot', 'reviewer', 'alpha', 'beta'])
  })

  it('扇出后的接力仍然串行，并受 loop-guard 约束', async () => {
    const log: string[] = []
    const llm = mockLlm(
      {
        CodeBot: { text: '写完了，@Ryen 你收口。' },
        Alpha: { text: '我补充一下。' },
        Ryen: { text: '好，我总结。' },
      },
      log,
    )
    const dispatcher = new GroupDispatcher({
      llm,
      members: [RYEN, CODEBOT, ALPHA],
      dispatcherId: 'ryen',
      tools: [],
    })
    const events = await collect(
      dispatcher.runTurn({ text: '@CodeBot @Alpha 开工', history: [], workspaceRoot: process.cwd(), turnIndex: 0 }),
    )
    expect(speakersOf(events)).toEqual(['codebot', 'alpha', 'ryen'])
    expect(
      events
        .filter((event) => {
          return event.type === 'dispatch'
        })
        .map((event) => {
          return event.type === 'dispatch' && `${event.reason}->${event.toAgent}`
        }),
    ).toEqual(['user-mention->codebot', 'user-mention->alpha', 'relay @Ryen->ryen'])
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 3 })
    // 接力在扇出全部结束后才开始。
    expect(log.indexOf('Ryen:start')).toBeGreaterThan(log.indexOf('Alpha:end'))
  })

  it('扇出仍受 maxTurns 约束：超出的目标记 max-turns 事件', async () => {
    const llm = mockLlm({ CodeBot: { text: 'a' }, Reviewer: { text: 'b' }, Alpha: { text: 'c' } })
    const dispatcher = new GroupDispatcher({
      llm,
      members: [RYEN, CODEBOT, REVIEWER, ALPHA],
      dispatcherId: 'ryen',
      tools: [],
      maxTurns: 2,
    })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Reviewer @Alpha 一起',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )
    expect(speakersOf(events)).toEqual(['codebot', 'reviewer'])
    expect(
      events.filter((event) => {
        return event.type === 'dispatch' && event.reason === 'max-turns'
      }),
    ).toEqual([{ type: 'dispatch', fromAgent: 'reviewer', toAgent: 'alpha', reason: 'max-turns', turnIndex: 0 }])
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 2 })
  })
})

describe('GroupDispatcher 取消', () => {
  function abortingLlm(controller: AbortController): LlmRuntime {
    return {
      stream() {
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', index: 0, text: '半句' }
          controller.abort()
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'client went away', code: 'ABORTED' } },
          }
        })()
      },
    } as unknown as LlmRuntime
  }

  it('接力轮取消：不再继续接力，以 ABORTED 错误事件收尾', async () => {
    const controller = new AbortController()
    const dispatcher = new GroupDispatcher({
      llm: abortingLlm(controller),
      members: [RYEN, CODEBOT, REVIEWER],
      dispatcherId: 'ryen',
      tools: [],
    })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot 开始',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
        signal: controller.signal,
      }),
    )
    expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('aborted') as unknown as string,
      code: 'ABORTED',
    })
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 0 })
  })

  it('已取消的 signal 不会发起任何成员发言', async () => {
    const controller = new AbortController()
    controller.abort()
    let streams = 0
    const llm = {
      stream() {
        streams++
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime
    const dispatcher = new GroupDispatcher({ llm, members: [RYEN, CODEBOT], dispatcherId: 'ryen', tools: [] })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Ryen 一起来',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
        signal: controller.signal,
      }),
    )
    expect(speakersOf(events)).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 0 })
    expect(
      events.some((event) => {
        return event.type === 'error' && event.code === 'ABORTED'
      }),
    ).toBe(true)
  })
})
