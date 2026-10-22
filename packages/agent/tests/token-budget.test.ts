import type { AgentDefinition, AgentLoopEvent, Tool } from '@ryharness/agent'
import { AgentLoop, FALLBACK_CONTEXT_WINDOW_TOKENS, resolveRequestBudget } from '@ryharness/agent'
import type { GenerateOptions, LlmRuntime, Message, StreamChunk } from '@ryharness/llm'
import { createUserMessage, estimateTokens } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

const DEFINITION: AgentDefinition = {
  id: 'budget-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

/** 一件描述很长的工具：工具声明本身就是 prompt 的大头。 */
const fatTool: Tool = {
  name: 'fat',
  description: '一个描述特别长的工具。'.repeat(200),
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令。'.repeat(50) } },
    required: ['command'],
  },
  async execute() {
    return { content: 'ok' }
  },
}

const slimTool: Tool = {
  name: 'fat',
  description: '短描述',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { content: 'ok' }
  },
}

/**
 * 只实现 stream / resolveModelInfo 的假运行时。
 *
 * 用 Pick 出来的形状做单向断言而不是 `as unknown as`：LlmRuntime 是这个形状的
 * 可赋值超集，下转合法，也就不会像双重断言那样一次抹掉两侧的类型。
 */
function fakeLlm(
  stream: Pick<LlmRuntime, 'stream'>['stream'],
  resolveModelInfo?: LlmRuntime['resolveModelInfo'],
): LlmRuntime {
  const partial: Pick<LlmRuntime, 'stream'> & { resolveModelInfo?: LlmRuntime['resolveModelInfo'] } = {
    stream,
    ...(resolveModelInfo === undefined ? {} : { resolveModelInfo }),
  }
  return partial as LlmRuntime
}

/** 记录每次请求的假运行时；给定窗口时按该窗口自报能力元数据。 */
function mockLlm(
  contextWindow?: number,
  rejectModelInfo = false,
): { llm: LlmRuntime; requests: GenerateOptions[]; sentCounts: number[] } {
  const requests: GenerateOptions[] = []
  // messages 数组与循环内部的 history 是同一个引用，跑完还会被追加 assistant
  // 消息；「这一发到底送了几条」必须在 stream() 里当场记。
  const sentCounts: number[] = []
  const llm = fakeLlm(
    (options: GenerateOptions) => {
      requests.push(options)
      sentCounts.push(options.messages.length)
      const chunks: StreamChunk[] = [
        { type: 'text-delta', index: 0, text: 'done' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
    () => {
      if (rejectModelInfo) return Promise.reject(new Error('resolveModelInfo down'))
      return Promise.resolve({
        provider: 'mock',
        id: 'mock-model',
        name: 'mock',
        ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
      })
    },
  )
  return { llm, requests, sentCounts }
}

/** 跑一轮并返回落进请求的历史条数与请求本身。 */
async function runOnce(options: {
  contextWindow?: number
  contextWindowTokens?: number
  rejectModelInfo?: boolean
  systemPrompt?: string
  history?: Message[]
  tools?: Tool[]
  historyBudgetTokens?: number
}): Promise<{ requests: GenerateOptions[]; kept: number }> {
  const { llm, requests, sentCounts } = mockLlm(options.contextWindow, options.rejectModelInfo === true)
  const loop = new AgentLoop({
    definition: {
      ...DEFINITION,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      tools: (options.tools ?? []).map((tool) => {
        return tool.name
      }),
    },
    llm,
    tools: options.tools ?? [],
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.historyBudgetTokens === undefined ? {} : { historyBudgetTokens: options.historyBudgetTokens }),
    ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
  })
  for await (const _event of loop.run({ text: '本轮输入' }, { workspaceRoot: process.cwd() })) {
    /* drain */
  }
  return { requests, kept: sentCounts[0] ?? 0 }
}

function userText(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('resolveRequestBudget 三段式', () => {
  it('窗口未知时用兜底窗口，且预算为正', () => {
    const budget = resolveRequestBudget(undefined)
    expect(budget.contextWindowTokens).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS)
    expect(budget.thresholdTokens).toBeGreaterThan(0)
    expect(budget.thresholdTokens).toBeLessThan(budget.contextWindowTokens)
  })

  it('窗口越小预算越小，且给输出留出了预留', () => {
    const small = resolveRequestBudget(8_000)
    const large = resolveRequestBudget(200_000)
    expect(small.thresholdTokens).toBeLessThan(large.thresholdTokens)
    expect(small.thresholdTokens + small.reservedCompletionTokens).toBeLessThanOrEqual(small.contextWindowTokens)
  })

  it('非法窗口（0 / 负数 / NaN）退回兜底，而不是给出 0 预算', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(resolveRequestBudget(bad).thresholdTokens).toBe(resolveRequestBudget(undefined).thresholdTokens)
    }
  })

  it('窗口优先级：目录已知 > 用户覆盖 > 兜底默认', () => {
    // 目录报了就用目录的，覆盖值再大都是摆设。
    expect(resolveRequestBudget(32_000, undefined, 200_000).contextWindowTokens).toBe(32_000)
    // 目录没报（或报了个非法值）才轮到用户覆盖值。
    expect(resolveRequestBudget(undefined, undefined, 8_000).contextWindowTokens).toBe(8_000)
    expect(resolveRequestBudget(Number.NaN, undefined, 8_000).contextWindowTokens).toBe(8_000)
    // 覆盖值本身非法时与缺省同待遇：退回兜底，而不是给出 0 预算。
    expect(resolveRequestBudget(undefined, undefined, 0).contextWindowTokens).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS)
    expect(resolveRequestBudget(undefined).contextWindowTokens).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS)
  })
})

describe('AgentLoop 请求预算', () => {
  it('每步都显式带 maxTokens，且不超过模型窗口', async () => {
    const { requests } = await runOnce({ contextWindow: 32_000, tools: [fatTool] })
    const maxTokens = requests[0]?.maxTokens
    expect(maxTokens).toBeGreaterThan(0)
    expect(maxTokens).toBeLessThanOrEqual(32_000)
  })

  it('拿不到能力元数据时仍有 maxTokens（输出预留不能是 0）', async () => {
    const { requests } = await runOnce({ tools: [fatTool] })
    expect(requests[0]?.maxTokens).toBeGreaterThan(0)
  })

  it('输出预留可由调用方指定', async () => {
    const { llm, requests } = mockLlm(32_000)
    const loop = new AgentLoop({
      definition: { ...DEFINITION, tools: ['fat'] },
      llm,
      tools: [fatTool],
      maxOutputTokens: 1_000,
    })
    for await (const _event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(requests[0]?.maxTokens).toBeLessThanOrEqual(1_000)
  })

  it('工具声明计入输入预算：同样窗口下，长声明能多挤掉一条历史', async () => {
    const history = [userText('旧'.repeat(600)), userText('中'.repeat(600)), userText('新'.repeat(600))]
    const slim = await runOnce({ contextWindow: 8_000, history, tools: [slimTool] })
    const fat = await runOnce({ contextWindow: 8_000, history, tools: [fatTool] })
    expect(estimateTokens(fatTool.description)).toBeGreaterThan(500)
    expect(fat.kept).toBeLessThan(slim.kept)
  })

  it('系统提示计入输入预算：超长人设会让历史只剩最后一条', async () => {
    const history = [userText('甲'.repeat(400)), userText('乙'.repeat(400)), userText('丙'.repeat(400))]
    const short = await runOnce({ contextWindow: 8_000, history, systemPrompt: '短人设。' })
    const long = await runOnce({ contextWindow: 8_000, history, systemPrompt: '长人设。'.repeat(3_000) })
    expect(short.kept).toBeGreaterThan(long.kept)
    expect(long.kept).toBe(2) // 只剩最后一条历史 + 本轮输入
  })

  it('中文历史按 token 而非字符裁剪：同一字符预算下中文被砍得更少', async () => {
    // 中文 400 token/条（400 字）；英文 2000 token/条（8000 字符）。
    const chinese = [userText('中文'.repeat(200)), userText('中文'.repeat(200))]
    const english = [userText('abcdefgh'.repeat(1_000)), userText('abcdefgh'.repeat(1_000))]
    // 预算 1000 token：两条中文（800）都留，两条英文（4000）只剩一条。
    expect((await runOnce({ history: chinese, historyBudgetTokens: 1_000 })).kept).toBe(3)
    expect((await runOnce({ history: english, historyBudgetTokens: 1_000 })).kept).toBe(2)
  })

  it('调用方显式钉住预算时以调用方为准', async () => {
    const history = [userText('甲'.repeat(400)), userText('乙'.repeat(400)), userText('丙'.repeat(400))]
    // 400 token/条 × 3 条 = 1200：预算 2000 全留，预算 500 只留最后一条。
    expect((await runOnce({ history, historyBudgetTokens: 2_000 })).kept).toBe(4)
    expect((await runOnce({ history, historyBudgetTokens: 500 })).kept).toBe(2)
  })

  /**
   * 用户覆盖值（contextWindowTokens）的接线契约：目录没报窗口时它进预算，目录
   * 报了它就必须让位——「填了但没进内核」与「盖住了目录真值」是这类接线最常见的
   * 两种坏法，这里各钉一条。
   */
  describe('用户覆盖的上下文窗口', () => {
    // 40 × 400 token = 16000：兜底窗口（64k）全留，8k 窗口只留得下最后几条。
    const history = Array.from({ length: 40 }, (_, index) => {
      return userText(`第${index}条`.padEnd(400, '甲'))
    })

    it('目录没报窗口时按用户覆盖值留历史（覆盖值真正进了内核）', async () => {
      const fallback = await runOnce({ history })
      const narrowed = await runOnce({ history, contextWindowTokens: 8_000 })
      expect(fallback.kept).toBe(history.length + 1)
      expect(narrowed.kept).toBeLessThan(fallback.kept)
    })

    it('目录已知长度优先于用户覆盖值（覆盖值盖不住真值）', async () => {
      const catalog = await runOnce({ contextWindow: 8_000, history })
      const both = await runOnce({ contextWindow: 8_000, contextWindowTokens: 200_000, history })
      expect(both.kept).toBe(catalog.kept)
    })

    it('resolveModelInfo 挂了也不丢覆盖值：退回覆盖窗口而不是直接兜底', async () => {
      const catalog = await runOnce({ contextWindow: 8_000, history })
      const rescued = await runOnce({ rejectModelInfo: true, contextWindowTokens: 8_000, history })
      expect(rescued.kept).toBe(catalog.kept)
    })
  })
})

describe('AgentLoop maxTokens 随 prompt 收口', () => {
  it('多步工具循环里，后一步的 maxTokens 不大于前一步', async () => {
    const scripted: StreamChunk[][] = [
      [
        {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c0' as never,
            name: 'fat',
            arguments: JSON.stringify({ pad: 'x'.repeat(2_000) }),
          },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'c1' as never,
            name: 'fat',
            arguments: JSON.stringify({ pad: 'x'.repeat(2_000) }),
          },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'text-delta', index: 0, text: 'done' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]
    const requests: GenerateOptions[] = []
    const llm = fakeLlm(
      (options: GenerateOptions) => {
        requests.push(options)
        const chunks = scripted[requests.length - 1] ?? []
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      },
      () => {
        return Promise.resolve({
          provider: 'mock',
          id: 'mock-model',
          name: 'mock',
          context: { contextWindow: 8_000 },
        })
      },
    )
    const loop = new AgentLoop({ definition: { ...DEFINITION, tools: ['fat'] }, llm, tools: [fatTool] })
    const events: AgentLoopEvent[] = []
    for await (const event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) events.push(event)
    expect(events.at(-1)?.type).toBe('done')
    expect(requests.length).toBe(3)
    const first = requests[0]?.maxTokens as number
    const last = requests.at(-1)?.maxTokens as number
    // 输入每步都在涨（工具结果回填），输出预留必须随之收口，否则最后一步
    // 「输入 + 输出」会一起越过 8k 窗口。
    expect(last).toBeLessThanOrEqual(first)
    expect(first).toBeGreaterThan(0)
  })
})
