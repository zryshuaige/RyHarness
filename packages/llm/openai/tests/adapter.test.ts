import { brandString } from '@ryharness/brand'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@ryharness/llm'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
} from '@ryharness/llm'
import type { OpenAiChatRequest } from '@ryharness/llm-openai'
import { OpenAiAdapter, serializeRequest } from '@ryharness/llm-openai'
import { describe, expect, it } from 'vitest'

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
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.type === 'text-delta' && c.text)
        .join(''),
    ).toBe('Hi')
    expect(chunks.some((c) => c.type === 'usage' && c.usage.totalTokens === 4)).toBe(true)
    expect(seenBody).toMatchObject({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('round-trips a tool call and its result', async () => {
    const adapter = makeAdapter(async () =>
      sseResponse(
        data({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '' } }],
              },
            },
          ],
        }),
        data({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"x"}' } }] } }],
        }),
        data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ),
    )
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
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }],
      },
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

  it('passes the caller signal through to fetch (fused with the idle watchdog)', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const adapter = makeAdapter(async (_input, init) => {
      seen = init?.signal ?? undefined
      expect(seen?.aborted).toBe(false)
      controller.abort()
      // 调用方取消传导到 fetch 收到的 signal。
      expect(seen?.aborted).toBe(true)
      return sseResponse(...ECHO_SCE)
    })
    await collect(adapter.stream({ ...baseOptions, signal: controller.signal }))
    expect(seen).toBeInstanceOf(AbortSignal)
  })

  it('maps 429 with quota wording to QUOTA and honors retry-after', async () => {
    const adapter = makeAdapter(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Insufficient balance', code: 'balance' } }), {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    )
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('QUOTA')
    // 供应商要求的退避与排障事实要进 failure（之前算了却丢在构造函数外）。
    expect((error as LlmError).failure.providerRetryAfterMs).toBe(30_000)
    expect((error as LlmError).failure.status).toBe(429)
  })

  it('429 的 Retry-After 支持 HTTP-date 形态，request-id 头进 failure（排障要件）', async () => {
    const adapter = makeAdapter(
      async () =>
        new Response(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }), {
          status: 429,
          headers: {
            'retry-after': new Date(Date.now() + 45_000).toUTCString(),
            'x-request-id': 'req-abc-123',
          },
        }),
    )
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    const failure = (error as LlmError).failure
    expect(failure.code).toBe('RATE_LIMIT')
    expect(failure.requestId).toBe('req-abc-123')
    expect(failure.providerRetryAfterMs).toBeGreaterThan(0)
    expect(failure.providerRetryAfterMs).toBeLessThanOrEqual(45_000)
  })

  it('maps 401 to INVALID_CREDENTIAL', async () => {
    const adapter = makeAdapter(async () => new Response('unauthorized', { status: 401 }))
    const error = await collect(adapter.stream(baseOptions)).catch((e: unknown) => e)
    expect((error as LlmError).code).toBe('INVALID_CREDENTIAL')
  })

  it('fails with MISSING_CREDENTIAL when the environment variable is absent', async () => {
    const adapter = new OpenAiAdapter({
      providers: {
        test: { baseURL: 'https://example.test/v1', apiKeyEnv: 'DEFINITELY_UNSET_KEY', models: [{ id: 'm' }] },
      },
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
    expect(request.tools).toEqual([
      { type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object' } } },
    ])
    expect(request).toMatchObject({ temperature: 0.5, max_tokens: 64, stream: true })
  })

  it('marks errored tool results', () => {
    const request = serializeRequest({
      provider: 'test',
      model: 'm',
      messages: [
        createToolResultMessage({
          callId: brandString<ToolCallId>('c9'),
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        }),
      ],
    })
    expect(request.messages).toEqual([{ role: 'tool', tool_call_id: 'c9', content: '[Tool error]\nboom' }])
  })
})

/**
 * 思考档位目录的暴露。
 *
 * 这是 UI 决定「要不要给用户思考强度选择器」的唯一依据。路由没声明 reasoningControl
 * 就不给——否则用户选哪档都会被端点静默忽略，一个装饰性的控件比没有更糟。
 */
describe('adapter 思考档位目录', () => {
  const adapterFor = (reasoningControl: 'effort' | 'thinking-adaptive' | 'none' | undefined): OpenAiAdapter =>
    new OpenAiAdapter({
      providers: {
        test: {
          baseURL: 'https://example.test/v1',
          apiKey: 'sk-test',
          models: [{ id: 'm', contextWindow: 8192 }],
          ...(reasoningControl === undefined ? {} : { reasoningControl }),
        },
      },
      // 这组用例只调 resolveModel：它读配置、拼档位目录，一个请求都不发。
      // 所以这里给一个永不触发的桩就够了，不需要为它编一个完整 fetch 签名。
      fetch: async () => {
        throw new Error('resolveModel 不该发请求')
      },
    })

  it('声明支持的路由给出档位与默认档', async () => {
    const resolved = await adapterFor('effort').resolveModel('test', 'm')
    expect(
      resolved.reasoning?.efforts.map((effort) => {
        return effort.id
      }),
    ).toEqual(['low', 'medium', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
  })

  it('未声明的路由不声明档位（UI 据此不给选择器）', async () => {
    expect((await adapterFor(undefined).resolveModel('test', 'm')).reasoning).toBeUndefined()
  })

  it('显式声明 none 同样不声明档位', async () => {
    expect((await adapterFor('none').resolveModel('test', 'm')).reasoning).toBeUndefined()
  })
})
