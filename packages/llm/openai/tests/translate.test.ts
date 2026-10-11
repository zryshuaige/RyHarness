import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@ryagent/llm'
import { mapFinishReason, mapUsage, translateChunks } from '@ryagent/llm-openai'

async function* events(payloads: string[]): AsyncIterable<string> {
  yield* payloads
}

async function collect(payloads: string[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateChunks(events(payloads), 'test-model')) chunks.push(chunk)
  return chunks
}

function chunk(payload: unknown): string {
  return JSON.stringify(payload)
}

describe('translateChunks', () => {
  it('translates a pure text stream with usage before finish', async () => {
    const chunks = await collect([
      chunk({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] }),
      chunk({ id: '1', choices: [{ index: 0, delta: { content: ', world' } }] }),
      chunk({
        id: '1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 3,
          total_tokens: 14,
          completion_tokens_details: { reasoning_tokens: 2 },
          prompt_tokens_details: { cache_read_tokens: 1 },
        },
      }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'text-delta', index: 0, text: ', world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world' } },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          totalTokens: 14,
          cacheReadTokens: 1,
          reasoningTokens: 2,
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles parallel tool calls into complete blocks with raw JSON arguments', async () => {
    const chunks = await collect([
      chunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' } },
              { index: 1, id: 'call_2', type: 'function', function: { name: 'sum', arguments: '' } },
            ],
          },
        }],
      }),
      chunk({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] },
        }],
      }),
      chunk({
        choices: [{
          index: 0,
          delta: {
            content: 'Done.',
            tool_calls: [
              { index: 0, function: { arguments: ' "hi"}' } },
              { index: 1, function: { arguments: '{"a":1}' } },
            ],
          },
        }],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'echo', argumentsDelta: '' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'call_2', name: 'sum', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"text":' },
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 2, text: 'Done.' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: ' "hi"}' },
      { type: 'tool-call-delta', index: 1, id: 'call_2', argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"text": "hi"}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_2', name: 'sum', arguments: '{"a":1}' } },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'Done.' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('throws EMPTY_RESPONSE when the stream carries no blocks', async () => {
    await expect(collect([chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })]))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('closes blocks and reports an error finish when finish_reason never arrives', async () => {
    const chunks = await collect([
      chunk({ choices: [{ index: 0, delta: { content: 'partial' } }] }),
    ])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'openai: stream ended without a finish_reason', code: 'PROTOCOL' } },
    })
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
    ])
  })

  it('rejects tool-call arguments that arrive before the call id', async () => {
    await expect(collect([
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }),
    ])).rejects.toMatchObject({ code: 'PROTOCOL' })
  })

  it('rejects malformed JSON payloads', async () => {
    await expect(collect(['{not json'])).rejects.toMatchObject({ code: 'PROTOCOL' })
  })
})

describe('mapUsage', () => {
  it('keeps cache and reasoning tokens disjoint from input tokens', () => {
    expect(mapUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cache_read_tokens: 30, cache_creation_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 5 },
    })).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 5,
    })
  })

  it('omits zero-valued optional fields', () => {
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }))
      .toEqual({ inputTokens: 5, outputTokens: 5, totalTokens: 10 })
  })
})

describe('mapFinishReason', () => {
  it('maps the wire vocabulary', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toMatchObject({ kind: 'error' })
    expect(mapFinishReason('weird')).toMatchObject({ kind: 'error' })
  })
})
