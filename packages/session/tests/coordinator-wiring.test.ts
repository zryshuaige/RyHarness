/**
 * 协调器接线（对应复评"usage 管道""取消链路""教训相关性"三项）：
 *
 * - usage 从供应商 → 消息行 → 会话累计 → RunContext.onUsage 的完整链路；
 * - 取消信号透传到群聊调度（不转发时接力链会一路跑满 8 轮），以及单聊取消后
 *   半截回复仍然落库；
 * - 教训注入走真实调用路径：协调器绑定 → AgentLoop → EvolveService.compile，
 *   无关教训不得进入本轮 prompt。
 * @module @ryagent/session/tests/coordinator-wiring
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition, Tool } from '@ryagent/agent'
import { isAbortedError } from '@ryagent/agent'
import type { GenerateOptions, LlmRuntime, StreamChunk, TokenUsage, ToolCallId } from '@ryagent/llm'
import type { RunContext, UsageReport } from '@ryagent/session'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import { afterEach, describe, expect, it } from 'vitest'

const AGENT: AgentDefinition = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

const USAGE_A: TokenUsage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
const USAGE_B: TokenUsage = { inputTokens: 60, outputTokens: 40, totalTokens: 100, cacheReadTokens: 8 }

const dirs: string[] = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryagent-session-'))
  dirs.push(dir)
  return join(dir, 's.db')
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

/** 假 runtime：每次调用按脚本产 chunk。 */
function scriptedLlm(scripts: readonly (() => AsyncGenerator<StreamChunk>)[]): {
  llm: LlmRuntime
  calls: () => number
  requests: GenerateOptions[]
} {
  const requests: GenerateOptions[] = []
  let index = 0
  const llm = {
    stream(options: GenerateOptions) {
      requests.push({ ...options })
      const source = scripts[index++]?.() ?? (async function* (): AsyncGenerator<StreamChunk> {})()
      return { [Symbol.asyncIterator]: () => source }
    },
  } as unknown as LlmRuntime
  return { llm, calls: () => index, requests }
}

function textStream(text: string, usage?: TokenUsage): () => AsyncGenerator<StreamChunk> {
  return async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function drain<T>(source: AsyncGenerator<T>): Promise<{ events: T[]; error?: unknown }> {
  const events: T[] = []
  try {
    for await (const event of source) events.push(event)
    return { events }
  } catch (error) {
    return { events, error }
  }
}

describe('usage 管道', () => {
  it('单聊：usage 落到产出它的那条消息，会话累计与回调三方一致', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { llm } = scriptedLlm([textStream('答完了', USAGE_A)])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })
    const reports: UsageReport[] = []

    await drain(
      coordinator.chatDirect(conversation.id, 'a1', '你好', {
        workspaceRoot: process.cwd(),
        onUsage: (report) => {
          reports.push(report)
        },
      }),
    )

    const assistant = store.listMessages(conversation.id).find((row) => {
      return row.senderType === 'agent'
    })!
    expect(assistant.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    })
    expect(store.conversationUsage(conversation.id)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      messages: 1,
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ conversationId: conversation.id, turnIndex: 0, usage: assistant.usage })
    expect(reports[0]!.turnTotal.totalTokens).toBe(120)
    store.close()
  })

  it('单聊多步：每条 assistant 消息各挂自己那次的用量，本轮累计累加', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['echo'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const callId = 'call-1' as ToolCallId
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{}' } }
        yield { type: 'usage', usage: USAGE_A }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
      textStream('用完工具了', USAGE_B),
    ])
    const echo: Tool = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return { content: 'echo: x' }
      },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })
    const reports: UsageReport[] = []

    await drain(
      coordinator.chatDirect(conversation.id, 'a1', '跑一下', {
        workspaceRoot: process.cwd(),
        onUsage: (report) => {
          reports.push(report)
        },
      }),
    )

    const rows = store.listMessages(conversation.id)
    const toolCallRow = rows.find((row) => {
      return (row.contentBlocks as { type: string }[]).some((block) => {
        return block.type === 'tool-call'
      })
    })!
    const finalRow = rows[rows.length - 1]!
    expect(toolCallRow.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
    expect(finalRow.usage).toMatchObject({ inputTokens: 60, outputTokens: 40, cacheReadTokens: 8 })
    // 每条消息只挂自己那次的用量，累计等于各次之和。
    expect(store.conversationUsage(conversation.id)).toMatchObject({
      inputTokens: 160,
      outputTokens: 60,
      totalTokens: 220,
      messages: 2,
    })
    expect(reports.map((report) => report.turnTotal.totalTokens)).toEqual([120, 220])
    store.close()
  })

  it('群聊：成员发言各挂用量，会话累计与实际调用一致', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['ryen', 'codebot'],
      dispatcherAgentId: 'ryen',
    })
    // Ryen 接力给 CodeBot，两人各一次带 usage 的调用。
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '@CodeBot 你来' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '@CodeBot 你来' } }
        yield { type: 'usage', usage: USAGE_A }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      textStream('写好了', USAGE_B),
    ])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    await drain(coordinator.chatGroup(conversation.id, '开工', { workspaceRoot: process.cwd() }))

    const rows = store.listMessages(conversation.id)
    const ryen = rows.find((row) => {
      return row.senderId === 'ryen'
    })!
    const codebot = rows.find((row) => {
      return row.senderId === 'codebot'
    })!
    expect(ryen.usage).toMatchObject({ totalTokens: 120 })
    expect(codebot.usage).toMatchObject({ totalTokens: 100 })
    expect(store.conversationUsage(conversation.id)).toMatchObject({ inputTokens: 160, totalTokens: 220, messages: 2 })
    store.close()
  })
})

describe('取消链路', () => {
  it('单聊取消：半截回复以正常消息落库（刷新不丢），随后抛 AbortedError', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const controller = new AbortController()
    const { llm } = scriptedLlm([
      async function* () {
        yield { type: 'text-delta', index: 0, text: '写到一半' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '写到一半' } }
        controller.abort()
        throw new Error('socket hang up')
      },
    ])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    const { error } = await drain(
      coordinator.chatDirect(conversation.id, 'a1', '写长一点', {
        workspaceRoot: process.cwd(),
        signal: controller.signal,
      }),
    )

    expect(isAbortedError(error)).toBe(true)
    const rows = store.listMessages(conversation.id)
    const assistant = rows.find((row) => {
      return row.senderType === 'agent'
    })!
    expect((assistant.contentBlocks[0] as { text: string }).text).toBe('写到一半')
    // 取消不是失败：不落 system 错误消息，历史里也不会出现悬空 tool 调用。
    expect(rows.some((row) => row.senderType === 'system')).toBe(false)
    store.close()
  })

  it('群聊取消：signal 透传到调度器，接力链立即停（未转发时会跑满 8 轮）', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['ryen', 'codebot'],
      dispatcherAgentId: 'ryen',
    })
    const controller = new AbortController()
    // 每次调用都在接力：不转发 signal 时调度链会一直跑到 maxTurns=8。
    const { llm, calls } = scriptedLlm(
      Array.from({ length: 8 }, () => {
        return async function* () {
          yield { type: 'text-delta', index: 0, text: '@CodeBot 继续' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '@CodeBot 继续' } }
          controller.abort()
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }),
    )
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    await drain(
      coordinator.chatGroup(conversation.id, '开工', {
        workspaceRoot: process.cwd(),
        signal: controller.signal,
      }),
    )

    expect(calls()).toBe(1)
    expect(store.listDispatchEvents(conversation.id).map((event) => event.toAgent)).toEqual(['ryen'])
    store.close()
  })
})

describe('教训注入的真实路径', () => {
  it('AgentLoop 把本轮输入传给 EvolveService：相关教训进 prompt，无关的不进', async () => {
    const { EvolveService } = await import('@ryagent/evolve')
    const evolution = new EvolveService({ dbPath: dbPath(), logger: () => {} })
    try {
      const related = evolution.store.insertReflection({ agentId: 'a1', lesson: '写文件前先确认目录存在' })
      evolution.store.insertReflection({ agentId: 'a1', lesson: '英文回复要用敬语开头' })
      const store = new SessionStore(':memory:')
      store.upsertAgent(AGENT)
      const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
      const { llm, requests } = scriptedLlm([textStream('好的')])
      const coordinator = new SessionCoordinator({ store, llm, tools: [], evolution })

      await drain(coordinator.chatDirect(conversation.id, 'a1', '帮我写文件', { workspaceRoot: process.cwd() }))

      const system = requests[0]!.system ?? ''
      expect(system).toContain('写文件前先确认目录存在')
      expect(system).not.toContain('英文回复要用敬语开头')
      expect(evolution.store.getReflection(related.id)?.hitCount).toBe(0)
      store.close()
    } finally {
      evolution.close()
    }
  })

  it('同样的规则在群聊里同样生效（调度器创建的循环也走这条路）', async () => {
    const { EvolveService } = await import('@ryagent/evolve')
    const evolution = new EvolveService({ dbPath: dbPath(), logger: () => {} })
    try {
      evolution.store.insertReflection({ agentId: 'ryen', lesson: '写文件前先确认目录存在' })
      evolution.store.insertReflection({ agentId: 'ryen', lesson: '英文回复要用敬语开头' })
      const store = new SessionStore(':memory:')
      store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
      store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
      const conversation = store.createConversation({
        kind: 'group',
        memberAgentIds: ['ryen', 'codebot'],
        dispatcherAgentId: 'ryen',
      })
      const { llm, requests } = scriptedLlm([textStream('收到')])
      const coordinator = new SessionCoordinator({ store, llm, tools: [], evolution })

      await drain(coordinator.chatGroup(conversation.id, '@Ryen 帮我写文件', { workspaceRoot: process.cwd() }))

      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) {
        expect(request.system ?? '').not.toContain('英文回复要用敬语开头')
      }
      expect(requests[0]!.system ?? '').toContain('写文件前先确认目录存在')
      store.close()
    } finally {
      evolution.close()
    }
  })
})
