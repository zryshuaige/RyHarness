/**
 * 首 token 路径的性能不变量（不进默认 CI 通道，见 vitest.perf.config.ts）。
 *
 * 同 recall.perf.ts 的口径：断言写成**比值 / 上界**，不写绝对毫秒数。这里用
 * 一段人工延迟（记忆 embedding 的模拟网络往返）作标尺——真实机器再慢，
 * "同步路径 vs 等一次网络往返"的倍数关系也不变。
 *
 * @module
 */

import type { AgentDefinition, AgentMemoryHooks, Tool } from '@ryharness/agent'
import { AgentLoop } from '@ryharness/agent'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryharness/llm'
import { estimateTokens } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 模拟一次 embedding 网络往返的耗时；比真实端点保守一个量级。 */
const NETWORK_MS = 200

const DEFINITION: AgentDefinition = {
  id: 'perf-agent',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['shell_exec'],
}

const tool: Tool = {
  name: 'shell_exec',
  description: '执行一条 shell 命令',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  async execute() {
    return { content: 'ok' }
  },
}

/**
 * 只实现 stream 的假运行时。
 *
 * 用 Pick 出来的形状做单向断言而不是 `as unknown as`：LlmRuntime 是这个形状的
 * 可赋值超集，下转合法，也就不会像双重断言那样一次抹掉两侧的类型。
 */
function fakeLlm(stream: Pick<LlmRuntime, 'stream'>['stream']): LlmRuntime {
  const partial: Pick<LlmRuntime, 'stream'> = { stream }
  return partial as LlmRuntime
}

function mockLlm(): { llm: LlmRuntime; streamAt: () => number } {
  let streamAt = 0
  const llm = fakeLlm((_options: GenerateOptions) => {
    streamAt = Date.now()
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  })
  return { llm, streamAt: () => streamAt }
}

function delayed(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 旧的记忆钩子形状：只能 await，接一次网络往返。 */
function awaitOnlyMemory(): AgentMemoryHooks {
  return {
    async recall() {
      await delayed(NETWORK_MS)
      return '[记忆] 画像'
    },
    enqueueExtraction() {},
  }
}

/** 新的两段式形状：同步召回开流，embedding 落到后台。 */
function twoStageMemory(): AgentMemoryHooks {
  return {
    recallSync() {
      return '[记忆] 画像'
    },
    async recall() {
      await delayed(NETWORK_MS)
      return '[记忆] 画像'
    },
    async recallRefine() {
      await delayed(NETWORK_MS)
      return true
    },
    enqueueExtraction() {},
  }
}

async function firstTokenDelay(memory: AgentMemoryHooks): Promise<number> {
  const { llm, streamAt } = mockLlm()
  const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [tool], memory })
  const started = Date.now()
  for await (const _event of loop.run({ text: '帮我跑个命令' }, { workspaceRoot: process.cwd() })) {
    /* drain */
  }
  return streamAt() - started
}

describe('记忆召回对首 token 的贡献', () => {
  it('两段式召回把首 token 的等待压到网络往返的一个零头', async () => {
    const awaitOnly = await firstTokenDelay(awaitOnlyMemory())
    const twoStage = await firstTokenDelay(twoStageMemory())
    // 同步召回不含任何 await；剩下的只是本进程内的一次工具 schema 估算。
    expect(twoStage).toBeLessThan(awaitOnly / 4)
  })

  it('注入块照样出现在 system prompt 里（提速没有牺牲召回质量）', async () => {
    const seen: string[] = []
    const llmSpy = fakeLlm((options: GenerateOptions) => {
      seen.push(options.system ?? '')
      return mockLlm().llm.stream(options)
    })
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm: llmSpy,
      tools: [tool],
      memory: twoStageMemory(),
    })
    for await (const _event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('[记忆] 画像')
  })

  it('后台补正不拖住事件流（循环在补正结束前就已经收尾）', async () => {
    let refined = false
    const memory: AgentMemoryHooks = {
      recallSync: () => '[记忆] 画像',
      recall: () => Promise.reject(new Error('不该走到 await 路径')),
      async recallRefine() {
        await delayed(NETWORK_MS)
        refined = true
        return true
      },
      enqueueExtraction() {},
    }
    const { llm } = mockLlm()
    const loop = new AgentLoop({ definition: DEFINITION, llm, tools: [tool], memory })
    const started = Date.now()
    for await (const _event of loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    expect(refined).toBe(false)
    expect(Date.now() - started).toBeLessThan(NETWORK_MS / 4)
  })
})

describe('token 预算计算本身的开销', () => {
  it('估算 100k 字符历史的耗时远小于一次网络往返', () => {
    const history = '这是一段会被送进上下文预算计算的中文历史文本。'.repeat(5_000)
    const started = Date.now()
    const tokens = estimateTokens(history)
    const elapsed = Date.now() - started
    expect(history.length).toBeGreaterThan(100_000)
    expect(tokens).toBeGreaterThan(history.length / 2)
    // 预算是纯计算：它多花的那点时间不能变成新的首 token 开销。
    expect(elapsed).toBeLessThan(NETWORK_MS / 4)
  })
})
