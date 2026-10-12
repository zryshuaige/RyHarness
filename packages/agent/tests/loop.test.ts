import { describe, expect, it } from 'vitest'
import { brandString } from '@ryagent/brand'
import type { LlmRuntime, StreamChunk, ToolCallId } from '@ryagent/llm'
import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryagent/agent'
import { AgentLoop, BUILTIN_TEMPLATES, forkTemplate, RYEN_TEMPLATE } from '@ryagent/agent'

/** 脚本化的假 LlmRuntime：每次 stream() 消耗一段录制 chunk。 */
function mockLlm(scripted: StreamChunk[][]): LlmRuntime {
  let call = 0
  return {
    stream(_options: unknown) {
      const chunks = scripted[call++] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
}

const DEFINITION: AgentDefinition = {
  id: 'test-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['echo'],
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显 text 参数',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args): Promise<ToolResult> {
    const text = (args as { text?: string }).text
    if (typeof text !== 'string') return { content: 'missing text', isError: true }
    return { content: `echo: ${text}` }
  },
}

function finishStop(): StreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } }
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('builtin templates', () => {
  it('ships the Ryen template as a builtin', () => {
    expect(RYEN_TEMPLATE.isBuiltin).toBe(true)
    expect(RYEN_TEMPLATE.systemPrompt).toContain('猫管家')
    expect(BUILTIN_TEMPLATES.ryen).toBe(RYEN_TEMPLATE)
  })

  it('forks a template into a user-owned agent', () => {
    const forked = forkTemplate(RYEN_TEMPLATE, { name: '我的管家', model: 'other/model' })
    expect(forked.id).not.toBe(RYEN_TEMPLATE.id)
    expect(forked.isBuiltin).toBe(false)
    expect(forked.name).toBe('我的管家')
    expect(forked.model).toBe('other/model')
    expect(forked.tools).toEqual(RYEN_TEMPLATE.tools)
  })
})

describe('AgentLoop', () => {
  it('streams text and finishes on a plain reply', async () => {
    const llm = mockLlm([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      finishStop(),
    ]])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events).toEqual([
      { type: 'text-delta', text: '你好' },
      { type: 'done', finish: { kind: 'stop' }, steps: 1 },
    ])
  })

  it('executes tool calls in a second step and reports results', async () => {
    const callId = brandString<ToolCallId>('call-1')
    const llm = mockLlm([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"喵"}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"喵"}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '完成' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
        finishStop(),
      ],
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: '叫一声' }, { workspaceRoot: process.cwd() }))
    expect(events[0]).toEqual({ type: 'tool-call-start', callId, name: 'echo', arguments: '{"text":"喵"}' })
    expect(events[1]).toMatchObject({ type: 'tool-result', callId, name: 'echo', isError: false })
    expect((events[1] as { result: ToolResult }).result.content).toBe('echo: 喵')
    expect(events[2]).toEqual({ type: 'text-delta', text: '完成' })
    expect(events[3]).toEqual({ type: 'done', finish: { kind: 'stop' }, steps: 2 })
  })

  it('never calls tools outside the definition whitelist', async () => {
    const llm = mockLlm([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: brandString<ToolCallId>('c9'), name: 'echo', argumentsDelta: '{}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: brandString<ToolCallId>('c9'), name: 'echo', arguments: '{}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], [
      { type: 'text-delta', index: 0, text: 'end' },
      finishStop(),
    ]])
    const definition = { ...DEFINITION, tools: [] }
    const loop = new AgentLoop({ definition, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const result = events.find((e) => { return e.type === 'tool-result' })
    // 白名单为空 → 工具未注册 → 未知工具错误结果，且第二步请求里没有 tools 字段。
    expect(result).toMatchObject({ type: 'tool-result', name: 'echo', isError: true })
    expect((result as { result: ToolResult }).result.content).toContain('unknown tool')
  })

  it('reports unknown tools and bad JSON as error results instead of throwing', async () => {
    const llm = mockLlm([
      [
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: brandString<ToolCallId>('c1'), name: 'nope', arguments: '{}' },
        },
        {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call', id: brandString<ToolCallId>('c2'), name: 'echo', arguments: '{bad' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'text-delta', index: 0, text: 'done' },
        finishStop(),
      ],
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const results = events.filter((e) => { return e.type === 'tool-result' })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ name: 'nope', isError: true })
    expect(results[1]).toMatchObject({ name: 'echo', isError: true })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('surfaces stream failures as error events', async () => {
    const failing = {
      stream() {
        return (async function* (): AsyncGenerator<StreamChunk> {
          throw new Error('boom')
        })()
      },
    } as unknown as LlmRuntime
    const loop = new AgentLoop({ definition: DEFINITION, llm: failing, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', code: 'UNKNOWN' })
    expect((events[0] as { message: string }).message).toContain('boom')
  })

  it('终态 error finish 传播为 error 事件而不是 done（半截回复不算完成）', async () => {
    const llm = mockLlm([[
      { type: 'text-delta', index: 0, text: '半截' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '半截' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'SERVER' } } },
    ]])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events.some((event) => { return event.type === 'done' })).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'error', message: 'provider exploded', code: 'SERVER' })
  })

  it('终态 aborted finish 同样传播为 error 事件', async () => {
    const llm = mockLlm([[
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'client went away', code: 'ABORTED' } } },
    ]])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events).toEqual([{ type: 'error', message: 'client went away', code: 'ABORTED' }])
  })

  it('stops at maxSteps when the model keeps calling tools', async () => {
    const scripted = Array.from({ length: 20 }, (): StreamChunk[] => [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: brandString<ToolCallId>('loop'), name: 'echo', arguments: '{"text":"x"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const llm = mockLlm(scripted)
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool], maxSteps: 3 })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'MAX_STEPS' })
    const toolResults = events.filter((e) => { return e.type === 'tool-result' })
    expect(toolResults).toHaveLength(3)
  })
})
