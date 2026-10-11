/**
 * Translate OpenAI `chat/completions` streaming chunks into the harness
 * {@link StreamChunk} protocol: block lifecycle, interleaved tool-call
 * assembly, usage accounting, and finish-reason mapping.
 *
 * Block model: the first text delta opens one `text` block; content deltas
 * arriving after a tool-call block open a fresh text block. Each OpenAI
 * parallel tool-call index opens one `tool-call` block in first-seen order.
 * Every opened block is closed with a `block-end` carrying the assembled
 * block before the terminal `finish`; `usage` (when the endpoint sends it)
 * precedes `finish`.
 * @module @ryagent/llm-openai/translate
 */

import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@ryagent/llm'
import { EMPTY_RESPONSE_CODE, LlmError } from '@ryagent/llm'
import type { OpenAiStreamChunk, OpenAiWireUsage } from './wire.ts'

/** One output block under assembly, keyed by its {@link StreamChunk} block index. */
type BlockState =
  | { readonly kind: 'text'; text: string }
  | { readonly kind: 'tool-call'; id: ToolCallId; name: string; nameSent: boolean; arguments: string }

/** Map one wire usage object to the disjoint harness token accounting. */
export function mapUsage(usage: OpenAiWireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cache_read_tokens ?? 0
  const cacheWrite = usage.prompt_tokens_details?.cache_creation_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0
  // Harness counts are disjoint: billed input = input + cacheRead + cacheWrite,
  // so a provider that folds cache tokens into prompt_tokens is subtracted out.
  return {
    inputTokens: usage.prompt_tokens - cacheRead - cacheWrite,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

/** Map one OpenAI `finish_reason` to the harness finish vocabulary. */
export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
    case undefined:
    case null:
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'error', failure: { message: 'openai: response blocked by content filter', code: 'CONTENT_FILTER' } }
    default:
      return { kind: 'error', failure: { message: `openai: unexpected finish_reason "${reason}"`, code: 'PROTOCOL' } }
  }
}

/**
 * Translate parsed stream events into the harness chunk vocabulary.
 * @param events - parsed SSE payloads (JSON strings), `[DONE]` already removed.
 * @param model - model id used only for diagnostics.
 * @returns the chunk stream, terminated by exactly one `finish` chunk.
 */
export async function* translateChunks(
  events: AsyncIterable<string>,
  model: string,
): AsyncGenerator<StreamChunk> {
  const blocks: BlockState[] = []
  /** OpenAI parallel tool-call index -> output block index. */
  const toolBlockByInputIndex = new Map<number, number>()
  /** Whether the terminal `finish` chunk has been emitted. */
  let finished = false
  /** Usage from the terminal chunk; emitted after block-end, before finish. */
  let pendingUsage: TokenUsage | undefined

  /** Emit `block-end` for every block, in block order. */
  const closeAllBlocks = (): StreamChunk[] => {
    return blocks.map((block, index): StreamChunk => {
      if (block.kind === 'text') return { type: 'block-end', index, block: { type: 'text', text: block.text } }
      return {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments },
      }
    })
  }

  for await (const payload of events) {
    let chunk: OpenAiStreamChunk
    try {
      chunk = JSON.parse(payload) as OpenAiStreamChunk
    } catch (cause) {
      throw new LlmError('openai: malformed stream chunk', 'PROTOCOL', { cause })
    }
    if (typeof chunk !== 'object' || chunk === null || !Array.isArray(chunk.choices)) {
      throw new LlmError('openai: malformed stream chunk', 'PROTOCOL', { cause: new TypeError('chunk is not a chat.completion.chunk') })
    }

    // Usage rides the terminal chunk with empty choices; defer it so it is
    // emitted after the assembled blocks and before the finish chunk.
    if (chunk.usage !== undefined) {
      pendingUsage = mapUsage(chunk.usage)
    }

    for (const choice of chunk.choices) {
      // Requests never set `n`, so only choice 0 exists; a stray other index
      // means an endpoint speaking a dialect we must not silently merge.
      if (choice.index !== 0) {
        throw new LlmError(`openai: unexpected choice index ${choice.index} for model "${model}"`, 'PROTOCOL')
      }
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const last = blocks[blocks.length - 1]
        let index: number
        if (last !== undefined && last.kind === 'text') {
          index = blocks.length - 1
        } else {
          index = blocks.length
          blocks.push({ kind: 'text', text: '' })

          yield { type: 'block-start', index, blockType: 'text' }
        }
        const block = blocks[index] as BlockState & { kind: 'text' }
        block.text += delta.content
        yield { type: 'text-delta', index, text: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolDelta of delta.tool_calls) {
          let index: number
          if (typeof toolDelta.id === 'string' && toolDelta.id.length > 0) {
            index = blocks.length
            blocks.push({
              kind: 'tool-call',
              id: toolDelta.id as ToolCallId,
              name: typeof toolDelta.function?.name === 'string' ? toolDelta.function.name : '',
              nameSent: false,
              arguments: '',
            })
            toolBlockByInputIndex.set(toolDelta.index, index)

            yield { type: 'block-start', index, blockType: 'tool-call' }
          } else {
            const found = toolBlockByInputIndex.get(toolDelta.index)
            if (found === undefined) {
              throw new LlmError(
                `openai: tool-call arguments arrived before the call id for model "${model}"`,
                'PROTOCOL',
              )
            }
            index = found
          }
          const block = blocks[index] as BlockState & { kind: 'tool-call' }
          if (typeof toolDelta.function?.name === 'string' && toolDelta.function.name.length > 0) {
            block.name = toolDelta.function.name
          }
          const argumentsDelta = typeof toolDelta.function?.arguments === 'string' ? toolDelta.function.arguments : ''
          block.arguments += argumentsDelta
          // `name` rides only the first delta of a block.
          const sendName = !block.nameSent && block.name.length > 0
          if (sendName) block.nameSent = true
          yield {
            type: 'tool-call-delta',
            index,
            id: block.id,
            ...sendName ? { name: block.name } : {},
            argumentsDelta,
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (blocks.length === 0) {
          // Degenerate completion: the attempt produced nothing durable, and
          // the retry policy treats EMPTY_RESPONSE as safe to repeat.
          throw new LlmError(`openai: model "${model}" returned an empty completion`, EMPTY_RESPONSE_CODE)
        }
        for (const end of closeAllBlocks()) yield end
        if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
        yield { type: 'finish', reason: mapFinishReason(choice.finish_reason) }
        finished = true
      }
    }
  }

  if (!finished) {
    // A stream that ends without a finish_reason is a protocol violation; keep
    // already-assembled content by closing blocks, then report the truncation.
    if (blocks.length > 0) {
      for (const end of closeAllBlocks()) yield end
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'openai: stream ended without a finish_reason', code: 'PROTOCOL' } },
      }
    } else {
      // Degenerate completion: the attempt produced nothing durable, and the
      // retry policy treats EMPTY_RESPONSE as safe to repeat.
      throw new LlmError(`openai: model "${model}" returned an empty completion`, EMPTY_RESPONSE_CODE)
    }
  }
}
