import type {
  AgentDefinition,
  AgentEvolutionHooks,
  AgentLoopEvent,
  AgentMemoryHooks,
  Tool,
  ToolResult,
} from '@ryharness/agent'
import {
  ABORTED_CODE,
  type AbortedError,
  AgentLoop,
  DEFAULT_TOOL_CONCURRENCY,
  isAbortedError,
  trimHistoryToBudget,
} from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, Message, StreamChunk, ToolCallId } from '@ryharness/llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

const DEFINITION: AgentDefinition = {
  id: 'test-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['slow', 'fast', 'serial'],
}

/** 脚本化的假 LlmRuntime：每次 stream() 消费一段录制 chunk。 */
function mockLlm(scripted: StreamChunk[][]): { llm: LlmRuntime; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  let call = 0
  const partial = {
    stream(options: GenerateOptions) {
      requests.push(options)
      const chunks = scripted[call++] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return { llm: partial, requests }
}

/**
 * 只实现 stream 的假运行时，并把每次请求的 system 抓出来。
 *
 * 用 Pick 出来的形状做单向断言而不是 `as unknown as`：LlmRuntime 是这个形状的
 * 可赋值超集，下转合法，也就不会像双重断言那样一次抹掉两侧的类型。
 */
function systemSpy(inner: LlmRuntime, onStream?: () => void): { llm: LlmRuntime; systems: string[] } {
  const systems: string[] = []
  const partial: Pick<LlmRuntime, 'stream'> = {
    stream(options: GenerateOptions) {
      systems.push(options.system ?? '')
      onStream?.()
      return inner.stream(options)
    },
  }
  return { llm: partial as LlmRuntime, systems }
}

function toolCallChunks(calls: { id: string; name: string; args: string }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, call] of calls.entries()) {
    const id = brandString<ToolCallId>(call.id)
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.args })
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.args } })
  }
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

const DONE: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'finish', reason: { kind: 'stop' } },
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 记录 start/end 的假工具；start 先于 end 说明两个调用确实重叠执行。 */
function loggingTool(name: string, log: string[], ms: number, executionMode?: 'sequential' | 'parallel'): Tool {
  return {
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {} },
    ...(executionMode === undefined ? {} : { executionMode }),
    async execute(): Promise<ToolResult> {
      log.push(`${name}:start`)
      await delay(ms)
      log.push(`${name}:end`)
      return { content: name }
    },
  }
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('AgentLoop 工具调用并行', () => {
  it('同一条消息里的多个工具并发执行，结果按 call 顺序回填', async () => {
    const log: string[] = []
    const { llm } = mockLlm([
      toolCallChunks([
        { id: 'c1', name: 'slow', args: '{}' },
        { id: 'c2', name: 'fast', args: '{}' },
      ]),
      DONE,
    ])
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [loggingTool('slow', log, 20), loggingTool('fast', log, 0)],
    })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    // 并发：两个工具都先 start，才各自 end（串行会是 start/end/start/end）。
    expect(log).toEqual(['slow:start', 'fast:start', 'fast:end', 'slow:end'])
    const results = events.filter((event) => {
      return event.type === 'tool-result'
    })
    // 事件顺序按模型给出的 call 顺序，与完成先后无关。
    expect(
      results.map((event) => {
        return event.type === 'tool-result' ? event.name : ''
      }),
    ).toEqual(['slow', 'fast'])
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 2 })
  })

  it('声明 executionMode: sequential 的工具让整批退回串行', async () => {
    const log: string[] = []
    const { llm } = mockLlm([
      toolCallChunks([
        { id: 'c1', name: 'slow', args: '{}' },
        { id: 'c2', name: 'serial', args: '{}' },
      ]),
      DONE,
    ])
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [loggingTool('slow', log, 10), loggingTool('serial', log, 0, 'sequential')],
    })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(log).toEqual(['slow:start', 'slow:end', 'serial:start', 'serial:end'])
  })
})

describe('AgentLoop 工具并发上限', () => {
  /** 记录并发峰值（active 的最大同时存活数）的假工具。 */
  function peakTool(name: string, probe: { active: number; peak: number }, ms: number): Tool {
    return {
      name,
      description: `测试工具 ${name}`,
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        probe.active += 1
        probe.peak = Math.max(probe.peak, probe.active)
        await delay(ms)
        probe.active -= 1
        return { content: name }
      },
    }
  }

  it('一批调用的并发峰值不超过默认上限，结果仍按 call 顺序回填', async () => {
    const probe = { active: 0, peak: 0 }
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
    const { llm } = mockLlm([
      toolCallChunks(
        names.map((name, index) => {
          return { id: `c${index + 1}`, name, args: '{}' }
        }),
      ),
      DONE,
    ])
    const loop = new AgentLoop({
      definition: { ...DEFINITION, tools: names },
      llm,
      tools: names.map((name) => {
        return peakTool(name, probe, 20)
      }),
    })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    // 8 个慢工具足以吃满上限：峰值恰好等于默认并发度 4，而不是 8 路全并发。
    expect(probe.peak).toBeLessThanOrEqual(DEFAULT_TOOL_CONCURRENCY)
    expect(probe.peak).toBe(4)
    const order = events
      .filter((event) => {
        return event.type === 'tool-result'
      })
      .map((event) => {
        return event.type === 'tool-result' ? event.name : ''
      })
    expect(order).toEqual(names)
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 2 })
  })

  it('单个工具抛错被兜成错误结果，不影响同批其他工具的收集与顺序', async () => {
    const names = ['ok1', 'boom', 'ok2']
    const boom: Tool = {
      name: 'boom',
      description: '抛错的工具',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        throw new Error('boom')
      },
    }
    const { llm } = mockLlm([
      toolCallChunks(
        names.map((name, index) => {
          return { id: `c${index + 1}`, name, args: '{}' }
        }),
      ),
      DONE,
    ])
    const loop = new AgentLoop({
      definition: { ...DEFINITION, tools: names },
      llm,
      tools: [loggingTool('ok1', [], 15), boom, loggingTool('ok2', [], 0)],
    })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    const results = events.filter((event) => {
      return event.type === 'tool-result'
    })
    expect(
      results.map((event) => {
        return event.type === 'tool-result' ? event.name : ''
      }),
    ).toEqual(names)
    const failed = results.map((event) => {
      return event.type === 'tool-result' ? event : undefined
    })[1]
    expect(failed?.isError).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: 2 })
  })
})

describe('AgentLoop 记忆召回不进首 token 关键路径', () => {
  it('有同步召回时：模型请求在异步 recall 结束之前就已发出', async () => {
    let asyncRecallDone = false
    const memory: AgentMemoryHooks = {
      recallSync() {
        return '[记忆] 画像'
      },
      async recall() {
        await delay(30)
        asyncRecallDone = true
        return '[记忆] async'
      },
      async recallRefine() {
        return true
      },
      enqueueExtraction() {},
    }
    const base = mockLlm([[...DONE]])
    let streamedBeforeAsyncRecall = false
    const spy = systemSpy(base.llm, () => {
      streamedBeforeAsyncRecall = !asyncRecallDone
    })
    const loop = new AgentLoop({ definition: DEFINITION, llm: spy.llm, tools: [], memory })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(streamedBeforeAsyncRecall).toBe(true)
    expect(spy.systems[0]).toContain('[记忆] 画像')
  })

  it('同步召回与进化编译都进 system prompt', async () => {
    const memory: AgentMemoryHooks = {
      recallSync() {
        return '[记忆] 画像'
      },
      recall() {
        return Promise.reject(new Error('不该走到 await 路径'))
      },
      enqueueExtraction() {},
    }
    const evolution: AgentEvolutionHooks = {
      async compile() {
        await delay(1)
        return { text: '[经验手册]', playbookEntryIds: ['e1'], reflectionIds: [] }
      },
      enqueueTurn() {},
    }
    const spy = systemSpy(mockLlm([[...DONE]]).llm)
    const loop = new AgentLoop({ definition: DEFINITION, llm: spy.llm, tools: [], memory, evolution })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(spy.systems[0]).toContain('[记忆] 画像')
    expect(spy.systems[0]).toContain('[经验手册]')
  })

  it('没有同步入口的旧绑定对象仍走 await 路径并静默降级', async () => {
    const log: string[] = []
    const memory: AgentMemoryHooks = {
      async recall() {
        log.push('recall:start')
        await delay(5)
        log.push('recall:end')
        return '[记忆] 画像'
      },
      enqueueExtraction() {},
    }
    const spy = systemSpy(mockLlm([[...DONE]]).llm)
    const loop = new AgentLoop({ definition: DEFINITION, llm: spy.llm, tools: [], memory })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(log).toEqual(['recall:start', 'recall:end'])
    expect(spy.systems[0]).toContain('[记忆] 画像')
  })

  it('一侧故障仍然静默降级', async () => {
    const memory: AgentMemoryHooks = {
      async recall() {
        throw new Error('memory down')
      },
      enqueueExtraction() {},
    }
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm([[...DONE]]).llm, tools: [], memory })
    const events = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))
    expect(events).toEqual([
      { type: 'text-delta', text: 'done' },
      { type: 'done', finish: { kind: 'stop' }, steps: 1 },
    ])
  })
})

describe('AgentLoop 历史预算裁剪', () => {
  it('超预算从最旧丢弃，保留最近消息', async () => {
    const history: Message[] = [
      createUserMessage({ content: [{ type: 'text', text: '最旧'.repeat(400) }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: '中间' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: '最新' }], source: { kind: 'user' } }),
    ]
    const { llm, requests } = mockLlm([[...DONE]])
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [], history, historyBudgetTokens: 200 })
    await collect(loop.run({ text: '本轮' }, { workspaceRoot: process.cwd() }))
    const texts = (requests[0]?.messages ?? []).map((message) => {
      return JSON.stringify(message.content)
    })
    expect(texts.join()).not.toContain('最旧')
    expect(texts.join()).toContain('中间')
    expect(texts.join()).toContain('本轮')
  })

  it('Infinity 预算关闭裁剪', () => {
    const history: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })]
    expect(trimHistoryToBudget(history, Number.POSITIVE_INFINITY)).toHaveLength(1)
  })

  it('窗口首条不留下孤立的 tool 结果', () => {
    const callId = brandString<ToolCallId>('c1')
    const history: Message[] = [
      createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'echo', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock-model' },
      }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'y'.repeat(500) }], isError: false }),
      createUserMessage({ content: [{ type: 'text', text: '最新' }], source: { kind: 'user' } }),
    ]
    const trimmed = trimHistoryToBudget(history, 100)
    expect(trimmed.at(-1)?.role).toBe('user')
    expect(
      trimmed.some((message) => {
        return message.role === 'tool'
      }),
    ).toBe(false)
  })
})

describe('AgentLoop 取消', () => {
  it('传入已取消的 signal：不调模型，直接抛 AbortedError', async () => {
    const { llm, requests } = mockLlm([[...DONE]])
    const controller = new AbortController()
    controller.abort()
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [] })
    const error = await collect(
      loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }, { signal: controller.signal }),
    ).catch((thrown: unknown) => {
      return thrown
    })
    expect(isAbortedError(error)).toBe(true)
    expect((error as AbortedError).code).toBe(ABORTED_CODE)
    expect(requests).toHaveLength(0)
  })

  it('取消后不再执行工具，也不发起下一次模型调用', async () => {
    const log: string[] = []
    const controller = new AbortController()
    const { llm, requests } = mockLlm([
      [
        ...toolCallChunks([{ id: 'c1', name: 'slow', args: '{}' }]).slice(0, -1),
        { type: 'finish', reason: { kind: 'aborted', failure: { message: 'client went away', code: 'ABORTED' } } },
      ],
    ])
    const abortingLlm = {
      stream(options: GenerateOptions) {
        const source = llm.stream(options)
        return (async function* (): AsyncGenerator<StreamChunk> {
          for await (const chunk of source) {
            yield chunk
            if (chunk.type === 'block-end') controller.abort()
          }
        })()
      },
    } as unknown as LlmRuntime
    const loop = new AgentLoop({
      definition: { ...DEFINITION, tools: ['slow'] },
      llm: abortingLlm,
      tools: [loggingTool('slow', log, 0)],
    })
    const events: AgentLoopEvent[] = []
    const error = await (async (): Promise<unknown> => {
      try {
        for await (const event of loop.run(
          { text: 'hi' },
          { workspaceRoot: process.cwd() },
          { signal: controller.signal },
        )) {
          events.push(event)
        }
        return undefined
      } catch (thrown: unknown) {
        return thrown
      }
    })()
    expect(isAbortedError(error)).toBe(true)
    expect(log).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('signal 透传给模型请求与工具上下文', async () => {
    const controller = new AbortController()
    let toolSignal: AbortSignal | undefined
    const tool: Tool = {
      name: 'slow',
      description: '测试',
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        toolSignal = ctx.signal
        return { content: 'ok' }
      },
    }
    const { llm, requests } = mockLlm([toolCallChunks([{ id: 'c1', name: 'slow', args: '{}' }]), [...DONE]])
    const loop = new AgentLoop({ definition: { ...DEFINITION, tools: ['slow'] }, llm, tools: [tool] })
    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }, { signal: controller.signal }))
    expect(requests[0]?.signal).toBe(controller.signal)
    expect(toolSignal).toBe(controller.signal)
  })

  it('ToolContext.signal 同样生效（无 run options 时）', async () => {
    const controller = new AbortController()
    controller.abort()
    const loop = new AgentLoop({ definition: DEFINITION, llm: mockLlm([[...DONE]]).llm, tools: [] })
    const error = await collect(
      loop.run({ text: 'hi' }, { workspaceRoot: process.cwd(), signal: controller.signal }),
    ).catch((thrown: unknown) => {
      return thrown
    })
    expect(isAbortedError(error)).toBe(true)
  })
})
