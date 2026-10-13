/**
 * Serialize the harness request vocabulary into one OpenAI `chat/completions`
 * request, including the degradation of harness-only message primitives.
 *
 * Degradation policy for OpenAI-compatible endpoints:
 * - `tool-addition` / `tool-removal` blocks: the protocol re-declares the
 *   complete active tool list on every request (`GenerateOptions.tools`), so
 *   history updates carry no wire meaning. They degrade to a one-line text
 *   note kept in the conversation for continuity.
 * - `image` / `file` blocks: RyAgent routes are text-only (the adapter declares
 *   `inputModalities: ['text']`, and `LlmRuntime` projects placeholders before
 *   dispatch). Any block that still arrives degrades to deterministic
 *   placeholder text rather than failing the request.
 * - `reasoning` blocks are not replayed: chat/completions has no reasoning
 *   slot, and injecting past reasoning into visible content would misrepresent
 *   it as an answer.
 * @module @ryagent/llm-openai/serialize
 */

import type { GenerateOptions, RequestMessage, ToolSchema } from '@ryagent/llm'
import { LlmError } from '@ryagent/llm'
import type { OpenAiChatRequest, OpenAiWireMessage, OpenAiWireTool } from './wire.ts'

/** Join the text-bearing blocks of one message into the wire string content. */
function blocksToText(content: RequestMessage['content']): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Map one harness message to the OpenAI wire format. */
function serializeMessage(message: RequestMessage): OpenAiWireMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: blocksToText(message.content) }
    case 'developer': {
      // Developer messages carry tool additions/removals; degrade each to a
      // text note (see module doc). Plain text passes through as 'system'.
      const notes: string[] = []
      for (const block of message.content) {
        if (block.type === 'tool-addition') notes.push(`[Tool "${block.toolName}" added]`)
        else if (block.type === 'tool-removal') notes.push(`[Tool "${block.toolName}" removed]`)
        else if (block.type === 'text') notes.push(block.text)
      }
      return { role: 'system', content: notes.join('\n') }
    }
    case 'user':
      return { role: 'user', content: serializeUserContent(message.content) }
    case 'assistant': {
      const toolCalls = message.content.flatMap((block) => {
        return block.type === 'tool-call'
          ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: block.arguments } }]
          : []
      })
      const text = blocksToText(message.content)
      return {
        role: 'assistant',
        // OpenAI allows tool_calls alongside string content; only an empty
        // text collapses to null. Dropping the text would silently lose what
        // the model said before calling tools.
        content: toolCalls.length > 0 && text.length === 0 ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      }
    }
    case 'tool': {
      const text = serializeUserContent(message.content)
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.isError === true ? `[Tool error]\n${text}` : text,
      }
    }
    default:
      throw new LlmError(`openai: unsupported message role ${(message as RequestMessage).role}`, 'INVALID_ARGS')
  }
}

/**
 * User/tool content can carry image or file blocks when the caller bypassed
 * the runtime projection; degrade them to deterministic placeholder text.
 */
function serializeUserContent(content: RequestMessage['content']): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') {
      parts.push(
        `[Image${block.attachment.name === undefined ? '' : ` "${block.attachment.name}"`}` +
          ` ${block.attachment.width}x${block.attachment.height}, ${block.attachment.bytes} bytes]`,
      )
    } else if (block.type === 'file') {
      parts.push(`[File "${block.attachment.name}", ${block.attachment.bytes} bytes]`)
    } else if (block.type === 'reasoning') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Map the harness tool schema list to the wire `tools` field. */
export function serializeTools(tools: readonly ToolSchema[] | undefined): OpenAiWireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/**
 * Assemble one complete `chat/completions` request from `GenerateOptions`.
 * @param options - the fully assembled harness request.
 * @returns the wire request body.
 */
export function serializeRequest(options: GenerateOptions): OpenAiChatRequest {
  const messages: OpenAiWireMessage[] = []
  // A one-shot caller may pass `system` alongside history whose leading
  // system message the loop owns; the explicit slot goes first.
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...options.messages.map(serializeMessage))
  const tools = serializeTools(options.tools)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools === undefined ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: [...options.stop] }),
  }
}
