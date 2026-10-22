/**
 * 启动/加载期 tool_call 配对修复（崩溃恢复）的纯函数与读路径测试。
 *
 * 场景：agent 在「assistant 消息（含 tool_call 块）已落库、工具结果未落库」之间
 * 崩溃，下次加载历史时模型上下文出现断配对，供应商直接 400。修复语义对齐 dsh
 * 的 repair.ts：孤立 tool_call 合成占位工具结果（说明执行被中断），孤儿工具结果
 * 丢弃，正常历史字节级原样通过。
 */

import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryharness/llm'
import { LlmRuntime as LlmRuntimeClass } from '@ryharness/llm'
import { repairToolCallPairing, SessionCoordinator, SessionStore, type StoredMessage } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/** 造一行历史消息：只填测试关心的字段，其余给合法默认值。 */
function row(partial: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    seq: 1,
    conversationId: 'c1',
    senderType: 'user',
    contentBlocks: [{ type: 'text', text: '你好' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1_000,
    ...partial,
  }
}

/** 一行带 tool_call 块的 assistant 消息（崩溃残留的半条发言）。 */
function assistantToolCall(seq: number, calls: { id: string; name: string }[]): StoredMessage {
  return row({
    id: `assistant-${seq}`,
    seq,
    senderType: 'agent',
    senderId: 'a1',
    contentBlocks: calls.map((call) => {
      return { type: 'tool-call', id: call.id, name: call.name, arguments: '{}' }
    }),
  })
}

/** 一行工具结果消息。 */
function toolResult(seq: number, callId: string, text = '结果'): StoredMessage {
  return row({
    id: `result-${seq}`,
    seq,
    senderType: 'agent',
    senderId: 'a1',
    contentBlocks: [{ type: 'text', text: `〔tool〕x: ${text}` }],
    toolCallId: callId,
  })
}

/** 取下标元素；越界直接让测试失败（不用非空断言）。 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`expected an item at index ${index}`)
  return item
}

describe('repairToolCallPairing 纯函数', () => {
  it('孤立 tool_call 被修复：合成占位工具结果，紧随其 assistant 消息', () => {
    const history = [row({ id: 'u1', seq: 1 }), assistantToolCall(2, [{ id: 'call-1', name: 'flaky' }])]
    const repaired = repairToolCallPairing(history)

    expect(repaired).toHaveLength(3)
    expect(repaired[0]).toBe(history[0])
    expect(repaired[1]).toBe(history[1])
    const synthesized = at(repaired, 2)
    expect(synthesized.toolCallId).toBe('call-1')
    expect(synthesized.senderType).toBe('agent')
    expect(synthesized.turnIndex).toBe(at(history, 1).turnIndex)
    // 正文说明执行被中断（模型据此决定重试策略）。
    const text = (synthesized.contentBlocks[0] as { text?: string }).text ?? ''
    expect(text).toContain('flaky')
    expect(text).toContain('中断')
    // 确定性：同一份断配对历史每次加载合成出同一行。
    expect(repairToolCallPairing(history)).toEqual(repaired)
  })

  it('正常配对的历史原样通过（同一批行对象，不新建不改动）', () => {
    const history = [
      row({ id: 'u1', seq: 1 }),
      assistantToolCall(2, [{ id: 'call-1', name: 'flaky' }]),
      toolResult(3, 'call-1'),
      row({ id: 'u2', seq: 4 }),
    ]
    const repaired = repairToolCallPairing(history)
    expect(repaired).toHaveLength(history.length)
    repaired.forEach((line, index) => {
      expect(line).toBe(history[index])
    })
  })

  it('一条 assistant 消息里的多个孤立调用各补一条结果，顺序与块一致', () => {
    const history = [
      assistantToolCall(1, [
        { id: 'call-a', name: 'read' },
        { id: 'call-b', name: 'write' },
        { id: 'call-c', name: 'grep' },
      ]),
    ]
    const repaired = repairToolCallPairing(history)
    expect(
      repaired.map((line) => {
        return line.toolCallId
      }),
    ).toEqual([undefined, 'call-a', 'call-b', 'call-c'])
    expect(repaired[0]).toBe(history[0])
  })

  it('部分配对：只补缺失的调用，已有结果保留原位', () => {
    const history = [
      assistantToolCall(1, [
        { id: 'call-a', name: 'read' },
        { id: 'call-b', name: 'write' },
      ]),
      toolResult(2, 'call-a', '读到了'),
    ]
    const repaired = repairToolCallPairing(history)
    expect(repaired).toHaveLength(3)
    expect(repaired[1]).toBe(history[1])
    expect(at(repaired, 2).toolCallId).toBe('call-b')
    expect((at(repaired, 2).contentBlocks[0] as { text?: string }).text).toContain('中断')
  })

  it('孤儿工具结果被丢弃（toolCallId 对不上任何未应答的 tool_call）', () => {
    const history = [row({ id: 'u1', seq: 1 }), toolResult(2, 'ghost-call')]
    const repaired = repairToolCallPairing(history)
    expect(
      repaired.map((line) => {
        return line.id
      }),
    ).toEqual(['u1'])
  })

  it('重复结果只留第一条，第二条按孤儿丢弃', () => {
    const history = [
      assistantToolCall(1, [{ id: 'call-1', name: 'flaky' }]),
      toolResult(2, 'call-1', '第一次'),
      toolResult(3, 'call-1', '第二次'),
    ]
    const repaired = repairToolCallPairing(history)
    expect(
      repaired.map((line) => {
        return line.id
      }),
    ).toEqual(['assistant-1', 'result-2'])
  })

  it('孤立 call 之后已有新用户消息：合成结果插在 assistant 与用户消息之间', () => {
    const history = [
      assistantToolCall(1, [{ id: 'call-1', name: 'flaky' }]),
      row({ id: 'u2', seq: 2, contentBlocks: [{ type: 'text', text: '继续' }] }),
    ]
    const repaired = repairToolCallPairing(history)
    expect(
      repaired.map((line) => {
        return line.id
      }),
    ).toEqual(['assistant-1', 'repair-tool-result-call-1', 'u2'])
  })

  it('结果先于 call 出现（顺序颠倒）：结果按孤儿丢弃，call 补合成结果', () => {
    const history = [toolResult(1, 'call-1'), assistantToolCall(2, [{ id: 'call-1', name: 'flaky' }])]
    const repaired = repairToolCallPairing(history)
    expect(
      repaired.map((line) => {
        return line.id
      }),
    ).toEqual(['assistant-2', 'repair-tool-result-call-1'])
  })

  it('空历史与无工具调用的历史原样通过', () => {
    expect(repairToolCallPairing([])).toEqual([])
    const plain = [row({ id: 'u1', seq: 1 }), row({ id: 'u2', seq: 2 })]
    const repaired = repairToolCallPairing(plain)
    expect(
      repaired.map((line) => {
        return line.id
      }),
    ).toEqual(['u1', 'u2'])
    expect(repaired[0]).toBe(plain[0])
  })
})

/**
 * 读路径集成：直接往库里塞一条「assistant 消息带 tool_call 块、无工具结果」的
 * 崩溃残留行，再跑一轮对话，断言发给模型的历史里断配对已被修复。
 */
describe('loadDirectHistory 读路径的配对修复', () => {
  const AGENT = {
    id: 'a1',
    name: 'Ryen',
    systemPrompt: '你是测试 agent。',
    provider: 'mock',
    model: 'mock-model',
    tools: [],
  }

  /** 只实现 stream 的 LlmRuntime 替身（实例属性遮蔽原型方法，无双重断言）。 */
  function stopLlm(): { llm: LlmRuntime; requests: GenerateOptions[] } {
    const requests: GenerateOptions[] = []
    const llm: LlmRuntime = Object.create(LlmRuntimeClass.prototype) as LlmRuntime
    llm.stream = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      requests.push({ ...options, messages: [...options.messages] })
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    return { llm, requests }
  }

  it('崩溃残留的孤立 tool_call 在进入模型请求前被补上占位工具结果', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    // 模拟崩溃现场：assistant 消息（tool_call 块）已落库，工具结果没来得及落库。
    store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'tool-call', id: 'call-1', name: 'flaky', arguments: '{}' }],
      turnIndex: 0,
    })

    const { llm, requests } = stopLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const messages = requests[0]?.messages ?? []
    const callIndex = messages.findIndex((message) => {
      return message.content.some((block) => {
        return block.type === 'tool-call'
      })
    })
    expect(callIndex).toBeGreaterThanOrEqual(0)
    const following = messages[callIndex + 1]
    if (following?.role !== 'tool') throw new Error('assistant tool_calls 之后应紧跟修复出的 tool 消息')
    expect(String(following.toolCallId)).toBe('call-1')
    const text = following.content
      .filter((block) => {
        return block.type === 'text'
      })
      .map((block) => {
        return block.type === 'text' ? block.text : ''
      })
      .join('\n')
    expect(text).toContain('中断')
    // 正常配对：用户消息之前没有别的断档。
    expect(messages[callIndex + 2]?.role).toBe('user')
    store.close()
  })

  it('正常配对的历史进模型请求时原样（引用级重建，无合成行）', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'tool-call', id: 'call-1', name: 'flaky', arguments: '{}' }],
      turnIndex: 0,
    })
    store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'text', text: '〔tool〕flaky: 读到了' }],
      toolCallId: 'call-1',
      turnIndex: 0,
    })

    const { llm, requests } = stopLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const messages = requests[0]?.messages ?? []
    const toolMessages = messages.filter((message) => {
      return message.role === 'tool'
    })
    expect(toolMessages).toHaveLength(1)
    expect(
      toolMessages[0]?.content.some((block) => {
        return block.type === 'text' && block.text.includes('读到了')
      }),
    ).toBe(true)
    store.close()
  })
})
