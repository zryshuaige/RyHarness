import type { AgentDefinition, AgentEvolutionHooks, EvolutionTurnData } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import type { LlmRuntime, StreamChunk } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

const DEFINITION: AgentDefinition = {
  id: 'a1',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock',
  tools: [],
}

function mockLlm(): LlmRuntime {
  return {
    stream() {
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '收到' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  } as unknown as LlmRuntime
}

function recordingEvolution(): AgentEvolutionHooks & { enqueued: EvolutionTurnData[]; compiledFor: string[] } {
  return {
    enqueued: [] as EvolutionTurnData[],
    compiledFor: [] as string[],
    async compile(agentId) {
      this.compiledFor.push(agentId)
      return { text: '[经验手册]\n策略：先读后写', playbookEntryIds: ['e1'], reflectionIds: ['r1'] }
    },
    enqueueTurn(_agentId, _agentName, _conversationId, turn) {
      this.enqueued.push(turn)
    },
  }
}

describe('AgentLoop × 自我进化', () => {
  it('组装前 compile 注入 [经验手册] 到 system prompt', async () => {
    const evolution = recordingEvolution()
    let system = ''
    const llm = {
      stream(options: { system?: string }) {
        system = options.system ?? ''
        return mockLlm().stream(options as never)
      },
    } as unknown as LlmRuntime
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [], evolution })
    for await (const _ of loop.run({ text: '干活' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(system).toContain('你是测试 agent。')
    expect(system).toContain('[经验手册]')
    expect(system).toContain('策略：先读后写')
    expect(evolution.compiledFor).toEqual(['a1'])
  })

  it('finally 入队轨迹：含 user/assistant 文本、工具结果、llmError、注入归因', async () => {
    const evolution = recordingEvolution()
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [], evolution })
    for await (const _ of loop.run({ text: '写文件' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(evolution.enqueued).toHaveLength(1)
    const turn = evolution.enqueued[0]!
    expect(turn.userText).toBe('写文件')
    expect(turn.assistantText).toBe('收到')
    expect(turn.llmError).toBe(false)
    expect(turn.toolResults).toEqual([])
    expect(turn.injectedPlaybookEntryIds).toEqual(['e1'])
    expect(turn.injectedReflectionIds).toEqual(['r1'])
  })

  it('LLM 流错误时轨迹带 llmError=true 且仍入队', async () => {
    const evolution = recordingEvolution()
    const failing = {
      stream() {
        // biome-ignore lint/correctness/useYield: 测试替身——流立刻失败，不需要 yield
        return (async function* (): AsyncGenerator<StreamChunk> {
          throw new Error('boom')
        })()
      },
    } as unknown as LlmRuntime
    const loop = new AgentLoop({ definition: DEFINITION, llm: failing, tools: [], evolution })
    const events: string[] = []
    for await (const event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      events.push(event.type)
    }
    expect(events).toEqual(['error'])
    // 失败轮（llmError）无 assistant 文本也入队——反思依赖失败信号。
    expect(evolution.enqueued).toHaveLength(1)
    expect(evolution.enqueued[0]!.llmError).toBe(true)
  })

  it('compile 抛错静默降级（对话不受影响）', async () => {
    const evolution: AgentEvolutionHooks = {
      async compile() {
        throw new Error('evolve down')
      },
      enqueueTurn() {},
    }
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [], evolution })
    const events: string[] = []
    for await (const event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      events.push(event.type)
    }
    expect(events).toEqual(['text-delta', 'done'])
  })
})
