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
 * @module @ryharness/llm-openai/translate
 */

import type { FinishReason, ReplayEnvelope, StreamChunk, TokenUsage, ToolCallId } from '@ryharness/llm'
import { EMPTY_RESPONSE_CODE, LlmError } from '@ryharness/llm'
import type { OpenAiStreamChunk, OpenAiWireUsage } from './wire.ts'

/** One output block under assembly, keyed by its {@link StreamChunk} block index. */
type BlockState =
  | { readonly kind: 'text'; text: string }
  | { readonly kind: 'reasoning'; text: string }
  | { readonly kind: 'tool-call'; id: ToolCallId; name: string; nameSent: boolean; arguments: string }

/**
 * 成功响应的 replay 元数据。
 *
 * 只带响应级的东西（响应 id / 创建时间 / 模型）：OpenAI 的每块内容都能从装配好
 * 的 block 里还原（工具 id、名字、参数都在块里），所以**不声明** `blocks`——
 * 装配层允许「元数据与块结构无关」的适配器省略这一项，于是这份 envelope 在
 * 装配时原样透传。
 * @param meta - 本次流里见过的响应级元数据。
 * @returns envelope；什么都没见到时返回 undefined（不必产出一个空壳）。
 */
function replayStateOf(meta: { id?: string; created?: number; model?: string }): ReplayEnvelope | undefined {
  if (meta.id === undefined && meta.created === undefined && meta.model === undefined) return undefined
  return { response: { ...meta } }
}

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
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
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
      return {
        kind: 'error',
        failure: { message: 'openai: response blocked by content filter', code: 'CONTENT_FILTER' },
      }
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
export async function* translateChunks(events: AsyncIterable<string>, model: string): AsyncGenerator<StreamChunk> {
  const blocks: BlockState[] = []
  /** OpenAI parallel tool-call index -> output block index. */
  const toolBlockByInputIndex = new Map<number, number>()
  /** Whether the terminal `finish` chunk has been emitted. */
  let finished = false
  /** Usage from the terminal chunk; emitted after block-end, before finish. */
  let pendingUsage: TokenUsage | undefined
  /**
   * 供应商回传的响应级元数据（响应 id / 模型 / 创建时间）。
   *
   * 这是「换成另一个供应商继续对话」时唯一丢不掉的东西：内容块在装配层已经
   * 成型，但这条 id 能让人追溯到供应商侧的那次响应。之前适配器从不产出
   * replayState，于是装配层的 replay 分支在生产链路上一直是死的。
   */
  let responseMeta: { id?: string; created?: number; model?: string } = {}

  /** Emit `block-end` for every block, in block order. */
  const closeAllBlocks = (): StreamChunk[] => {
    return blocks.map((block, index): StreamChunk => {
      if (block.kind === 'text') return { type: 'block-end', index, block: { type: 'text', text: block.text } }
      if (block.kind === 'reasoning') {
        return { type: 'block-end', index, block: { type: 'reasoning', text: block.text } }
      }
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
      throw new LlmError('openai: malformed stream chunk', 'PROTOCOL', {
        cause: new TypeError('chunk is not a chat.completion.chunk'),
      })
    }

    // Usage rides the terminal chunk with empty choices; defer it so it is
    // emitted after the assembled blocks and before the finish chunk. The spec
    // pins `usage: null` on every earlier chunk (DeepSeek follows literally).
    if (chunk.usage !== undefined && chunk.usage !== null) {
      pendingUsage = mapUsage(chunk.usage)
    }
    // 响应级元数据：取最后一次见到的（后续 chunk 会重复带上同样的值）。
    if (typeof chunk.id === 'string') responseMeta = { ...responseMeta, id: chunk.id }
    if (typeof chunk.created === 'number') responseMeta = { ...responseMeta, created: chunk.created }
    if (typeof chunk.model === 'string') responseMeta = { ...responseMeta, model: chunk.model }

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
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        const last = blocks[blocks.length - 1]
        let index: number
        if (last !== undefined && last.kind === 'reasoning') {
          index = blocks.length - 1
        } else {
          index = blocks.length
          blocks.push({ kind: 'reasoning', text: '' })

          yield { type: 'block-start', index, blockType: 'reasoning' }
        }
        const block = blocks[index] as BlockState & { kind: 'reasoning' }
        block.text += delta.reasoning_content
        yield { type: 'reasoning-delta', index, text: delta.reasoning_content }
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
            ...(sendName ? { name: block.name } : {}),
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
        yield {
          type: 'finish',
          reason: mapFinishReason(choice.finish_reason),
          // 成功才有 replayState：失败的那次尝试没有可重放的东西。
          ...(replayStateOf(responseMeta) === undefined ? {} : { replayState: replayStateOf(responseMeta) }),
        }
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
        reason: {
          kind: 'error',
          failure: { message: 'openai: stream ended without a finish_reason', code: 'PROTOCOL' },
        },
      }
    } else {
      // Degenerate completion: the attempt produced nothing durable, and the
      // retry policy treats EMPTY_RESPONSE as safe to repeat.
      throw new LlmError(`openai: model "${model}" returned an empty completion`, EMPTY_RESPONSE_CODE)
    }
  }
}
