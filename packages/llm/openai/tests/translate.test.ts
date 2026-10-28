import type { StreamChunk } from '@ryharness/llm'
import { mapFinishReason, mapUsage, translateChunks } from '@ryharness/llm-openai'
import { describe, expect, it } from 'vitest'

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
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: { response: { id: '1' } },
      },
    ])
  })

  it('ignores the spec-mandated `usage: null` on non-terminal chunks (DeepSeek dialect)', async () => {
    const chunks = await collect([
      chunk({ id: '1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }], usage: null }),
      chunk({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: '1' } } },
    ])
  })

  it('成功的响应带上 replay 元数据（响应 id / 模型），失败的那次没有', async () => {
    // 这份元数据是「换成另一个供应商继续对话」时唯一丢不掉的东西：内容块在装配层
    // 已经成型，但这条 id 能追溯到供应商侧的那次响应。适配器从前从不产出它，
    // 于是装配层的 replay 分支在生产链路上一直是死的。
    const ok = await collect([
      chunk({ id: 'resp-1', model: 'demo-model', created: 1700, choices: [{ index: 0, delta: { content: 'Hi' } }] }),
      chunk({
        id: 'resp-1',
        model: 'demo-model',
        created: 1700,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
    ])
    const finish = ok.find((chunk) => {
      return chunk.type === 'finish'
    })
    expect(finish).toEqual({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { id: 'resp-1', created: 1700, model: 'demo-model' } },
    })

    // 供应商连 id 都没给时不产出一个空壳 envelope。
    const bare = await collect([
      chunk({ choices: [{ index: 0, delta: { content: 'Hi' } }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ])
    expect(
      bare.find((chunk) => {
        return chunk.type === 'finish'
      }),
    ).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles reasoning_content into a reasoning block ahead of visible text', async () => {
    const chunks = await collect([
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '想一下' } }] }),
      chunk({ choices: [{ index: 0, delta: { reasoning_content: '……' } }] }),
      chunk({ choices: [{ index: 0, delta: { content: '答案' } }] }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '想一下' },
      { type: 'reasoning-delta', index: 0, text: '……' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '答案' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下……' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles parallel tool calls into complete blocks with raw JSON arguments', async () => {
    const chunks = await collect([
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' } },
                { index: 1, id: 'call_2', type: 'function', function: { name: 'sum', arguments: '' } },
              ],
            },
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] },
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              content: 'Done.',
              tool_calls: [
                { index: 0, function: { arguments: ' "hi"}' } },
                { index: 1, function: { arguments: '{"a":1}' } },
              ],
            },
          },
        ],
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
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_1', name: 'echo', arguments: '{"text": "hi"}' },
      },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_2', name: 'sum', arguments: '{"a":1}' } },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'Done.' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('throws EMPTY_RESPONSE when the stream carries no blocks', async () => {
    await expect(collect([chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })])).rejects.toMatchObject(
      { code: 'EMPTY_RESPONSE' },
    )
  })

  it('closes blocks and reports an error finish when finish_reason never arrives', async () => {
    const chunks = await collect([chunk({ choices: [{ index: 0, delta: { content: 'partial' } }] })])
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'openai: stream ended without a finish_reason', code: 'PROTOCOL' } },
    })
    expect(chunks.filter((c) => c.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
    ])
  })

  it('rejects tool-call arguments that arrive before the call id', async () => {
    await expect(
      collect([
        chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }),
      ]),
    ).rejects.toMatchObject({ code: 'PROTOCOL' })
  })

  it('rejects malformed JSON payloads', async () => {
    await expect(collect(['{not json'])).rejects.toMatchObject({ code: 'PROTOCOL' })
  })
})

describe('mapUsage', () => {
  it('keeps cache and reasoning tokens disjoint from input tokens', () => {
    expect(
      mapUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cache_read_tokens: 30, cache_creation_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 5,
    })
  })

  it('omits zero-valued optional fields', () => {
    expect(mapUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 })).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    })
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
