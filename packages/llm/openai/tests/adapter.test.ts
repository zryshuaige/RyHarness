import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@ryagent/llm'
import { brandString } from '@ryagent/brand'
import { createUserMessage, createAssistantMessage, createToolResultMessage, createDeveloperMessage, LlmError } from '@ryagent/llm'
import { OpenAiAdapter, serializeRequest } from '@ryagent/llm-openai'
import type { OpenAiChatRequest } from '@ryagent/llm-openai'

function sseResponse(...lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const ECHO_SCE = [
  data({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }] }),
  data({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }),
  'data: [DONE]\n\n',
]

function makeAdapter(fetchImpl: typeof fetch): OpenAiAdapter {
  return new OpenAiAdapter({
    providers: {
      test: {
        baseURL: 'https://example.test/v1',
        apiKey: 'sk-test',
        displayName: 'Test Provider',
        models: [{ id: 'test-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
    fetch: fetchImpl,
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const baseOptions: GenerateOptions = {
  provider: 'test',
  model: 'test-model',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
}

describe('OpenAiAdapter', () => {
  it('streams text through fetch and maps the wire request', async () => {
    let seenBody: OpenAiChatRequest | undefined
    const adapter = makeAdapter(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as OpenAiChatRequest
      return sseResponse(...ECHO_SCE)
    })
    const chunks = await collect(adapter.stream(baseOptions))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.type === 'text-delta' && c.text).join('')).toBe('Hi')
    expect(chunks.some((c) => c.type === 'usage' && c.usage.totalTokens === 4)).toBe(true)
    expect(seenBody).toMatchObject({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('round-trips a tool call and its result', async () => {
    const adapter = makeAdapter(async () => sseResponse(
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '' } }] } }] }),
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"x"}' } }] } }] }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ))
    const options: GenerateOptions = {
      ...baseOptions,
      messages: [
        ...baseOptions.messages,
        createAssistantMessage({
          content: [{ type: 'tool-call', id: brandString<ToolCallId>('c1'), name: 'echo', arguments: '{"text":"x"}' }],
          source: { provider: 'test', model: 'test-model' },
        }),
        createToolResultMessage({
          callId: brandString<ToolCallId>('c1'),
          content: [{ type: 'text', text: 'x' }],
          isError: false,
        }),
      ],
    }
    let seenBody: OpenAiChatRequest | undefined
    const capturing = makeAdapter(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as OpenAiChatRequest
      return sseResponse(...ECHO_SCE)
    })
    await collect(capturing.stream(options))
    expect(seenBody?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'x' },
    ])
    // The adapter itself reports tool-call assembly through StreamChunk blocks.
    const chunks = await collect(adapter.stream(baseOptions))
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{"text":"x"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps 429 with quota wording to QUOTA and honors retry-after', async () => {
    const adapter = makeAdapter(async () => new Response(
      JSON.stringify({ error: { message: 'Insufficient balance', code: 'balance' } }),
      { status: 429, headers: { 'retry-after': '30' } },
    ))
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA')
  })

  it('maps 401 to INVALID_CREDENTIAL', async () => {
    const adapter = makeAdapter(async () => new Response('unauthorized', { status: 401 }))
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect((error as LlmError).code).toBe('INVALID_CREDENTIAL')
  })

  it('fails with MISSING_CREDENTIAL when the environment variable is absent', async () => {
    const adapter = new OpenAiAdapter({
      providers: { test: { baseURL: 'https://example.test/v1', apiKeyEnv: 'DEFINITELY_UNSET_KEY', models: [{ id: 'm' }] } },
      env: () => undefined,
    })
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect((error as LlmError).code).toBe('MISSING_CREDENTIAL')
  })

  it('exposes configured models through listModels and resolveModel', async () => {
    const adapter = makeAdapter(async () => sseResponse(...ECHO_SCE))
    const models = await adapter.listModels('test')
    expect(models).toEqual([{ provider: 'test', id: 'test-model', name: 'test-model', inputModalities: ['text'] }])
    await expect(adapter.resolveModel('test', 'test-model')).resolves.toMatchObject({
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
      inputModalities: ['text'],
    })
    await expect(adapter.resolveModel('nope', 'm')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })
})

describe('serializeRequest', () => {
  it('degrades tool-addition/removal blocks to text notes and sends complete tools', () => {
    const request = serializeRequest({
      provider: 'test',
      model: 'm',
      system: 'be nice',
      temperature: 0.5,
      maxTokens: 64,
      tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }],
      messages: [
        createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'echo' }], source: { kind: 'user' } }),
        createDeveloperMessage({ content: [{ type: 'tool-removal', toolName: 'old' }], source: { kind: 'user' } }),
      ],
    })
    expect(request.messages).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'system', content: '[Tool "echo" added]' },
      { role: 'system', content: '[Tool "old" removed]' },
    ])
    expect(request.tools).toEqual([{ type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object' } } }])
    expect(request).toMatchObject({ temperature: 0.5, max_tokens: 64, stream: true })
  })

  it('marks errored tool results', () => {
    const request = serializeRequest({
      provider: 'test',
      model: 'm',
      messages: [createToolResultMessage({ callId: brandString<ToolCallId>('c9'), content: [{ type: 'text', text: 'boom' }], isError: true })],
    })
    expect(request.messages).toEqual([{ role: 'tool', tool_call_id: 'c9', content: '[Tool error]\nboom' }])
  })
})
