import { describe, expect, it } from 'vitest'
import type { LlmRuntime, StreamChunk } from '@ryagent/llm'
import { AgentLoop } from '@ryagent/agent'
import type { AgentDefinition, AgentMemoryHooks } from '@ryagent/agent'

const DEFINITION: AgentDefinition = {
  id: 'a1', name: 'Tester', systemPrompt: '你是测试 agent。',
  provider: 'mock', model: 'mock', tools: [],
}

function mockLlm(): LlmRuntime {
  return {
    stream() {
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '好的' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '好的' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  } as unknown as LlmRuntime
}

function recordingMemory(): AgentMemoryHooks & { recalled: string[]; enqueued: string[] } {
  return {
    recalled: [] as string[],
    enqueued: [] as string[],
    async recall(agentId, inputText) {
      this.recalled.push(`${agentId}:${inputText}`)
      return '[记忆] 用户画像：\n- 用户养了一只橘猫'
    },
    enqueueExtraction(agentId, agentName, conversationId, turnText) {
      this.enqueued.push(`${agentId}|${agentName}|${conversationId}|${turnText}`)
    },
  }
}

describe('AgentLoop × 长期记忆', () => {
  it('组装前 recall，记忆块拼入 system prompt', async () => {
    const memory = recordingMemory()
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [], memory })
    let system = ''
    const llm = {
      stream(options: { system?: string }) {
        system = options.system ?? ''
        return mockLlm().stream(options as never)
      },
    } as unknown as LlmRuntime
    const loop2 = new AgentLoop({ definition: DEFINITION, llm, tools: [], memory })
    for await (const _ of loop2.run({ text: '帮我照顾猫' }, { workspaceRoot: process.cwd() })) { /* drain */ }
    expect(system).toContain('你是测试 agent。')
    expect(system).toContain('[记忆] 用户画像：')
    expect(system).toContain('用户养了一只橘猫')
    expect(memory.recalled).toEqual(['a1:帮我照顾猫'])
  })

  it('每轮结束异步入队抽取（含用户输入与 assistant 回复），不阻塞事件流', async () => {
    const memory = recordingMemory()
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [], memory })
    const events: string[] = []
    for await (const event of loop.run({ text: '记一下' }, { workspaceRoot: process.cwd() })) {
      events.push(event.type)
    }
    expect(events).toEqual(['text-delta', 'done'])
    // 入队发生在 finally 中，事件流结束后已调用。
    expect(memory.enqueued).toHaveLength(1)
    expect(memory.enqueued[0]).toContain('a1|Tester|')
    expect(memory.enqueued[0]).toContain('用户：记一下')
    expect(memory.enqueued[0]).toContain('Tester：好的')
  })

  it('记忆 recall 抛错时静默降级（不影响对话）', async () => {
    const memory: AgentMemoryHooks = {
      async recall() { throw new Error('memory down') },
      enqueueExtraction() {},
    }
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [], memory })
    const events: string[] = []
    for await (const event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      events.push(event.type)
    }
    expect(events).toEqual(['text-delta', 'done'])
  })

  it('无 memory 选项时行为与此前一致（向后兼容）', async () => {
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(), tools: [] })
    const events: string[] = []
    for await (const event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      events.push(event.type)
    }
    expect(events).toEqual(['text-delta', 'done'])
  })
})

void mockLlm
