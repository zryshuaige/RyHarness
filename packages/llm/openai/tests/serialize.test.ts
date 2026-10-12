import { describe, expect, it } from 'vitest'
import { brandString } from '@ryagent/brand'
import type { AssistantMessage, MessageId, ToolCallId } from '@ryagent/llm'
import { serializeRequest } from '@ryagent/llm-openai'
import type { OpenAiWireMessage } from '@ryagent/llm-openai'

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
  const wire = request.messages.find((message) => { return message.role === 'assistant' })
  if (wire === undefined) throw new Error('assistant message missing from wire request')
  return wire
}

describe('serializeRequest assistant messages', () => {
  it('keeps text content when tool_calls coexist (model spoke before calling)', () => {
    const wire = assistantWire({
      provider: 'p',
      model: 'm',
      messages: [assistant([
        { type: 'text', text: '我先查一下文件。' },
        { type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'fs_read', arguments: '{"path":"a.txt"}' },
      ])],
    })
    expect(wire.content).toBe('我先查一下文件。')
    expect(wire.tool_calls).toHaveLength(1)
  })

  it('collapses content to null only when there is no text at all', () => {
    const wire = assistantWire({
      provider: 'p',
      model: 'm',
      messages: [assistant([
        { type: 'tool-call', id: brandString<ToolCallId>('call-1'), name: 'fs_read', arguments: '{}' },
      ])],
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
