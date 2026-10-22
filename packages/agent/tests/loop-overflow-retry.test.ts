import type { AgentDefinition, AgentLoopEvent, CompactionOptions } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import type { GenerateOptions, LlmRuntime, Message, RequestMessage, StreamChunk } from '@ryharness/llm'
import { createUserMessage, estimateContentTokens, HarnessError } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

const DEFINITION: AgentDefinition = {
  id: 'test-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

/** 供应商侧「请求超出上下文窗口」的错误（适配器归一后的 code）。 */
const OVERFLOW = new HarnessError('request too large for model context', 'CONTEXT_WINDOW_EXCEEDED')

const DONE: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/**
 * 只实现 stream 的假运行时：每步消费一段录制脚本（chunk 数组或要抛出的错误）。
 *
 * 用 Pick 出来的形状做单向断言而不是 `as unknown as`：LlmRuntime 是这个形状的
 * 可赋值超集，下转合法，也就不会像双重断言那样一次抹掉两侧的类型。
 */
function mockLlm(scripted: (StreamChunk[] | Error)[]): { llm: LlmRuntime; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  let call = 0
  const partial: Pick<LlmRuntime, 'stream'> = {
    stream(options: GenerateOptions) {
      requests.push(options)
      const step = scripted[call++] ?? []
      if (step instanceof Error) throw step
      const chunks = step
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  }
  return { llm: partial as LlmRuntime, requests }
}

function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  return (async () => {
    for await (const event of events) out.push(event)
    return out
  })()
}

function tokensOf(messages: readonly RequestMessage[]): number {
  let total = 0
  for (const message of messages) total += estimateContentTokens(message.content)
  return total
}

/** 本地估算装得下（小于砍半后的重试阈值）超不过，重试压缩实打实生效的历史。 */
function bigHistory(): Message[] {
  return [
    createUserMessage({ content: [{ type: 'text', text: '旧'.repeat(2000) }], source: { kind: 'user' } }),
    createUserMessage({ content: [{ type: 'text', text: '上一轮结论' }], source: { kind: 'user' } }),
  ]
}

/**
 * 小窗口（4000）+ 小输出预留（512）⇒ 输入阈值 2888、溢出重试阈值约 1439：
 * 下面的历史（约 2000 token）第一步不会预压缩（没超 2888），
 * 溢出重试时却实打实超 1439——摘要一定会被触发。
 */
function overflowLoop(args: {
  llm: LlmRuntime
  compaction?: CompactionOptions
  history?: readonly Message[]
}): AgentLoop {
  return new AgentLoop({
    definition: DEFINITION,
    llm: args.llm,
    tools: [],
    history: args.history ?? bigHistory(),
    // Infinity 关掉入口压缩：历史原样进第一步，溢出重试才是唯一的压缩时机。
    historyBudgetTokens: Number.POSITIVE_INFINITY,
    contextWindowTokens: 4000,
    maxOutputTokens: 512,
    ...(args.compaction === undefined ? {} : { compaction: args.compaction }),
  })
}

describe('AgentLoop 上下文溢出压缩重试', () => {
  it('溢出 → 激进压缩历史 → 重试一次成功', async () => {
    const summarized: Message[][] = []
    const compaction: CompactionOptions = {
      async summarize(messages) {
        summarized.push([...messages])
        return '[摘要] 旧话题要点'
      },
    }
    const { llm, requests } = mockLlm([OVERFLOW, DONE])
    const loop = overflowLoop({ llm, compaction })
    const events = await collect(loop.run({ text: '本轮问题' }, { workspaceRoot: process.cwd() }))

    expect(requests).toHaveLength(2)
    // 摘要只发生在溢出重试那一次（入口压缩被 Infinity 关掉），且拿到的是窗口外旧历史。
    expect(summarized).toHaveLength(1)
    expect(JSON.stringify(summarized[0])).toContain('旧'.repeat(64))
    // 第二次请求带上摘要、总 token 明显变小。
    expect(tokensOf(requests[1]?.messages ?? [])).toBeLessThan(tokensOf(requests[0]?.messages ?? []))
    expect(JSON.stringify(requests[1]?.messages ?? [])).toContain('[历史摘要]')
    // 重试不消耗步数，正常收尾。
    expect(events.at(-1)).toMatchObject({ type: 'done', finish: { kind: 'stop' }, steps: 1 })
  })

  it('重试一次后仍溢出：不再试第三次，按原错误收尾', async () => {
    // 显式 summarize 桩：缺省时摘要调用会复用 llm.stream，吃掉一段录制脚本。
    const compaction: CompactionOptions = { summarize: () => Promise.resolve('[摘要] 要点') }
    const { llm, requests } = mockLlm([OVERFLOW, OVERFLOW])
    const loop = overflowLoop({ llm, compaction })
    const events = await collect(loop.run({ text: '本轮问题' }, { workspaceRoot: process.cwd() }))
    expect(requests).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('非溢出错误不重试', async () => {
    const rateLimit = new HarnessError('rate limited', 'RATE_LIMIT')
    const { llm, requests } = mockLlm([rateLimit, DONE])
    const loop = overflowLoop({ llm })
    const events = await collect(loop.run({ text: '本轮问题' }, { workspaceRoot: process.cwd() }))
    expect(requests).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'RATE_LIMIT' })
  })

  it('摘要失败（fail-closed）时退回丢弃式裁剪再重试，仍能把请求收窄', async () => {
    const compaction: CompactionOptions = {
      // 返回 undefined：compactHistory 退回不做摘要，由调用方兜底裁剪。
      summarize: () => Promise.resolve(undefined),
    }
    const { llm, requests } = mockLlm([OVERFLOW, DONE])
    const loop = overflowLoop({ llm, compaction })
    const events = await collect(loop.run({ text: '本轮问题' }, { workspaceRoot: process.cwd() }))
    expect(requests).toHaveLength(2)
    expect(tokensOf(requests[1]?.messages ?? [])).toBeLessThan(tokensOf(requests[0]?.messages ?? []))
    expect(events.at(-1)).toMatchObject({ type: 'done', finish: { kind: 'stop' }, steps: 1 })
  })
})
