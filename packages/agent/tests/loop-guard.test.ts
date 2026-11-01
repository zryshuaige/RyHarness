/**
 * 循环卫生：重复工具调用提醒与单次调用超时。
 *
 * 这两件事的共同点是**不让一轮白烧**：模型卡在同一个循环里时，提醒它换条路；
 * 工具不返回时，把那一轮收口，让模型知道发生了什么。
 */
import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import { LlmRuntime as LlmRuntimeClass } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/**
 * 脚本化的假 LlmRuntime：按脚本给每一轮吐一段 chunk。
 *
 * 用原型建实例再遮蔽 `stream`：LlmRuntime 有三十多个成员，硬造一个对象字面量既长
 * 又脆（少一个成员类型就报错），而 `as unknown as` 是仓库门禁明令禁止的写法。
 */
function mockLlm(scripted: StreamChunk[][]): LlmRuntime {
  let call = 0
  const llm: LlmRuntime = Object.create(LlmRuntimeClass.prototype) as LlmRuntime
  llm.stream = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    void options
    const chunks = scripted[call++] ?? []
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
  return llm
}

const DEFINITION: AgentDefinition = {
  id: 'guard-agent',
  name: 'Guarded',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['echo', 'slow'],
}

/** 一次工具调用的 chunk（模型请求工具）。 */
function toolCall(name: string, args: string, id: string): StreamChunk[] {
  const callId = brandString<ToolCallId>(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: args },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: args },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async execute(args): Promise<ToolResult> {
    const text = (args as { text?: string }).text
    return { content: `echo: ${typeof text === 'string' ? text : ''}` }
  },
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('循环卫生', () => {
  it('连续两次一模一样的调用：第二条结果里附提醒', async () => {
    const llm = mockLlm([toolCall('echo', '{"text":"hi"}', 'c1'), toolCall('echo', '{"text":"hi"}', 'c2')])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'go' }, { workspaceRoot: process.cwd() }))
    const results = events.filter((event) => event.type === 'tool-result')
    expect(results).toHaveLength(2)
    const first = results[0] as { result: { content: string } }
    const second = results[1] as { result: { content: string } }
    expect(first.result.content).not.toContain('不要再原样重试')
    expect(second.result.content).toContain('不要再原样重试')
    // 提醒是附在结果后面的，原结果还在。
    expect(second.result.content).toContain('echo: hi')
  })

  it('中间插了别的调用：不提醒（换了做法就是新的一次尝试）', async () => {
    const otherTool: Tool = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(args): Promise<ToolResult> {
        const text = (args as { text?: string }).text
        return { content: `echo: ${typeof text === 'string' ? text : ''}` }
      },
    }
    const llm = mockLlm([
      toolCall('echo', '{"text":"a"}', 'c1'),
      toolCall('echo', '{"text":"b"}', 'c2'),
      toolCall('echo', '{"text":"a"}', 'c3'),
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [otherTool] })
    const events = await collect(loop.run({ text: 'go' }, { workspaceRoot: process.cwd() }))
    const results = events.filter((event) => event.type === 'tool-result')
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect((result as { result: { content: string } }).result.content).not.toContain('不要再原样重试')
    }
  })

  it('工具声明了 timeoutMs：到点收口，回一条中文超时错误', async () => {
    const slowTool: Tool = {
      name: 'slow',
      description: '慢工具',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 40,
      async execute(_args, ctx): Promise<ToolResult> {
        // 忽略取消信号，就一直挂着：宿主必须自己把它收掉。
        await new Promise((resolve) => {
          setTimeout(resolve, 5_000)
        })
        void ctx
        return { content: 'never' }
      },
    }
    const llm = mockLlm([toolCall('slow', '{}', 'c1')])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [slowTool] })
    const events = await collect(loop.run({ text: 'go' }, { workspaceRoot: process.cwd() }))
    const result = events.find((event) => event.type === 'tool-result') as
      | { isError: boolean; result: { content: string } }
      | undefined
    expect(result).toBeDefined()
    expect(result?.isError).toBe(true)
    expect(result?.result.content).toContain('超时')
  })

  it('工具没声明 timeoutMs：不替它编上限', async () => {
    let settled = false
    const noLimitTool: Tool = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        settled = true
        return { content: 'done' }
      },
    }
    const llm = mockLlm([toolCall('echo', '{}', 'c1')])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [noLimitTool] })
    const events = await collect(loop.run({ text: 'go' }, { workspaceRoot: process.cwd() }))
    expect(settled).toBe(true)
    const result = events.find((event) => event.type === 'tool-result') as { result: { content: string } }
    expect(result.result.content).toBe('done')
  })
})
