/**
 * 取消与用量的内核行为（对应复评"取消链路""usage 管道"两项）：
 *
 * - 取消发生在流中途：已经推给前端的半截回复必须固化成一条正常的 assistant
 *   消息并以 done 收尾，随后才抛 AbortedError。否则用户按"停止"之后刷新，
 *   已经付过 token 的内容凭空消失。
 * - 未执行的 tool_call 绝不随中断落库：重建历史时会出现没有配对 tool 结果的
 *   悬空调用，供应商会直接拒绝下一轮请求。
 * - usage chunk 不能被丢弃：每次模型调用的用量随产出它的消息一起交出去。
 * @module @ryagent/agent/tests/loop-cancel-usage
 */

import type { AgentDefinition, AgentLoopEvent, Tool } from '@ryagent/agent'
import { ABORTED_CODE, AgentLoop, isAbortedError } from '@ryagent/agent'
import type { AssistantMessage, GenerateOptions, LlmRuntime, StreamChunk, TokenUsage, ToolCallId } from '@ryagent/llm'
import { describe, expect, it } from 'vitest'

const DEFINITION: AgentDefinition = {
  id: 'a1',
  name: 'Tester',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['echo'],
}

const USAGE: TokenUsage = { inputTokens: 12, outputTokens: 7, totalTokens: 19 }

/** 记录执行次数的 echo 工具。 */
function recordingTool(executed: string[]): Tool {
  return {
    name: 'echo',
    description: '回显',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      executed.push('echo')
      return { content: 'echo: x' }
    },
  }
}

/** 按脚本产出 chunk 的假 runtime；每个脚本是一次完整的流。 */
function scriptedLlm(scripts: readonly (() => AsyncGenerator<StreamChunk>)[]): {
  llm: LlmRuntime
  calls: () => number
} {
  let index = 0
  const llm = {
    stream(_options: GenerateOptions) {
      const source = scripts[index++]?.() ?? (async function* (): AsyncGenerator<StreamChunk> {})()
      return { [Symbol.asyncIterator]: () => source }
    },
  } as unknown as LlmRuntime
  return { llm, calls: () => index }
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<{ events: AgentLoopEvent[]; error?: unknown }> {
  const out: AgentLoopEvent[] = []
  try {
    for await (const event of events) out.push(event)
    return { events: out }
  } catch (error) {
    return { events: out, error }
  }
}

describe('AgentLoop 中断收尾', () => {
  it('流中途取消：半截回复固化为消息并以 done 收尾，随后抛 AbortedError', async () => {
    const controller = new AbortController()
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '这是半截回复' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '这是半截回复' } }
        yield { type: 'usage', usage: USAGE }
        controller.abort()
        throw new Error('socket hang up')
      },
    ])
    const persisted: { message: AssistantMessage; usage?: TokenUsage }[] = []
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [],
      onAssistantMessage: (message, usage) => {
        persisted.push({ message, ...(usage === undefined ? {} : { usage }) })
      },
    })

    const { events, error } = await collect(
      loop.run({ text: '讲个长故事' }, { workspaceRoot: process.cwd() }, { signal: controller.signal }),
    )

    // 内容先落库（刷新后仍在），用量跟着一起走。
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.message.content).toEqual([{ type: 'text', text: '这是半截回复' }])
    expect(persisted[0]!.usage).toEqual(USAGE)
    // done 让渲染层把这泡消息收尾（移除"正在输入"），随后才是取消语义。
    expect(events.some((event) => event.type === 'done')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(isAbortedError(error)).toBe(true)
    expect((error as { code: string }).code).toBe(ABORTED_CODE)
  })

  it('取消后未执行的 tool_call 不落库（历史不能出现悬空 tool 调用），工具也不执行', async () => {
    const controller = new AbortController()
    const callId = 'call-cancel' as ToolCallId
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '先看看文件' }
        yield {
          type: 'block-end',
          index: 1,
          block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{}' },
        }
        controller.abort()
      },
    ])
    const persisted: AssistantMessage[] = []
    const executed: string[] = []
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [recordingTool(executed)],
      onAssistantMessage: (message) => {
        persisted.push(message)
      },
    })

    const { events, error } = await collect(
      loop.run({ text: '跑一下' }, { workspaceRoot: process.cwd() }, { signal: controller.signal }),
    )

    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.content).toEqual([{ type: 'text', text: '先看看文件' }])
    expect(executed).toEqual([])
    expect(events.some((event) => event.type === 'tool-result')).toBe(false)
    expect(isAbortedError(error)).toBe(true)
  })

  it('正常收尾时 usage 随消息交给调用方（usage chunk 不被丢弃）', async () => {
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '答完了' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '答完了' } }
        yield { type: 'usage', usage: USAGE }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    ])
    const persisted: { message: AssistantMessage; usage?: TokenUsage }[] = []
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [],
      onAssistantMessage: (message, usage) => {
        persisted.push({ message, ...(usage === undefined ? {} : { usage }) })
      },
    })

    const { events, error } = await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))

    expect(error).toBeUndefined()
    expect(events.at(-1)?.type).toBe('done')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.usage).toEqual(USAGE)
  })

  it('供应商未回报 usage 时不伪造用量（消息仍然照常落库）', async () => {
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '没有 usage 的回答' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '没有 usage 的回答' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    ])
    const persisted: { message: AssistantMessage; usage?: TokenUsage }[] = []
    const loop = new AgentLoop({
      definition: DEFINITION,
      llm,
      tools: [],
      onAssistantMessage: (message, usage) => {
        persisted.push({ message, ...(usage === undefined ? {} : { usage }) })
      },
    })

    await collect(loop.run({ text: 'hi' }, { workspaceRoot: process.cwd() }))

    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.usage).toBeUndefined()
  })
})
