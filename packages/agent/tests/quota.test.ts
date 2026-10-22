import type { AgentDefinition, AgentLoopEvent, SessionQuota, Tool, ToolResult } from '@ryharness/agent'
import { AgentLoop, createSessionQuota, DEFAULT_SESSION_QUOTA_LIMITS } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 脚本化假 LLM：每步消耗一段录制 chunk。 */
function mockLlm(scripted: StreamChunk[][]): LlmRuntime {
  let call = 0
  return {
    stream(_options: GenerateOptions) {
      const chunks = scripted[call++] ?? []
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
}

/** 一整步都在调同一个工具。 */
function callStep(id: string, name: string, args: string): StreamChunk[] {
  return [
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: brandString<ToolCallId>(id), name, arguments: args },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const FINISH_STEP: StreamChunk[] = [
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 记账型假工具：数自己被真正执行了几次。 */
function countingTool(name: string): { tool: Tool; executions: () => number } {
  let executions = 0
  return {
    tool: {
      name,
      description: `测试用 ${name}`,
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolResult> {
        executions++
        return { content: `${name} ok` }
      },
    },
    executions: () => executions,
  }
}

function definition(tools: string[]): AgentDefinition {
  return {
    id: 'quota-agent',
    name: '配额测试',
    systemPrompt: '你是测试 agent。',
    provider: 'mock',
    model: 'mock',
    tools,
  }
}

async function collect(events: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
  const out: AgentLoopEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function toolResults(events: AgentLoopEvent[]): { isError: boolean; content: string }[] {
  return events
    .filter((event): event is Extract<AgentLoopEvent, { type: 'tool-result' }> => {
      return event.type === 'tool-result'
    })
    .map((event) => {
      return { isError: event.isError, content: event.result.content }
    })
}

describe('会话配额闸', () => {
  it('默认上限来自 DEFAULT_SESSION_QUOTA_LIMITS，可覆盖、可关闭', () => {
    const quota = createSessionQuota()
    expect(quota.limits).toEqual({
      maxShellCalls: DEFAULT_SESSION_QUOTA_LIMITS.maxShellCalls,
      maxWriteBytes: DEFAULT_SESSION_QUOTA_LIMITS.maxWriteBytes,
    })
    expect(createSessionQuota({ maxShellCalls: 3, maxWriteBytes: Infinity }).limits).toEqual({
      maxShellCalls: 3,
      maxWriteBytes: Infinity,
    })
  })

  it('shell 调用次数超限即报错且不执行，越限计入 rejected', async () => {
    const { tool, executions } = countingTool('shell_exec')
    const quota = createSessionQuota({ maxShellCalls: 2 })
    const llm = mockLlm([
      callStep('c1', 'shell_exec', '{}'),
      callStep('c2', 'shell_exec', '{}'),
      callStep('c3', 'shell_exec', '{}'),
      FINISH_STEP,
    ])
    const loop = new AgentLoop({ definition: definition(['shell_exec']), llm, tools: [tool], quota })
    const results = toolResults(await collect(loop.run({ text: '跑' }, { workspaceRoot: process.cwd() })))
    expect(
      results.map((r) => {
        return r.isError
      }),
    ).toEqual([false, false, true])
    expect(results[2]?.content).toContain('quota exceeded: shell_exec calls 2/2')
    expect(executions()).toBe(2)
    expect(quota.usage).toEqual({ shellCalls: 2, writeBytes: 0, rejected: 1 })
  })

  it('写类工具按 UTF-8 字节数计费（不是字符数）', async () => {
    const { tool, executions } = countingTool('fs_write')
    const quota = createSessionQuota({ maxWriteBytes: 60 })
    const content = '汉'.repeat(10) // 30 字节
    const llm = mockLlm([
      callStep('c1', 'fs_write', JSON.stringify({ content })),
      callStep('c2', 'fs_write', JSON.stringify({ content: 'x'.repeat(31) })),
      FINISH_STEP,
    ])
    const loop = new AgentLoop({ definition: definition(['fs_write']), llm, tools: [tool], quota })
    const results = toolResults(await collect(loop.run({ text: '写' }, { workspaceRoot: process.cwd() })))
    expect(
      results.map((r) => {
        return r.isError
      }),
    ).toEqual([false, true])
    expect(results[1]?.content).toContain('quota exceeded: write 61/60 bytes')
    expect(executions()).toBe(1)
    expect(quota.usage).toEqual({ shellCalls: 0, writeBytes: 30, rejected: 1 })
  })

  it('file_produce 与 fs_write 记在同一个写入预算里', async () => {
    const write = countingTool('fs_write')
    const produce = countingTool('file_produce')
    const quota = createSessionQuota({ maxWriteBytes: 10 })
    const llm = mockLlm([
      callStep('c1', 'fs_write', JSON.stringify({ content: 'x'.repeat(6) })),
      callStep('c2', 'file_produce', JSON.stringify({ content: 'y'.repeat(6) })),
      FINISH_STEP,
    ])
    const loop = new AgentLoop({
      definition: definition(['fs_write', 'file_produce']),
      llm,
      tools: [write.tool, produce.tool],
      quota,
    })
    const results = toolResults(await collect(loop.run({ text: '写' }, { workspaceRoot: process.cwd() })))
    expect(
      results.map((r) => {
        return r.isError
      }),
    ).toEqual([false, true])
    expect(produce.executions()).toBe(0)
    expect(quota.usage.writeBytes).toBe(6)
  })

  it('上限为 Infinity 时该项不拦', async () => {
    const { tool, executions } = countingTool('shell_exec')
    const quota = createSessionQuota({ maxShellCalls: Infinity })
    const llm = mockLlm(
      Array.from({ length: 5 }, (_, i) => {
        return callStep(`c${i}`, 'shell_exec', '{}')
      }).concat([FINISH_STEP]),
    )
    const loop = new AgentLoop({ definition: definition(['shell_exec']), llm, tools: [tool], quota, maxSteps: 8 })
    const results = toolResults(await collect(loop.run({ text: '跑' }, { workspaceRoot: process.cwd() })))
    expect(
      results.every((r) => {
        return r.isError === false
      }),
    ).toBe(true)
    expect(executions()).toBe(5)
    expect(quota.usage.rejected).toBe(0)
  })

  it('同一个闸跨轮跨 AgentLoop 共享：额度是每会话而不是每轮', async () => {
    const { tool, executions } = countingTool('shell_exec')
    const quota: SessionQuota = createSessionQuota({ maxShellCalls: 2 })
    const run = async (): Promise<{ isError: boolean; content: string }[]> => {
      const llm = mockLlm([callStep('c1', 'shell_exec', '{}'), FINISH_STEP])
      const loop = new AgentLoop({ definition: definition(['shell_exec']), llm, tools: [tool], quota })
      return toolResults(await collect(loop.run({ text: '跑' }, { workspaceRoot: process.cwd() })))
    }
    expect((await run())[0]?.isError).toBe(false)
    expect((await run())[0]?.isError).toBe(false)
    // 第三个循环是新会话的第一次调用，但额度已被前两轮用完。
    expect((await run())[0]).toMatchObject({ isError: true, content: expect.stringContaining('quota exceeded') })
    expect(executions()).toBe(2)
    expect(quota.usage.shellCalls).toBe(2)
  })

  it('不计费工具与未知工具照常走（配额只管 shell 与写）', async () => {
    const { tool } = countingTool('fs_read')
    const quota = createSessionQuota({ maxShellCalls: 0 })
    const llm = mockLlm([callStep('c1', 'fs_read', '{}'), callStep('c2', 'nope', '{}'), FINISH_STEP])
    const loop = new AgentLoop({ definition: definition(['fs_read', 'nope']), llm, tools: [tool], quota })
    const results = toolResults(await collect(loop.run({ text: '读' }, { workspaceRoot: process.cwd() })))
    expect(
      results.map((r) => {
        return r.isError
      }),
    ).toEqual([false, true])
    expect(results[1]?.content).toContain('unknown tool')
    expect(quota.usage.rejected).toBe(0)
  })

  it('不传 quota 时循环自建一个（本次运行内生效）', async () => {
    const { tool, executions } = countingTool('shell_exec')
    const llm = mockLlm(
      Array.from({ length: 3 }, (_, i) => {
        return callStep(`c${i}`, 'shell_exec', '{}')
      }).concat([FINISH_STEP]),
    )
    const loop = new AgentLoop({ definition: definition(['shell_exec']), llm, tools: [tool] })
    const results = toolResults(await collect(loop.run({ text: '跑' }, { workspaceRoot: process.cwd() })))
    expect(executions()).toBe(3)
    expect(
      results.every((r) => {
        return r.isError === false
      }),
    ).toBe(true)
  })
})
