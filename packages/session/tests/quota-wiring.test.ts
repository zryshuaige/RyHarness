/**
 * 每会话配额的接线（对应"额度实际按轮计"这一条欠账）：
 *
 * AgentLoop 每轮新建、闸也每轮自建，额度实际按轮计。这里验证协调器按
 * conversationId 缓存同一个闸并传进去之后的行为：同一会话跨轮累计、群聊成员
 * 共用一份、并发会话互不干扰、会话删除后额度归还、缓存有上界且不留残留。
 * @module @ryagent/session/tests/quota-wiring
 */

import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryagent/agent'
import { DEFAULT_SESSION_QUOTA_LIMITS } from '@ryagent/agent'
import { brandString } from '@ryagent/brand'
import type { GroupEvent } from '@ryagent/group'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryagent/llm'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import { describe, expect, it } from 'vitest'

const AGENT: AgentDefinition = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: ['shell_exec'],
}

/**
 * 假 LLM：每个成员第一步要跑工具，第二步用 `reply` 收尾。
 *
 * 按"历史里有没有 tool 结果"决定发哪一步，而不是按调用计数——两个会话并发时
 * 计数会交错，按计数分发会让某一轮拿到别人的步骤。
 */
function toolThenStopLlm(reply = '好'): { llm: LlmRuntime; calls: () => number } {
  let calls = 0
  const llm = {
    stream(options: GenerateOptions) {
      calls++
      const callId = brandString<ToolCallId>(`call-${calls}`)
      const chunks: StreamChunk[] =
        options.messages.at(-1)?.role === 'tool'
          ? [
              { type: 'text-delta', index: 0, text: reply },
              { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          : [
              {
                type: 'block-end',
                index: 0,
                block: { type: 'tool-call', id: callId, name: 'shell_exec', arguments: '{}' },
              },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return { llm, calls: () => calls }
}

/** 计数型假 shell_exec：数自己被真正执行了几次。 */
function countingShell(delayMs = 0): { tool: Tool; executions: () => number } {
  let executions = 0
  return {
    tool: {
      name: 'shell_exec',
      description: '测试用 shell_exec',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      async execute(): Promise<ToolResult> {
        executions++
        if (delayMs > 0) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs)
          })
        }
        return { content: 'ok' }
      },
    },
    executions: () => executions,
  }
}

function directStore(): { store: SessionStore; conversation: (agentId?: string) => string } {
  const store = new SessionStore(':memory:')
  store.upsertAgent(AGENT)
  return {
    store,
    conversation: (agentId = 'a1') => {
      return store.createConversation({ kind: 'direct', memberAgentIds: [agentId] }).id
    },
  }
}

async function drain<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of source) events.push(event)
  return events
}

function toolResults(events: readonly AgentLoopEvent[]): { isError: boolean; content: string }[] {
  return events
    .filter((event): event is Extract<AgentLoopEvent, { type: 'tool-result' }> => {
      return event.type === 'tool-result'
    })
    .map((event) => {
      return { isError: event.isError, content: event.result.content }
    })
}

function groupToolResults(events: readonly GroupEvent[]): { agentId: string; isError: boolean; content: string }[] {
  return events
    .filter((event): event is Extract<GroupEvent, { type: 'tool-result' }> => {
      return event.type === 'tool-result'
    })
    .map((event) => {
      return { agentId: event.agentId, isError: event.isError, content: event.result.content }
    })
}

const CONTEXT = { workspaceRoot: process.cwd() }

describe('每会话配额接线', () => {
  it('同一会话跨轮累计：额度是每会话而不是每轮', async () => {
    const { store, conversation } = directStore()
    const conversationId = conversation()
    const { tool, executions } = countingShell()
    const { llm } = toolThenStopLlm()
    const coordinator = new SessionCoordinator({
      store,
      llm,
      tools: [tool],
      quotaLimits: { maxShellCalls: 2 },
    })

    await drain(coordinator.chatDirect(conversationId, 'a1', '第一轮', CONTEXT))
    const second = await drain(coordinator.chatDirect(conversationId, 'a1', '第二轮', CONTEXT))
    const third = await drain(coordinator.chatDirect(conversationId, 'a1', '第三轮', CONTEXT))

    // 前两轮各跑一次工具，第三轮才被额度拦下（若按轮计，第三轮会是满的）。
    expect(toolResults(second).map((r) => r.isError)).toEqual([false])
    expect(toolResults(third).map((r) => r.isError)).toEqual([true])
    expect(toolResults(third)[0]?.content).toContain('quota exceeded: shell_exec calls 2/2')
    expect(executions()).toBe(2)
    expect(coordinator.quotaOf(conversationId)?.usage).toEqual({ shellCalls: 2, writeBytes: 0, rejected: 1 })
    // 拒绝原因同样落库：模型下一轮看得见自己被拦了。
    const texts = store.listMessages(conversationId).flatMap((row) => {
      return (row.contentBlocks as { text?: string }[]).map((block) => {
        return block.text ?? ''
      })
    })
    expect(texts.some((text) => text.includes('quota exceeded'))).toBe(true)
    store.close()
  })

  it('缺省上限取自 DEFAULT_SESSION_QUOTA_LIMITS', async () => {
    const { store, conversation } = directStore()
    const conversationId = conversation()
    const { tool } = countingShell()
    const { llm } = toolThenStopLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [tool] })

    await drain(coordinator.chatDirect(conversationId, 'a1', '跑一下', CONTEXT))

    expect(coordinator.quotaOf(conversationId)?.limits).toEqual(DEFAULT_SESSION_QUOTA_LIMITS)
    store.close()
  })

  it('群聊成员共用同一份额度：接力到的第二个成员撞上第一个成员用掉的额度', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['a1', 'codebot'],
      dispatcherAgentId: 'a1',
    })
    const { tool, executions } = countingShell()
    // Ryen 跑完工具后 @CodeBot 接手，CodeBot 的工具调用就该撞额度了。
    const { llm } = toolThenStopLlm('@CodeBot 接手')
    const coordinator = new SessionCoordinator({ store, llm, tools: [tool], quotaLimits: { maxShellCalls: 1 } })

    const events = await drain(coordinator.chatGroup(conversation.id, '开工', CONTEXT))

    const results = groupToolResults(events)
    expect(
      results.map((r) => {
        return [r.agentId, r.isError]
      }),
    ).toEqual([
      ['a1', false],
      ['codebot', true],
    ])
    expect(results[1]?.content).toContain('quota exceeded')
    expect(executions()).toBe(1)
    expect(coordinator.quotaOf(conversation.id)?.usage).toEqual({ shellCalls: 1, writeBytes: 0, rejected: 1 })
    store.close()
  })

  it('并发会话互不影响：各自拿到独立的一份满额度', async () => {
    const { store, conversation } = directStore()
    const first = conversation()
    const second = conversation()
    const { tool, executions } = countingShell(5)
    const { llm } = toolThenStopLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [tool], quotaLimits: { maxShellCalls: 1 } })

    const [a, b] = await Promise.all([
      drain(coordinator.chatDirect(first, 'a1', '并发一', CONTEXT)),
      drain(coordinator.chatDirect(second, 'a1', '并发二', CONTEXT)),
    ])

    expect(toolResults(a).map((r) => r.isError)).toEqual([false])
    expect(toolResults(b).map((r) => r.isError)).toEqual([false])
    expect(executions()).toBe(2)
    expect(coordinator.quotaOf(first)?.usage).toEqual({ shellCalls: 1, writeBytes: 0, rejected: 0 })
    expect(coordinator.quotaOf(second)?.usage).toEqual({ shellCalls: 1, writeBytes: 0, rejected: 0 })
    store.close()
  })

  it('会话删除后归还额度：宿主调 releaseConversation 即释放，且幂等', async () => {
    const { store, conversation } = directStore()
    const conversationId = conversation()
    const { tool, executions } = countingShell()
    const { llm } = toolThenStopLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [tool], quotaLimits: { maxShellCalls: 1 } })

    await drain(coordinator.chatDirect(conversationId, 'a1', '第一轮', CONTEXT))
    const second = await drain(coordinator.chatDirect(conversationId, 'a1', '第二轮', CONTEXT))
    expect(toolResults(second).map((r) => r.isError)).toEqual([true])
    expect(executions()).toBe(1)

    store.deleteConversation(conversationId)
    expect(coordinator.releaseConversation(conversationId)).toBe(true)
    expect(coordinator.quotaOf(conversationId)).toBeUndefined()
    // 重复释放（路由重试、UI 连点两次删除）不报错。
    expect(coordinator.releaseConversation(conversationId)).toBe(false)
    store.close()
  })

  it('宿主没调 release 也不泄漏：缓存满时先扫掉已删除会话，再按 LRU 淘汰', async () => {
    const { store, conversation } = directStore()
    const first = conversation()
    const { tool } = countingShell()
    const { llm } = toolThenStopLlm()
    const coordinator = new SessionCoordinator({
      store,
      llm,
      tools: [tool],
      quotaLimits: { maxShellCalls: 1 },
      quotaCacheSize: 1,
    })

    await drain(coordinator.chatDirect(first, 'a1', '第一轮', CONTEXT))
    expect(coordinator.quotaOf(first)?.usage.shellCalls).toBe(1)

    // 直接删库、不通知协调器：下一轮把缓存挤满时，残留条目应当被扫掉。
    store.deleteConversation(first)
    const second = conversation()
    await drain(coordinator.chatDirect(second, 'a1', '第二轮', CONTEXT))
    expect(coordinator.quotaOf(first)).toBeUndefined()
    expect(coordinator.quotaOf(second)).toBeDefined()

    // 容量之外的活跃会话按 LRU 丢：被淘汰的会话下一轮重新拿到满额度。
    const third = conversation()
    await drain(coordinator.chatDirect(third, 'a1', '第三轮', CONTEXT))
    expect(coordinator.quotaOf(second)).toBeUndefined()
    expect(coordinator.quotaOf(third)?.usage.shellCalls).toBe(1)
    await drain(coordinator.chatDirect(second, 'a1', '再来一轮', CONTEXT))
    expect(coordinator.quotaOf(second)?.usage.shellCalls).toBe(1)
    store.close()
  })
})
