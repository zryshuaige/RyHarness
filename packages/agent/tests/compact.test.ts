import type { AgentDefinition, CompactSpec, Tool } from '@ryharness/agent'
import {
  AgentLoop,
  compactHistory,
  createLlmSummarizer,
  PRUNE_MARKER,
  pruneToolResults,
  resolveCompactSpec,
  resolveRequestBudget,
} from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { ContentBlock, GenerateOptions, LlmRuntime, Message, StreamChunk, ToolCallId } from '@ryharness/llm'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  estimateMessageTokens,
  estimateTokens,
} from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 一次请求的快照：messages 与循环内部的历史是同一个引用，跑完还会被追加。 */
interface RequestSnapshot {
  roles: string[]
  texts: string[]
}

/**
 * 压缩链路（预裁剪 + 摘要）的行为契约。
 *
 * 口径与断言都落在 token 上：本项目对话以中文为主，字符口径的阈值在中文与英文
 * 上差 4 倍，任何"看着差不多"的断言在这里都会失去意义。
 */

const SPEC = (over: Partial<CompactSpec> = {}): CompactSpec => {
  return { thresholdTokens: 1_000, retainTokens: 200, toolResultPruneTokens: 100, summaryMaxTokens: 100, ...over }
}

function userText(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function toolResult(text: string, callId = 'c1'): Message {
  return createToolResultMessage({
    callId: brandString<ToolCallId>(callId),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

function assistantToolCall(callId = 'c1'): Message {
  return createAssistantMessage({
    content: [{ type: 'tool-call', id: brandString<ToolCallId>(callId), name: 'shell_exec', arguments: '{}' }],
    source: { provider: 'mock', model: 'mock-model' },
  })
}

const summarizeAll = async (messages: readonly Message[]): Promise<string> => {
  return `摘要：${messages.length} 条历史 → ${estimateTokens('x'.repeat(10))} token`
}

describe('预裁剪工具输出（不需要模型的那一半）', () => {
  it('超阈值的工具结果变成 head + 标记 + tail，且明显变小', () => {
    const big = toolResult(`${'头'.repeat(200)}中段${'尾'.repeat(200)}`)
    const result = pruneToolResults([userText('问题'), assistantToolCall(), big], SPEC())
    expect(result.prunedToolResults).toBe(1)
    const pruned = result.messages[2] as Message
    const text = textOf(pruned)
    expect(text).toContain('头')
    expect(text).toContain('尾')
    expect(text).toContain(PRUNE_MARKER.trim())
    expect(estimateMessageTokens(pruned)).toBeLessThan(estimateMessageTokens(big))
  })

  it('不超阈值的工具结果原样保留（答案本身不该被裁）', () => {
    const small = toolResult('ok')
    const result = pruneToolResults([small], SPEC())
    expect(result.compacted).toBe(false)
    expect(result.messages[0]).toBe(small)
  })

  it('只动工具结果消息，user/assistant 消息原样透传', () => {
    const question = userText('问题')
    const result = pruneToolResults([question, toolResult('x'.repeat(2_000))], SPEC())
    expect(result.messages[0]).toBe(question)
  })
})

describe('阈值触发的摘要', () => {
  it('没超阈值就完全不压缩', async () => {
    const history = [userText('短'), userText('对话')]
    const result = await compactHistory(history, SPEC(), summarizeAll)
    expect(result.compacted).toBe(false)
    expect(result.summarized).toBe(false)
    expect(result.messages).toHaveLength(2)
  })

  it('超阈值：窗口外压成摘要，最近的逐字保留', async () => {
    const history = [userText('很旧'.repeat(400)), userText('中间'.repeat(200)), userText('最新的一轮')]
    const result = await compactHistory(history, SPEC(), summarizeAll)
    expect(result.summarized).toBe(true)
    expect(result.messages).toHaveLength(2)
    const summary = textOf(result.messages[0] as Message)
    expect(summary).toContain('历史摘要')
    expect(summary).toContain('摘要：')
    expect(textOf(result.messages[1] as Message)).toBe('最新的一轮')
  })

  it('预裁剪就够时不再摘要（不为省几百 token 花一次模型往返）', async () => {
    let calls = 0
    const history = [userText('问题'.repeat(300)), assistantToolCall(), toolResult('x'.repeat(4_000))]
    const result = await compactHistory(history, SPEC(), async (messages) => {
      calls += 1
      return summarizeAll(messages)
    })
    expect(result.summarized).toBe(false)
    expect(calls).toBe(0)
    expect(textOf(result.messages[2] as Message)).toContain(PRUNE_MARKER.trim())
  })

  it('摘要在阈值内完成：摘要 + 逐字窗口 ≤ 阈值', async () => {
    const history = [userText('旧'.repeat(2_000)), userText('新'.repeat(100))]
    const spec = SPEC({ thresholdTokens: 600 })
    const result = await compactHistory(history, spec, async () => {
      return '要点'.repeat(50)
    })
    const total = result.messages.reduce((sum, message) => {
      return sum + estimateMessageTokens(message)
    }, 0)
    expect(total).toBeLessThanOrEqual(spec.thresholdTokens)
  })

  it('预算装不下摘要时不做摘要（不为一段放不下的文本白跑一趟模型）', async () => {
    let calls = 0
    const history = [userText('旧'.repeat(400)), userText('新'.repeat(50))]
    // 阈值 600 < 摘要自身预留（抬头 + 1024 token 上限）：摘要挤进来必然被兜底裁剪
    // 裁掉，净效果只是多跑一次模型。
    const result = await compactHistory(history, SPEC({ thresholdTokens: 600 }), async () => {
      calls += 1
      return '要点'.repeat(50)
    })
    expect(calls).toBe(0)
    expect(result.summarized).toBe(false)
    expect(result.messages.length).toBeGreaterThan(0)
  })

  it('摘要失败/放弃时退回预裁剪结果，绝不返回空历史', async () => {
    const history = [userText('旧'.repeat(400)), userText('新'.repeat(50))]
    const failed = await compactHistory(history, SPEC(), () => {
      return Promise.reject(new Error('summarizer down'))
    })
    expect(failed.summarized).toBe(false)
    expect(failed.messages.length).toBeGreaterThan(0)
    const declined = await compactHistory(history, SPEC(), () => {
      return Promise.resolve('   ')
    })
    expect(declined.summarized).toBe(false)
    expect(declined.messages.length).toBeGreaterThan(0)
  })

  it('切点不会留下孤立的 tool 结果（切在 tool_call 与结果之间会被供应商拒绝）', async () => {
    const callId = 'pair-1'
    const history = [
      userText('很旧'.repeat(300)),
      assistantToolCall(callId),
      toolResult('工具输出'.repeat(50), callId),
      userText('最新'),
    ]
    const result = await compactHistory(history, SPEC(), summarizeAll)
    const first = result.messages[1] as Message
    expect(first.role).not.toBe('tool')
  })
})

describe('resolveCompactSpec', () => {
  it('阈值直接取请求预算的输入上限，逐字窗口按比例收', () => {
    const budget = resolveRequestBudget(32_000)
    const spec = resolveCompactSpec(budget)
    expect(spec.thresholdTokens).toBe(budget.thresholdTokens)
    expect(spec.retainTokens).toBeGreaterThan(0)
    expect(spec.retainTokens).toBeLessThan(spec.thresholdTokens)
  })

  it('显式 retainTokens 不会被预算吃掉（超过阈值时按阈值兜底）', () => {
    const budget = resolveRequestBudget(8_000)
    const spec = resolveCompactSpec(budget, { retainTokens: 999_999, toolResultPruneTokens: 0 })
    expect(spec.retainTokens).toBeLessThan(spec.thresholdTokens)
    expect(spec.toolResultPruneTokens).toBe(1)
  })
})

/**
 * 摘要调用的请求形状：注释里那两条理由（system 只领衔、指令落在最后一轮）必须仍然
 * 成立——它们曾经被写成"命中供应商 KV cache"，而那是假的（压缩换掉了前缀，摘要请求的
 * system 也与 agent 请求不同）。这组用例把**形状**钉住，让注释改不掉实现、也改不坏。
 */
describe('摘要调用的请求形状', () => {
  async function captureRequest(): Promise<{ request?: GenerateOptions }> {
    const captured: { request?: GenerateOptions } = {}
    const llm = mockLlmLike((request: GenerateOptions) => {
      captured.request = request
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '要点摘要' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '要点摘要' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    const summarize = createLlmSummarizer(llm, { provider: 'mock', model: 'mock-model' }, { summaryMaxTokens: 64 })
    await summarize([userText('很旧的一句话')])
    return captured
  }

  it('摘要指令是最后一条 user 消息，且 system 只在领衔处出现一次', async () => {
    const captured = await captureRequest()
    const request = captured.request
    expect(request).toBeDefined()
    const messages = request?.messages ?? []
    expect(messages.length).toBe(2)
    expect(messages[0]?.role).toBe('user')
    expect(textOf(messages[0])).toBe('很旧的一句话')
    expect(messages[1]?.role).toBe('user')
    expect(textOf(messages[1])).toContain('压缩成一段')
    expect(
      messages.filter((message) => {
        return message.role === 'system'
      }),
    ).toHaveLength(0)
    expect(request?.system).toBe('你是一个对话压缩器。')
    expect(request?.maxTokens).toBe(64)
  })

  it('max-tokens 截断的半截摘要被丢弃（fail-closed：半截摘要注入比没有更糟）', async () => {
    const llm = mockLlmLike(() => {
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '只写了一半的' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '只写了一半的' } }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })()
    })
    const summarize = createLlmSummarizer(llm, { provider: 'mock', model: 'mock-model' }, { summaryMaxTokens: 64 })
    await expect(summarize([userText('很旧的一句话')])).resolves.toBeUndefined()
  })
})

/**
 * 用一个自定义 stream 拼出只实现必要能力的 LlmRuntime。
 *
 * 单向断言（Pick 的形状是这个接口的可赋值超集），避免 `as unknown as` 那种
 * 一次抹掉两侧类型的双重断言。
 */
function mockLlmLike(stream: Pick<LlmRuntime, 'stream'>['stream']): LlmRuntime {
  const partial: Pick<LlmRuntime, 'stream'> & { resolveModelInfo?: LlmRuntime['resolveModelInfo'] } = {
    stream,
    async resolveModelInfo() {
      return {
        provider: 'mock',
        id: 'mock-model',
        name: 'mock',
        context: { contextWindow: 8_000 },
      }
    },
  }
  return partial as LlmRuntime
}

describe('AgentLoop × 压缩链路', () => {
  const DEFINITION: AgentDefinition = {
    id: 'c1',
    name: 'Tester',
    systemPrompt: '你是测试 agent。',
    provider: 'mock',
    model: 'mock-model',
    tools: [],
  }

  /**
   * 永远直接答完的假运行时（每次请求当场快照消息，避免被后续追加污染）。
   *
   * 用 Pick 出来的形状做单向断言而不是 `as unknown as`：LlmRuntime 是这个形状的
   * 可赋值超集，下转合法，也就不会像双重断言那样一次抹掉两侧的类型。
   */
  function plainLlm(requests: RequestSnapshot[]): LlmRuntime {
    return mockLlmLike((options: GenerateOptions) => {
      requests.push(snapshotOf(options))
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
  }

  /** 会产出一个巨大工具结果的假运行时（触发多步回填）。 */
  function fatToolLlm(requests: RequestSnapshot[]): { llm: LlmRuntime; tools: Tool[] } {
    const fat: Tool = {
      name: 'fat',
      description: '输出很大的工具。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: 'x'.repeat(20_000) }
      },
    }
    const scripted: StreamChunk[][] = [
      [
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't1' as never, name: 'fat', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'text-delta', index: 0, text: '好' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '好' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]
    return {
      tools: [fat],
      llm: mockLlmLike((options: GenerateOptions) => {
        requests.push(snapshotOf(options))
        const chunks = scripted[Math.min(requests.length - 1, scripted.length - 1)] ?? []
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      }),
    }
  }

  it('入口历史超预算时摘要掉窗口外那段（而不是静默丢弃）', async () => {
    const requests: RequestSnapshot[] = []
    const history = [
      userText('三周前定的目标'.repeat(2_000)),
      userText('上一轮的结果'.repeat(500)),
      userText('最近的一轮'),
    ]
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: plainLlm(requests),
      tools: [],
      history,
      historyBudgetTokens: 2_000,
      compaction: { summarize: summarizeAll },
    })
    for await (const _ of loop.run({ text: '本轮输入' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    const first = requests[0] as RequestSnapshot
    expect(first.texts.length).toBeLessThan(history.length + 1)
    // 被丢弃的历史以摘要形态进了请求，而不是整段消失。
    expect(first.texts.join('')).toContain('历史摘要')
    expect(first.texts.at(-1)).toBe('本轮输入')
  })

  it('compaction.enabled=false 时行为与压缩链路出现之前一致', async () => {
    const requests: RequestSnapshot[] = []
    const history = [userText('旧'.repeat(400)), userText('新'.repeat(50))]
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: plainLlm(requests),
      tools: [],
      history,
      historyBudgetTokens: 200,
      compaction: { enabled: false },
    })
    for await (const _ of loop.run({ text: '本轮输入' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    const first = requests[0] as RequestSnapshot
    expect(first.texts).toEqual(['新'.repeat(50), '本轮输入'])
  })

  it('本轮回填撑爆预算时，下一步请求前先压一次', async () => {
    const requests: RequestSnapshot[] = []
    const { llm, tools } = fatToolLlm(requests)
    const loop = new AgentLoop({
      definition: { ...DEFINITION, tools: ['fat'] },
      llm,
      tools,
      compaction: { summarize: summarizeAll, toolResultPruneTokens: 200 },
    })
    for await (const _ of loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(requests.length).toBe(2)
    const second = requests[1] as RequestSnapshot
    expect(second.roles.at(-1)).toBe('tool')
    // 20k 字符的原始输出不会原样进第二次请求。
    expect(estimateTokens(second.texts.at(-1) ?? '')).toBeLessThan(20_000 / 4)
  })
})

/** 请求当场快照：只留角色与纯文本——断言都在这两样上。 */
function snapshotOf(options: GenerateOptions): RequestSnapshot {
  return {
    roles: options.messages.map((message) => {
      return message.role
    }),
    texts: options.messages.map((message) => {
      return textOf(message)
    }),
  }
}

/** 消息里的纯文本（放宽到只要求 content：请求侧给的是 RequestMessage）。 */
function textOf(message: { content: readonly ContentBlock[] }): string {
  return message.content
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}
