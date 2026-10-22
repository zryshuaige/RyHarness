import { brandString } from '@ryharness/brand'
import type { AssistantMessage, MessageId, ToolCallId } from '@ryharness/llm'
import { ReasoningEffortId as brandReasoningEffortId } from '@ryharness/llm'
import type { OpenAiWireMessage } from '@ryharness/llm-openai'
import { serializeRequest } from '@ryharness/llm-openai'
import { describe, expect, it } from 'vitest'

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    id: brandString<MessageId>('m1'),
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
}

function assistantWire(options: Parameters<typeof serializeRequest>[0]): OpenAiWireMessage {
  const request = serializeRequest(options)
  const wire = request.messages.find((message) => {
    return message.role === 'assistant'
  })
  if (wire === undefined) throw new Error('assistant message missing from wire request')
  return wire
}

describe('serializeRequest assistant messages', () => {
  it('keeps text content when tool_calls coexist (model spoke before calling)', () => {
    const wire = assistantWire({
      provider: 'p',
      model: 'm',
      messages: [
        assistant([
          { type: 'text', text: '我先查一下文件。' },
          { type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'fs_read', arguments: '{"path":"a.txt"}' },
        ]),
      ],
    })
    expect(wire.content).toBe('我先查一下文件。')
    expect(wire.tool_calls).toHaveLength(1)
  })

  it('collapses content to null only when there is no text at all', () => {
    const wire = assistantWire({
      provider: 'p',
      model: 'm',
      messages: [
        assistant([{ type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'fs_read', arguments: '{}' }]),
      ],
    })
    expect(wire.content).toBeNull()
    expect(wire.tool_calls).toHaveLength(1)
  })

  it('passes plain text through unchanged without tool_calls', () => {
    const wire = assistantWire({
      provider: 'p',
      model: 'm',
      messages: [assistant([{ type: 'text', text: '你好' }])],
    })
    expect(wire.content).toBe('你好')
    expect(wire.tool_calls).toBeUndefined()
  })
})

/**
 * 思考强度的序列化。
 *
 * 回归点是「模型有了但用户调不了」：内置目录里已经有 MiniMax-M3.1 这类支持
 * reasoning_effort 的模型，但请求体里从来不发这个字段，用户选了模型也没有任何
 * 办法调节思考深度——能力存在却没有出口。
 *
 * 更要紧的是**不能乱发**：chat/completions 上没有统一的思考参数，猜错字段名就是整轮
 * 400，而用户看到的只是一句「服务出错」，根本猜不到是哪句话触发的。
 */
describe('serializeRequest 思考强度', () => {
  const base = { provider: 'p', model: 'm', messages: [] as never[] }

  it('选了档位就发 reasoning_effort（各家的事实标准字段名）', () => {
    const request = serializeRequest({ ...base, reasoningEffort: brandReasoningEffortId('high') }, 'effort')
    expect(request.reasoning_effort).toBe('high')
  })

  it('没选档位就一个字段都不发：模型用自己的默认，永远不会 400', () => {
    const request = serializeRequest({ ...base }, 'effort')
    expect(request.reasoning_effort).toBeUndefined()
    expect(request.thinking).toBeUndefined()
  })

  it('关思考在认 thinking 的路由上发 disabled', () => {
    const request = serializeRequest({ ...base, reasoningEffort: brandReasoningEffortId('off') }, 'thinking-adaptive')
    expect(request.thinking).toEqual({ type: 'disabled' })
    // 关思考走 thinking 表达，不该再同时发一个档位值。
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('恒开思考的模型关不掉时不发任何字段，而不是发一个会被 400 的值', () => {
    // MiniMax-M3.1 收到 thinking.type=disabled 直接 400（官方错误码 2013），
    // reasoning_effort:"none" 同样被拒。宁可什么都不发、让模型照旧思考。
    const request = serializeRequest({ ...base, reasoningEffort: brandReasoningEffortId('off') }, 'effort')
    expect(request.thinking).toBeUndefined()
    expect(request.reasoning_effort).toBeUndefined()
  })

  it('路由声明为 none 时，即使调用方带了档位也不发', () => {
    const request = serializeRequest({ ...base, reasoningEffort: brandReasoningEffortId('low') }, 'none')
    expect(request.reasoning_effort).toBeUndefined()
    expect(request.thinking).toBeUndefined()
  })
})
