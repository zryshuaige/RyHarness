import type { AgentDefinition, Tool, ToolResult } from '@ryagent/agent'
import { createSessionQuota } from '@ryagent/agent'
import { brandString } from '@ryagent/brand'
import type { GroupEvent } from '@ryagent/group'
import { buildGroupContext, GroupDispatcher, parseMentions } from '@ryagent/group'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryagent/llm'
import { describe, expect, it } from 'vitest'

function agent(id: string, name: string, systemPrompt = `你是${name}。`): AgentDefinition {
  return { id, name, systemPrompt, provider: 'mock', model: 'mock', tools: [] }
}

const RYEN = agent('ryen', 'Ryen', '你是调度员 Ryen。')
const CODEBOT = agent('codebot', 'CodeBot')
const REVIEWER = agent('reviewer', 'Reviewer')
const MEMBERS = [RYEN, CODEBOT, REVIEWER]

/** 脚本化假 LlmRuntime：按调用顺序消费回复文本。 */
function mockLlm(replies: string[]): { llm: LlmRuntime; calls: () => number } {
  let calls = 0
  const llm = {
    stream() {
      const text = replies[calls++] ?? ''
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text },
        { type: 'block-end', index: 0, block: { type: 'text', text } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return {
    llm,
    calls: () => {
      return calls
    },
  }
}

async function collect(events: AsyncGenerator<GroupEvent>): Promise<GroupEvent[]> {
  const out: GroupEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function run(replies: string[], text: string, maxTurns?: number) {
  const { llm, calls } = mockLlm(replies)
  const dispatcher = new GroupDispatcher({
    llm,
    members: MEMBERS,
    dispatcherId: 'ryen',
    tools: [],
    ...(maxTurns === undefined ? {} : { maxTurns }),
  })
  const promise = collect(dispatcher.runTurn({ text, history: [], workspaceRoot: process.cwd(), turnIndex: 0 }))
  return { promise, calls }
}

describe('parseMentions', () => {
  it('matches members by name, single and multiple, in order of appearance', () => {
    expect(
      parseMentions('@CodeBot 看一下', MEMBERS).map((m) => {
        return m.id
      }),
    ).toEqual(['codebot'])
    expect(
      parseMentions('@Reviewer @CodeBot 一起看下', MEMBERS).map((m) => {
        return m.id
      }),
    ).toEqual(['reviewer', 'codebot'])
    expect(parseMentions('没有提及', MEMBERS)).toEqual([])
  })

  it('does not match a longer name as a prefix of another', () => {
    const ryen2 = agent('ryen2', 'Ryen2')
    const members = [RYEN, ryen2]
    expect(
      parseMentions('@Ryen2 在吗', members).map((m) => {
        return m.id
      }),
    ).toEqual(['ryen2'])
    expect(
      parseMentions('@Ryen 在吗', members).map((m) => {
        return m.id
      }),
    ).toEqual(['ryen'])
  })
})

describe('buildGroupContext', () => {
  it('prefixes speakers and trims from the oldest under budget', () => {
    const history = [
      { speaker: '用户', text: 'a'.repeat(100) },
      { speaker: 'Ryen', text: 'b'.repeat(100) },
      { speaker: 'CodeBot', text: 'c'.repeat(100) },
    ]
    const context = buildGroupContext(history, 250)
    expect(context).not.toContain('a'.repeat(20))
    expect(context).toContain(`Ryen: ${'b'.repeat(100)}`)
    expect(context).toContain(`CodeBot: ${'c'.repeat(100)}`)
  })
})

describe('GroupDispatcher', () => {
  it('routes @-less messages to the dispatcher, then relays through mentions', async () => {
    const { promise, calls } = run(
      ['收到，我来协调。@CodeBot 写个草案', '@Reviewer 草案好了，帮忙审查', '审查通过。'],
      '给大家安排一下',
    )
    const events = await promise
    const dispatches = events.filter((e) => {
      return e.type === 'dispatch'
    })
    expect(
      dispatches.map((d) => {
        return d.type === 'dispatch' && `${d.reason}->${d.toAgent}`
      }),
    ).toEqual(['default-dispatcher->ryen', 'relay @CodeBot->codebot', 'relay @Reviewer->reviewer'])
    const speakers = events
      .filter((e) => {
        return e.type === 'agent-message'
      })
      .map((e) => {
        return e.type === 'agent-message' ? e.agentId : ''
      })
    expect(speakers).toEqual(['ryen', 'codebot', 'reviewer'])
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 3 })
    expect(calls()).toBe(3)
  })

  it('routes user @mentions directly, bypassing the dispatcher', async () => {
    const { promise, calls } = run(['直接回答。'], '@Reviewer 问你个事')
    const events = await promise
    const dispatches = events.filter((e) => {
      return e.type === 'dispatch'
    })
    expect(dispatches).toEqual([{ type: 'dispatch', toAgent: 'reviewer', reason: 'user-mention', turnIndex: 0 }])
    expect(
      events.filter((e) => {
        return e.type === 'agent-message'
      }),
    ).toHaveLength(1)
    expect(calls()).toBe(1)
  })

  it('stops A↔B ping-pong with a loop-guard dispatch', async () => {
    const { promise, calls } = run(['@CodeBot 你来处理', '@Ryen 还是你来吧'], '这事怎么办')
    const events = await promise
    const guard = events.filter((e) => {
      return e.type === 'dispatch' && e.reason === 'loop-guard'
    })
    expect(guard).toHaveLength(1)
    expect(guard[0]).toMatchObject({ fromAgent: 'codebot', toAgent: 'ryen' })
    expect(
      events.filter((e) => {
        return e.type === 'agent-message'
      }),
    ).toHaveLength(2)
    expect(calls()).toBe(2)
  })

  it('stops on self-mentions with a loop-guard dispatch', async () => {
    const { promise, calls } = run(['我自己来 @Ryen'], '开始')
    const events = await promise
    const guard = events.filter((e) => {
      return e.type === 'dispatch' && e.reason === 'loop-guard'
    })
    expect(guard).toHaveLength(1)
    expect(guard[0]).toMatchObject({ fromAgent: 'ryen', toAgent: 'ryen' })
    expect(calls()).toBe(1)
  })

  it('stops at maxTurns and reports max-turns', async () => {
    // 三个 agent 循环接力（A→B→C→A…）才不会先触发 A-B-A 互踢护栏。
    const replies = Array.from({ length: 12 }, (_, i) => {
      const next = ['@Reviewer', '@Ryen', '@CodeBot'][i % 3] as string
      return `${next} 第${i}次`
    })
    const { promise, calls } = run(replies, '@CodeBot 开始', 3)
    const events = await promise
    const maxTurns = events.filter((e) => {
      return e.type === 'dispatch' && e.reason === 'max-turns'
    })
    expect(maxTurns).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'turn-done', turns: 3 })
    expect(calls()).toBe(3)
  })

  it('enforces cooldown: self-mention in a relay is guarded', async () => {
    const { promise, calls } = run(['@CodeBot 还是你'], '@CodeBot 上')
    const events = await promise
    const guard = events.filter((e) => {
      return e.type === 'dispatch' && e.reason === 'loop-guard'
    })
    expect(guard).toHaveLength(1)
    expect(guard[0]).toMatchObject({ fromAgent: 'codebot', toAgent: 'codebot' })
    expect(calls()).toBe(1)
  })
})

describe('GroupDispatcher 配额', () => {
  const RYEN_TOOLER = { ...RYEN, tools: ['shell_exec'] }
  const CODEBOT_TOOLER = { ...CODEBOT, tools: ['shell_exec'] }

  /** 按 system prompt 首行分派：第一步调工具，第二步回 `replies[名字]`。 */
  function toolThenReplyLlm(replies: Record<string, string>): LlmRuntime {
    let calls = 0
    return {
      stream(options: GenerateOptions) {
        calls++
        const head = (options.system ?? '').split('\n')[0] ?? ''
        const name = Object.keys(replies).find((key) => {
          return head.includes(key)
        })
        const text = name === undefined ? '' : (replies[name] as string)
        const chunks: StreamChunk[] =
          options.messages.at(-1)?.role === 'tool'
            ? [
                { type: 'text-delta', index: 0, text },
                { type: 'block-end', index: 0, block: { type: 'text', text } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
            : [
                {
                  type: 'block-end',
                  index: 0,
                  block: {
                    type: 'tool-call',
                    id: brandString<ToolCallId>(`call-${calls}`),
                    name: 'shell_exec',
                    arguments: '{}',
                  },
                },
                { type: 'finish', reason: { kind: 'tool-calls' } },
              ]
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
  }

  function countingShell(): { tool: Tool; executions: () => number } {
    let executions = 0
    return {
      tool: {
        name: 'shell_exec',
        description: 'test shell',
        parameters: { type: 'object', properties: {} },
        async execute(): Promise<ToolResult> {
          executions++
          return { content: 'ok' }
        },
      },
      executions: () => executions,
    }
  }

  it('shares one quota across the members of a turn', async () => {
    const quota = createSessionQuota({ maxShellCalls: 1 })
    const { tool, executions } = countingShell()
    const dispatcher = new GroupDispatcher({
      llm: toolThenReplyLlm({ Ryen: '@CodeBot 接手', CodeBot: '好' }),
      members: [RYEN_TOOLER, CODEBOT_TOOLER],
      dispatcherId: 'ryen',
      tools: [tool],
      quota,
    })
    const events = await collect(
      dispatcher.runTurn({ text: '开工', history: [], workspaceRoot: process.cwd(), turnIndex: 0 }),
    )
    const results = events
      .filter((event) => {
        return event.type === 'tool-result'
      })
      .map((event) => {
        return event.type === 'tool-result' ? [event.agentId, event.isError] : []
      })
    // Ryen 用掉唯一一次 shell，接力到的 CodeBot 撞的是同一个闸。
    expect(results).toEqual([
      ['ryen', false],
      ['codebot', true],
    ])
    expect(executions()).toBe(1)
    expect(quota.usage).toEqual({ shellCalls: 1, writeBytes: 0, rejected: 1 })
  })

  it('creates its own per-turn quota when the caller passes none', async () => {
    const { tool, executions } = countingShell()
    const dispatcher = new GroupDispatcher({
      llm: toolThenReplyLlm({ Ryen: '@CodeBot 接手', CodeBot: '好' }),
      members: [RYEN_TOOLER, CODEBOT_TOOLER],
      dispatcherId: 'ryen',
      tools: [tool],
    })
    const events = await collect(
      dispatcher.runTurn({ text: '开工', history: [], workspaceRoot: process.cwd(), turnIndex: 0 }),
    )
    expect(
      events
        .filter((event) => {
          return event.type === 'tool-result'
        })
        .map((event) => {
          return event.type === 'tool-result' ? event.isError : null
        }),
    ).toEqual([false, false])
    expect(executions()).toBe(2)
  })
})
