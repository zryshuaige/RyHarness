/**
 * 窗口配对不变量：切点不得产出**孤立的 tool 结果**。
 *
 * 背景（内核评审 P0）：一条 tool 结果消息的配对方是它前面那条带 tool_calls 的
 * assistant 消息。压缩（compactHistory）与丢弃式裁剪（trimHistoryToBudget）都
 * 按 token 预算从最旧往回切，切点一旦落在 tool 结果上，那条 assistant 就被切到
 * 窗口外——窗口首条成了一条断掉配对的 tool 结果，OpenAI 兼容供应商直接 400：
 * 用户的消息已经落库，回复却永远不来。
 *
 * 旧测试（compact.test.ts「切点不会留下孤立的 tool 结果」、loop-concurrency.test.ts
 * 「窗口首条不留下孤立的 tool 结果」）之所以恒绿，是因为它们的历史**以 user
 * 消息结尾**——切点的边界条件 `start < length - 1` 在那种形状下永远不生效。
 * 本文件覆盖的正是漏掉的那一类形状：历史**以 tool 结果结尾**。
 *
 * 断言用的是"请求合法性"这一条更硬的不变量，而不是"首条不是 tool"：
 * 每个 tool 结果的 tool_call 必须在窗口里、且在它之前；每条 assistant 声明的
 * tool_calls 也必须都有对应的结果。半截配对（assistant 在窗口外、或结果缺了
 * 一半）同样会被供应商拒掉。
 *
 * @module @ryharness/agent/tests/window-pairing
 */

import type { CompactSpec } from '@ryharness/agent'
import { alignWindowStart, compactHistory, trimHistoryToBudget } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { Message, ToolCallId } from '@ryharness/llm'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

/** 一条用户消息。 */
function userText(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** 一条带 tool_call 的 assistant 消息（一次调用声明）。 */
function assistantToolCall(callIds: readonly string[]): Message {
  return createAssistantMessage({
    content: callIds.map((id) => {
      return { type: 'tool-call' as const, id: brandString<ToolCallId>(id), name: 'shell_exec', arguments: '{}' }
    }),
    source: { provider: 'mock', model: 'mock-model' },
  })
}

/** 一条工具结果消息。 */
function toolResult(text: string, callId: string): Message {
  return createToolResultMessage({
    callId: brandString<ToolCallId>(callId),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

/** 压缩用的三段式预算。 */
const SPEC = (over: Partial<CompactSpec> = {}): CompactSpec => {
  return { thresholdTokens: 1_000, retainTokens: 200, toolResultPruneTokens: 100, summaryMaxTokens: 100, ...over }
}

/** 摘要替身：不关心内容，只说明"摘要这一步发生了"。 */
const summarize = async (messages: readonly Message[]): Promise<string> => {
  return `摘要：${messages.length} 条历史`
}

/**
 * 断言这串消息是一个**合法的请求序列**。
 *
 * 两条方向都要查：tool 结果能找到它声明的 tool_call（且声明在它之前），
 * tool_call 也找得到它的结果。只查一条方向会漏掉"assistant 声明了 N 个调用、
 * 只回了 N-1 个结果"这种半截配对。
 */
function expectLegalRequest(messages: readonly Message[]): void {
  const declared = new Set<string>()
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') declared.add(block.id)
      }
      continue
    }
    if (message.role !== 'tool') continue
    answered.add(message.toolCallId)
    // 断配对：这条结果的主人在窗口里找不到。
    expect(declared.has(message.toolCallId)).toBe(true)
  }
  for (const callId of declared) {
    // 半截配对：声明了调用却没给结果。
    expect(answered.has(callId)).toBe(true)
  }
}

describe('丢弃式裁剪（trimHistoryToBudget）', () => {
  it('历史以一条 tool 结果结尾：窗口首条不是孤立的 tool 结果', () => {
    const history = [userText('很旧'.repeat(600)), assistantToolCall(['c1']), toolResult('工具输出'.repeat(200), 'c1')]
    const trimmed = trimHistoryToBudget(history, 50)
    expect(trimmed[0]?.role).not.toBe('tool')
    expectLegalRequest(trimmed)
  })

  it('历史以三条 tool 结果结尾：整组都不留在窗口里，不会只丢一半', () => {
    const history = [
      userText('很旧'.repeat(600)),
      assistantToolCall(['c1', 'c2', 'c3']),
      toolResult('工具输出'.repeat(200), 'c1'),
      toolResult('工具输出'.repeat(200), 'c2'),
      toolResult('工具输出'.repeat(200), 'c3'),
    ]
    const trimmed = trimHistoryToBudget(history, 50)
    expect(trimmed[0]?.role).not.toBe('tool')
    expectLegalRequest(trimmed)
  })

  it('预算宽到装得下全部时保持原样（不误伤正常路径）', () => {
    const history = [userText('短'), assistantToolCall(['c1']), toolResult('结果', 'c1')]
    const trimmed = trimHistoryToBudget(history, 10_000)
    expect(trimmed).toHaveLength(3)
    expectLegalRequest(trimmed)
  })
})

describe('压缩链路（compactHistory）', () => {
  it('历史以一条 tool 结果结尾：摘要 + 窗口是合法请求', async () => {
    const history = [userText('很旧'.repeat(600)), assistantToolCall(['c1']), toolResult('工具输出'.repeat(200), 'c1')]
    const result = await compactHistory(history, SPEC(), summarize)
    expect(result.summarized).toBe(true)
    expectLegalRequest(result.messages)
  })

  it('历史以三条 tool 结果结尾：摘要 + 窗口是合法请求', async () => {
    const history = [
      userText('很旧'.repeat(600)),
      assistantToolCall(['c1', 'c2', 'c3']),
      toolResult('工具输出'.repeat(200), 'c1'),
      toolResult('工具输出'.repeat(200), 'c2'),
      toolResult('工具输出'.repeat(200), 'c3'),
    ]
    const result = await compactHistory(history, SPEC(), summarize)
    expect(result.summarized).toBe(true)
    expectLegalRequest(result.messages)
  })

  it('供应商 400 后的激进重试规格（retainTokens=0）：窗口塌缩也不留断配对', async () => {
    // 这条路径最危险：retainTokens=0 时窗口必然塌缩成最后一条，而最后一条
    // 恰好是 tool 结果——修复之前这里会直接造出 [user(摘要), tool(...)]。
    const history = [userText('很旧'.repeat(600)), assistantToolCall(['c1']), toolResult('工具输出'.repeat(200), 'c1')]
    const result = await compactHistory(history, SPEC({ retainTokens: 0 }), summarize)
    expect(result.summarized).toBe(true)
    expectLegalRequest(result.messages)
  })
})

describe('切点修正（alignWindowStart）', () => {
  it('切点落在 tool 结果上：推到整段 tool 结果之后', () => {
    const history = [userText('话'), assistantToolCall(['c1', 'c2']), toolResult('一', 'c1'), toolResult('二', 'c2')]
    expect(alignWindowStart(history, 2)).toBe(4)
  })

  it('切点落在 user 消息上：不动', () => {
    const history = [userText('话'), toolResult('一', 'c1')]
    expect(alignWindowStart(history, 0)).toBe(0)
  })

  it('切点在末尾：窗口为空（调用方随后补上当前这条 user 消息或摘要块）', () => {
    const history = [userText('话'), toolResult('一', 'c1')]
    expect(alignWindowStart(history, 2)).toBe(2)
  })

  it('越界的切点被夹到合法范围', () => {
    const history = [userText('话')]
    expect(alignWindowStart(history, -5)).toBe(0)
    expect(alignWindowStart(history, 99)).toBe(1)
  })
})
