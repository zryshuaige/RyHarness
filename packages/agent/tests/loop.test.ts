import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryharness/agent'
import { AgentLoop, BUILTIN_TEMPLATES, forkTemplate, MAX_LOOP_CONTEXT_TOKENS, RYEN_TEMPLATE } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, Message, StreamChunk, ToolCallId } from '@ryharness/llm'
import { estimateTokens } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 脚本化的假 LlmRuntime：每次 stream() 消耗一段录制 chunk，并记录每次请求。 */
function mockLlm(scripted: StreamChunk[][]): { llm: LlmRuntime; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  let call = 0
  const llm = {
    stream(options: GenerateOptions) {
      requests.push(options)
      const chunks = scripted[call++] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return { llm, requests }
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
    const { llm } = mockLlm([
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '你好' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
        finishStop(),
      ],
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events).toEqual([
      { type: 'text-delta', text: '你好' },
      { type: 'done', finish: { kind: 'stop' }, steps: 1 },
    ])
  })

  it('executes tool calls in a second step and reports results', async () => {
    const callId = brandString<ToolCallId>('call-1')
    const { llm } = mockLlm([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: '{"text":"喵"}' },
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"喵"}' },
        },
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
    const { llm } = mockLlm([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: brandString<ToolCallId>('c9'), name: 'echo', argumentsDelta: '{}' },
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: brandString<ToolCallId>('c9'), name: 'echo', arguments: '{}' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [{ type: 'text-delta', index: 0, text: 'end' }, finishStop()],
    ])
    const definition = { ...DEFINITION, tools: [] }
    const loop = new AgentLoop({ definition, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const result = events.find((e) => {
      return e.type === 'tool-result'
    })
    // 白名单为空 → 工具未注册 → 未知工具错误结果，且第二步请求里没有 tools 字段。
    expect(result).toMatchObject({ type: 'tool-result', name: 'echo', isError: true })
    expect((result as { result: ToolResult }).result.content).toContain('unknown tool')
  })

  it('resolves whitelist names from a tool lookup, so a removed tool disappears', async () => {
    const registered = new Map<string, Tool>([['echo', echoTool]])
    const lookup = {
      get: (name: string) => registered.get(name),
      list: () => [...registered.values()],
    }
    const toolCall = (): StreamChunk[] => [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: brandString<ToolCallId>('c-lookup'), name: 'echo', arguments: '{"text":"喵"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { llm, requests } = mockLlm([
      toolCall(),
      [{ type: 'text-delta', index: 0, text: 'first' }, finishStop()],
      toolCall(),
      [{ type: 'text-delta', index: 0, text: 'second' }, finishStop()],
    ])

    const present = new AgentLoop({ definition: DEFINITION, llm, tools: lookup })
    const first = await collect(present.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(first[0]).toMatchObject({ type: 'tool-call-start', name: 'echo' })
    expect((first[1] as { result: ToolResult }).result.content).toBe('echo: 喵')
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['echo'])

    // 注册表清空后再建一轮：白名单名字相同，但工具已不可见/不可调用。
    registered.clear()
    const missing = new AgentLoop({ definition: DEFINITION, llm, tools: lookup })
    const second = await collect(missing.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(requests[2]?.tools).toBeUndefined()
    const result = second.find((event) => {
      return event.type === 'tool-result'
    })
    expect(result).toMatchObject({ type: 'tool-result', name: 'echo', isError: true })
    expect((result as { result: ToolResult }).result.content).toContain('unknown tool')
  })

  it('reports unknown tools and bad JSON as error results instead of throwing', async () => {
    const { llm } = mockLlm([
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
      [{ type: 'text-delta', index: 0, text: 'done' }, finishStop()],
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const results = events.filter((e) => {
      return e.type === 'tool-result'
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ name: 'nope', isError: true })
    expect(results[1]).toMatchObject({ name: 'echo', isError: true })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('surfaces stream failures as error events', async () => {
    const failing = {
      stream() {
        // biome-ignore lint/correctness/useYield: 测试替身——流立刻失败，不需要 yield
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
    const { llm } = mockLlm([
      [
        { type: 'text-delta', index: 0, text: '半截' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '半截' } },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'SERVER' } } },
      ],
    ])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(
      events.some((event) => {
        return event.type === 'done'
      }),
    ).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'error', message: 'provider exploded', code: 'SERVER' })
  })

  it('终态 aborted finish 同样传播为 error 事件', async () => {
    const { llm } = mockLlm([
      [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'client went away', code: 'ABORTED' } } }],
    ])
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
    const { llm } = mockLlm(scripted)
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool], maxSteps: 3 })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'MAX_STEPS' })
    const toolResults = events.filter((e) => {
      return e.type === 'tool-result'
    })
    expect(toolResults).toHaveLength(3)
  })
})

describe('AgentLoop 循环内上下文上限', () => {
  /** 单条工具结果就能顶满预算的假工具。 */
  function hugeTool(chars: number): Tool {
    return {
      name: 'huge',
      description: '返回超大文本',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        return { content: 'x'.repeat(chars) }
      },
    }
  }

  function toolCall(id: string): StreamChunk[] {
    return [
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: brandString<ToolCallId>(id), name: 'huge', arguments: '{}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }

  it('超长工具输出进历史时被截断并标注；事件仍带完整内容', async () => {
    const definition: AgentDefinition = { ...DEFINITION, tools: ['huge'] }
    const { llm, requests } = mockLlm([toolCall('c1'), [{ type: 'text-delta', index: 0, text: 'done' }, finishStop()]])
    const loop = new AgentLoop({ definition, llm, tools: [hugeTool(200_000)] })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const toolMessage = (requests[1]?.messages ?? []).find((message) => {
      return message.role === 'tool'
    }) as Message | undefined
    const text = (toolMessage?.content ?? [])
      .map((block) => {
        return block.type === 'text' ? block.text : ''
      })
      .join('')
    expect(estimateTokens(text)).toBeLessThanOrEqual(MAX_LOOP_CONTEXT_TOKENS + 64)
    expect(text).toContain('已截断')
    expect(text.startsWith('x')).toBe(true)
    // UI 侧拿到的是未裁剪的原始结果：落库与展开依赖它。
    const resultEvent = events.find((event) => {
      return event.type === 'tool-result'
    })
    expect((resultEvent as { result: ToolResult }).result.content).toHaveLength(200_000)
  })

  it('多步工具调用累计受同一预算约束，预算耗尽后仍回填配对的 tool 消息', async () => {
    const definition: AgentDefinition = { ...DEFINITION, tools: ['huge'] }
    const steps = 8
    const { llm, requests } = mockLlm(
      Array.from({ length: steps }, (_, i) => {
        return toolCall(`c${i}`)
      }).concat([[{ type: 'text-delta', index: 0, text: 'done' }, finishStop()]]),
    )
    // 每步 10k token（40k ASCII 字符）：8 步共 80k，必然超过 30k 预算。
    const loop = new AgentLoop({ definition, llm, tools: [hugeTool(40_000)] })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const toolMessages = (requests[requests.length - 1]?.messages ?? []).filter((message) => {
      return message.role === 'tool'
    })
    expect(toolMessages).toHaveLength(steps)
    const total = toolMessages.reduce((sum, message) => {
      return (
        sum +
        message.content.reduce((inner, block) => {
          return inner + (block.type === 'text' ? estimateTokens(block.text) : 0)
        }, 0)
      )
    }, 0)
    expect(total).toBeLessThanOrEqual(MAX_LOOP_CONTEXT_TOKENS + steps * 64) // 耗尽后每条只留一条标注
    expect(total).toBeGreaterThan(MAX_LOOP_CONTEXT_TOKENS - 200) // 预算基本用满，没有提前放弃
    // 预算耗尽后退化为一条标注，tool_call/tool_result 配对不破。
    const last = toolMessages.at(-1) as Message
    expect(last.content[0]).toEqual({ type: 'text', text: '…[已截断：本轮工具输出已用满上下文预算]' })
  })
})

/**
 * 思考强度从 agent 定义流到请求。
 *
 * 回归点是「能力有出口」：内置目录里已经有支持 reasoning_effort 的模型、运行时也会
 * 校验档位，但 loop 从来不读 definition 上的这个字段——用户设了、模型支持了，请求里
 * 却没有，于是设置静默失效。
 */
describe('AgentLoop 思考强度', () => {
  const answer: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '好' }, finishStop()]

  it('definition 配了档位，请求里就带上', async () => {
    const { llm, requests } = mockLlm([answer])
    const loop = new AgentLoop({ definition: { ...DEFINITION, reasoningEffort: 'high' }, llm, tools: [echoTool] })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(requests[0]?.reasoningEffort).toBe('high')
  })

  it('没配档位就不发字段：模型用自己默认，永远不会 400', async () => {
    const { llm, requests } = mockLlm([answer])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [echoTool] })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(requests[0]?.reasoningEffort).toBeUndefined()
  })
})

/**
 * identity 钩子：用户在「我的」页起的名字要真的排进系统提示。
 *
 * 排第一而不是排在角色设定之后，是因为模型读到「你是 Ryen…」再读到「与你对话的
 * 人叫小明」和反过来，服从程度不一样；更重要的是它必须排在记忆与经验手册之前——
 * 那两块是检索拼上来的，把「你是谁」夹在中间会被当成一条普通事实。
 */
describe('AgentLoop 身份句', () => {
  /** 跑一轮，拿回真正发出去的那条请求的 system。 */
  async function systemOf(identity?: () => string | undefined): Promise<string> {
    const { llm, requests } = mockLlm([
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '在的' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '在的' } },
        finishStop(),
      ],
    ])
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [],
      ...(identity === undefined ? {} : { identity }),
    })
    await collect(loop.run({ text: '在吗' }, { workspaceRoot: process.cwd() }))
    return requests[0]?.system ?? ''
  }

  it('身份句排在角色设定之前', async () => {
    const system = await systemOf(() => '与你对话的人叫「小明」。')
    expect(system).toContain('小明')
    expect(system.indexOf('小明')).toBeLessThan(system.indexOf(DEFINITION.systemPrompt))
  })

  it('钩子返回 undefined 时不注入（老调用方不传也不受影响）', async () => {
    expect(await systemOf()).toBe(DEFINITION.systemPrompt)
    expect(await systemOf(() => undefined)).toBe(DEFINITION.systemPrompt)
  })

  it('钩子返回空串同样按不注入处理', async () => {
    expect(await systemOf(() => '')).toBe(DEFINITION.systemPrompt)
  })

  it('每轮现取：改了名字下一句就生效，不必重启', async () => {
    let name = '小明'
    const first = await systemOf(() => `与你对话的人叫「${name}」。`)
    expect(first).toContain('小明')
    name = '小红'
    expect(await systemOf(() => `与你对话的人叫「${name}」。`)).toContain('小红')
  })
})
