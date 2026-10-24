// @vitest-environment node
/**
 * 工具执行审批门：requiresApproval 的工具在配额之后、执行之前问审批方；
 * 拒绝/审批通道故障都转化为错误 tool 结果回给模型，不炸轮次。
 */
import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

function mockLlm(scripted: StreamChunk[][]): LlmRuntime {
  let call = 0
  // 返回类型标成 AsyncIterable（接口的真身）：AsyncGenerator 是它的子类型，
  // LlmRuntime 才与这份形状「可比」，单层下行收型合法——不引入 `as unknown as`
  //（仓库门禁对该模式冻结只减不增）。
  const partial: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> } = {
    stream(_options) {
      const chunks = scripted[call++] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  }
  return partial as LlmRuntime
}

const DEFINITION: AgentDefinition = {
  id: 'test-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['boom'],
}

/** 脚本里只有 boom 一个工具；执行次数就是要断言的副作用。 */
function boomTool(overrides: { requiresApproval?: boolean } = {}): Tool & { runs: number } {
  const tool: Tool & { runs: number } = {
    name: 'boom',
    description: '测试用',
    parameters: { type: 'object', properties: {}, required: [] },
    runs: 0,
    ...(overrides.requiresApproval === undefined ? {} : { requiresApproval: true }),
    async execute(): Promise<ToolResult> {
      tool.runs += 1
      return { content: 'boom!' }
    },
  }
  return tool
}

/** 第一轮发起 tool-call，工具结果回来后第二轮说一句话收尾。 */
function toolThenText(): StreamChunk[][] {
  return [
    [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'boom', arguments: '{}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    [
      { type: 'text-delta', index: 0, text: '好的' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '好的' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ]
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('工具执行审批', () => {
  it('审批通过：工具照常执行，结果不是错误', async () => {
    const tool = boomTool({ requiresApproval: true })
    const asked: string[] = []
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: mockLlm(toolThenText()),
      tools: [tool],
      approver: async (input) => {
        asked.push(input.name)
        return true
      },
    })
    const events = await collect(loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }))
    expect(tool.runs).toBe(1)
    expect(asked).toEqual(['boom'])
    const result = events.find((event) => {
      return event.type === 'tool-result'
    })
    expect(result).toMatchObject({ isError: false })
  })

  it('审批拒绝：不执行工具，错误结果里明确告诉模型别重试', async () => {
    const tool = boomTool({ requiresApproval: true })
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: mockLlm(toolThenText()),
      tools: [tool],
      approver: async () => {
        return false
      },
    })
    const events = await collect(loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }))
    expect(tool.runs).toBe(0)
    const result = events.find((event) => {
      return event.type === 'tool-result'
    })
    expect(result).toMatchObject({ isError: true })
    expect(result).toHaveProperty('result.content')
    const content = (result as { result: { content: string } }).result.content
    expect(content).toContain('用户拒绝')
    expect(content).toContain('不要原样重试')
    // 轮次照常收尾：拒绝是 tool 结果，不是轮次失败
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('审批通道自身故障按拒绝处理：没人看过的命令不放行', async () => {
    const tool = boomTool({ requiresApproval: true })
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: mockLlm(toolThenText()),
      tools: [tool],
      approver: async () => {
        throw new Error('bridge down')
      },
    })
    await collect(loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }))
    expect(tool.runs).toBe(0)
  })

  it('没有审批方时不拦（审批是装配层的安全闸，不是内核前置条件）', async () => {
    const tool = boomTool({ requiresApproval: true })
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm(toolThenText()), tools: [tool] })
    await collect(loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }))
    expect(tool.runs).toBe(1)
  })

  it('未标记 requiresApproval 的工具不问审批', async () => {
    const tool = boomTool()
    let asked = 0
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: mockLlm(toolThenText()),
      tools: [tool],
      approver: async () => {
        asked += 1
        return false
      },
    })
    await collect(loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }))
    expect(tool.runs).toBe(1)
    expect(asked).toBe(0)
  })
})
