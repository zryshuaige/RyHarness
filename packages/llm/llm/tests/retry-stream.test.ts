import { Context } from '@ryagent/cordis'
import type { ResolvedRetryPolicy, StreamChunk } from '@ryagent/llm'
import LlmRuntime, { LlmAdapter, LlmError, resolveRetryPolicy, streamWithRetry } from '@ryagent/llm'
import { describe, expect, it } from 'vitest'

/** 快速退避策略：测试不等真实 backoff。 */
const FAST: ResolvedRetryPolicy = resolveRetryPolicy(
  { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 1, maxDelayMs: 4, jitterRatio: 0 } },
  'test',
)

function errorFinish(code: string, providerRetryAfterMs?: number): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: `failure ${code}`,
        code,
        ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      },
    },
  }
}

const TEXT_CHUNKS: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 按脚本顺序开启尝试的 open()，记录调用次数。 */
function scriptedOpen(scripts: StreamChunk[][]): { open: () => AsyncIterable<StreamChunk>; calls: () => number } {
  let calls = 0
  return {
    open() {
      const chunks = scripts[calls++] ?? scripts[scripts.length - 1] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
    calls: () => {
      return calls
    },
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('streamWithRetry（单元）', () => {
  it('可重试错误码（EMPTY_RESPONSE）在无任何内容时重试并成功', async () => {
    const { open, calls } = scriptedOpen([[errorFinish('EMPTY_RESPONSE')], TEXT_CHUNKS])
    const chunks = await collect(streamWithRetry(FAST, open))
    expect(calls()).toBe(2)
    expect(
      chunks.map((c) => {
        return c.type
      }),
    ).toEqual(['text-delta', 'block-end', 'finish'])
  })

  it('maxRetries 用完后把最后一次失败作为终态 error finish 透出', async () => {
    const policy = resolveRetryPolicy(
      { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 4, jitterRatio: 0 } },
      'test',
    )
    const { open, calls } = scriptedOpen([[errorFinish('SERVER')]])
    const chunks = await collect(streamWithRetry(policy, open))
    expect(calls()).toBe(3) // 首次 + 2 次重试
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } })
  })

  it('不可重试错误码（AUTH）直接透出，不重试', async () => {
    const { open, calls } = scriptedOpen([[errorFinish('AUTH')], TEXT_CHUNKS])
    const chunks = await collect(streamWithRetry(FAST, open))
    expect(calls()).toBe(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  })

  it('已交付内容的流失败不重试（避免重复内容）', async () => {
    const partialThenError: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '半截' }, errorFinish('TIMEOUT')]
    const { open, calls } = scriptedOpen([partialThenError, TEXT_CHUNKS])
    const chunks = await collect(streamWithRetry(FAST, open))
    expect(calls()).toBe(1)
    expect(
      chunks.map((c) => {
        return c.type
      }),
    ).toEqual(['text-delta', 'finish'])
  })

  it('QUOTA 无 Retry-After 不重试；带 Retry-After 重试', async () => {
    const noHint = scriptedOpen([[errorFinish('QUOTA')], TEXT_CHUNKS])
    await collect(streamWithRetry(FAST, noHint.open))
    expect(noHint.calls()).toBe(1)

    const withHint = scriptedOpen([[errorFinish('QUOTA', 1)], TEXT_CHUNKS])
    const chunks = await collect(streamWithRetry(FAST, withHint.open))
    expect(withHint.calls()).toBe(2)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('失败尝试的 usage 不重复上报', async () => {
    const failedAttempt: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } },
      errorFinish('EMPTY_RESPONSE'),
    ]
    const succeeded: StreamChunk[] = [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, ...TEXT_CHUNKS]
    const { open, calls } = scriptedOpen([failedAttempt, succeeded])
    const chunks = await collect(streamWithRetry(FAST, open))
    expect(calls()).toBe(2)
    const usages = chunks.filter((c) => {
      return c.type === 'usage'
    })
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ usage: { outputTokens: 2 } })
  })

  it('退避期间 abort 立即终止重试，透出 aborted 终态', async () => {
    const controller = new AbortController()
    const slow = resolveRetryPolicy(
      { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 5_000, maxDelayMs: 10_000, jitterRatio: 0 } },
      'test',
    )
    const { open, calls } = scriptedOpen([[errorFinish('TIMEOUT')], TEXT_CHUNKS])
    setTimeout(() => {
      controller.abort()
    }, 10)
    const chunks = await collect(streamWithRetry(slow, open, controller.signal))
    expect(calls()).toBe(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'TIMEOUT' } } })
  })
})

/** 第一次调用抛 SERVER（可重试），之后正常回复的适配器。 */
class FlakyAdapter extends LlmAdapter {
  calls = 0

  constructor(
    private readonly failures: number,
    private readonly code: string,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Flaky' }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return FAST
  }

  stream(): AsyncIterable<StreamChunk> {
    this.calls++
    const fail = this.calls <= this.failures
    const code = this.code
    return (async function* (): AsyncGenerator<StreamChunk> {
      if (fail) throw new LlmError(`flaky ${code}`, code)
      yield* TEXT_CHUNKS
    })()
  }
}

async function makeRuntime(adapter: LlmAdapter): Promise<{ ctx: Context; llm: LlmRuntime }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['flaky'], adapter)
  return { ctx, llm: ctx.llm }
}

const REQUEST: { provider: string; model: string; messages: [] } = {
  provider: 'flaky',
  model: 'm',
  messages: [],
}

describe('LlmRuntime 重试接线', () => {
  it('适配器抛出可重试错误 → 重试后对消费方透明', async () => {
    const adapter = new FlakyAdapter(2, 'SERVER')
    const { llm } = await makeRuntime(adapter)
    const chunks = await collect(llm.stream({ ...REQUEST }))
    expect(adapter.calls).toBe(3)
    expect(
      chunks.map((c) => {
        return c.type
      }),
    ).toEqual(['text-delta', 'block-end', 'finish'])
  })

  it('不可重试错误（AUTH）一次即终态 error finish', async () => {
    const adapter = new FlakyAdapter(99, 'AUTH')
    const { llm } = await makeRuntime(adapter)
    const chunks = await collect(llm.stream({ ...REQUEST }))
    expect(adapter.calls).toBe(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  })

  it('可重试错误超过 maxRetries 后透出终态 error finish', async () => {
    const adapter = new FlakyAdapter(99, 'SERVER')
    const { llm } = await makeRuntime(adapter)
    const chunks = await collect(llm.stream({ ...REQUEST }))
    expect(adapter.calls).toBe(4) // 首次 + 默认/策略 maxRetries=3
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } })
  })
})
