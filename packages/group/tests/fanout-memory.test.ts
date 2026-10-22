/**
 * 扇出内的记忆召回共享：同一段输入只召回一次，多成员拿各自的注入块。
 *
 * 这组用例盯的是 P0「一次 fan-out 打 N 次 embedding 网络往返」：扇出的 N 个成员
 * 拿到的是同一个 prompt，同一段输入对同一空间的召回结果本来就该一样。
 */

import type { AgentDefinition, AgentMemoryHooks } from '@ryharness/agent'
import type { GroupEvent } from '@ryharness/group'
import { GroupDispatcher } from '@ryharness/group'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

function agent(id: string, name: string): AgentDefinition {
  return { id, name, systemPrompt: `你是${name}。`, provider: 'mock', model: 'mock', tools: [] }
}

const MEMBERS = [agent('ryen', 'Ryen'), agent('codebot', 'CodeBot'), agent('reviewer', 'Reviewer')]

/** 记录每个成员实际收到的 system prompt 的假 LLM。 */
function promptRecordingLlm(): LlmRuntime {
  return {
    stream(options: GenerateOptions) {
      const system = options.system ?? ''
      const member = system.split('\n')[0] ?? ''
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: `${member} 收到` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `${member} 收到` } }
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

/** 支持批量召回的假记忆：按空间给不同的注入块，并记账调用次数。 */
function batchMemory(): AgentMemoryHooks & {
  recallCalls: string[]
  recallManyCalls: { agentIds: readonly string[]; inputText: string }[]
  recallMany: (agentIds: readonly string[], inputText: string) => Promise<Map<string, string | undefined>>
} {
  const recallCalls: string[] = []
  const recallManyCalls: { agentIds: readonly string[]; inputText: string }[] = []
  const blockOf = (agentId: string): string => {
    return `[记忆] ${agentId} 的记忆`
  }
  return {
    recallCalls,
    recallManyCalls,
    async recall(agentId: string) {
      recallCalls.push(agentId)
      return blockOf(agentId)
    },
    async recallMany(agentIds: readonly string[], inputText: string) {
      recallManyCalls.push({ agentIds: [...agentIds], inputText })
      return new Map(
        agentIds.map((agentId) => {
          return [agentId, blockOf(agentId)]
        }),
      )
    },
    enqueueExtraction: () => {},
  }
}

/** 只实现逐成员 recall 的假记忆（批量召回不可用时的降级路径）。 */
function plainMemory(): AgentMemoryHooks & { recallCalls: string[] } {
  const recallCalls: string[] = []
  return {
    recallCalls,
    async recall(agentId: string) {
      recallCalls.push(agentId)
      return `[记忆] ${agentId} 的记忆`
    },
    enqueueExtraction: () => {},
  }
}

async function runFanoutTurn(memory: AgentMemoryHooks): Promise<GroupEvent[]> {
  const dispatcher = new GroupDispatcher({
    llm: promptRecordingLlm(),
    members: MEMBERS,
    dispatcherId: 'ryen',
    tools: [],
    memory,
  })
  return collect(
    dispatcher.runTurn({
      text: '@CodeBot @Reviewer 一起看下代码',
      history: [],
      workspaceRoot: process.cwd(),
      turnIndex: 0,
    }),
  )
}

describe('群聊扇出：同一段输入的记忆召回只做一次', () => {
  it('支持批量召回时：recallMany 只调一次，逐成员 recall 一次都不调', async () => {
    const memory = batchMemory()
    const events = await runFanoutTurn(memory)

    expect(memory.recallCalls).toEqual([])
    expect(memory.recallManyCalls).toHaveLength(1)
    expect(memory.recallManyCalls[0]?.agentIds).toEqual(['codebot', 'reviewer'])
    expect(memory.recallManyCalls[0]?.inputText).toContain('@CodeBot @Reviewer 一起看下代码')
    expect(
      events.filter((event) => {
        return event.type === 'agent-message'
      }),
    ).toHaveLength(2)
  })

  it('不支持批量召回时退回逐成员并发召回，行为不变（只是慢）', async () => {
    const memory = plainMemory()
    const events = await runFanoutTurn(memory)

    expect(memory.recallCalls.sort()).toEqual(['codebot', 'reviewer'])
    expect(
      events.filter((event) => {
        return event.type === 'agent-message'
      }),
    ).toHaveLength(2)
  })

  it('每个成员拿到的注入块是自己的那一份（共享的是"召回"，不是"结果"）', async () => {
    const systems: string[] = []
    const llm = {
      stream(options: GenerateOptions) {
        systems.push(options.system ?? '')
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', index: 0, text: 'ok' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime
    const memory = batchMemory()
    const dispatcher = new GroupDispatcher({
      llm,
      members: MEMBERS,
      dispatcherId: 'ryen',
      tools: [],
      memory,
    })
    await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Reviewer 一起看下代码',
        history: [{ speaker: '用户', text: '历史上下文' }],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )

    const codebot = systems.find((system) => {
      return system.includes('你是CodeBot')
    })
    const reviewer = systems.find((system) => {
      return system.includes('你是Reviewer')
    })
    expect(codebot).toContain('[记忆] codebot 的记忆')
    expect(codebot).not.toContain('[记忆] reviewer 的记忆')
    expect(reviewer).toContain('[记忆] reviewer 的记忆')
    // 批量召回仍然拿到的是扇出成员名单（不含未被 @ 的调度员）。
    expect(memory.recallManyCalls[0]?.agentIds).toEqual(['codebot', 'reviewer'])
  })

  it('单 @ 目标与接力链保持逐成员召回（没有扇出就没有可共享的东西）', async () => {
    const memory = batchMemory()
    const llm = {
      stream(options: GenerateOptions) {
        const text = options.system?.includes('你是CodeBot') === true ? '写完了，@Ryen 你收口。' : '好。'
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } as unknown as LlmRuntime
    const dispatcher = new GroupDispatcher({
      llm,
      members: MEMBERS,
      dispatcherId: 'ryen',
      tools: [],
      memory,
    })
    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot 开工',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )

    expect(memory.recallManyCalls).toEqual([])
    expect(memory.recallCalls).toEqual(['codebot', 'ryen'])
    expect(
      events.filter((event) => {
        return event.type === 'agent-message'
      }),
    ).toHaveLength(2)
  })
})
