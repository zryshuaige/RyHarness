/**
 * OpenAI-compatible `chat/completions` adapter for the RyHarness LLM seam.
 *
 * One instance serves any number of provider routes (OpenAI, SiliconFlow,
 * self-hosted vLLM/Ollama gateways...) from plain configuration; the only
 * required {@link LlmAdapter} method, `stream()`, is a direct-fetch SSE
 * pipeline: serialize → POST → parse SSE → translate chunks.
 * @module @ryharness/llm-openai/adapter
 */

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@ryharness/llm'
import {
  assertUsableApiKey,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@ryharness/llm'
import { idleWatchdog, timeoutOf } from '@ryharness/timeout'
import { assertProviderConfig, type OpenAiAdapterConfig, type OpenAiProviderConfig } from './config.ts'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translateChunks } from './translate.ts'
import type { OpenAiWireError } from './wire.ts'

/** Canonical code for a route whose configured credential resolved to nothing. */
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'

/** Default per-route idle timeout when neither route nor adapter sets one. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000

/** Route configuration lookup failure (adapter used without registration). */
function unknownProvider(provider: string): LlmError {
  return new LlmError(`@ryharness/llm-openai: no provider route "${provider}" is configured`, 'NO_ADAPTER')
}

/** Parse a Retry-After header: either delay-seconds or an HTTP-date (RFC 7231 两种形态都合法）。 */
/**
 * 思考档位目录。
 *
 * 只在路由声明了 `reasoningControl` 时才有意义——否则用户选哪档都会被端点静默忽略，
 * 给一个装饰性的选择器比不给更糟。
 *
 * 取值来自各家官方文档（2026-10 核对），**刻意只取各家都接受的交集**：同一个值发给
 * 不同厂商都合法，用「少几个选项」换「零 400」。逐模型的完整枚举差异很大且频繁变动
 * （MiniMax M3.1 有 xhigh、GLM-5.2 有 minimal、OpenAI 的 GPT-6.1 干脆不给 none），
 * 要精确枚举就得每季度跟一次公告，不适合写死在适配器里。
 */
const REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId('low'), name: '低' },
  { id: ReasoningEffortId('medium'), name: '中' },
  { id: ReasoningEffortId('high'), name: '高' },
]

function reasoningInfoFor(profile: OpenAiProviderConfig): LlmModelReasoningInfo | undefined {
  if (profile.reasoningControl === undefined || profile.reasoningControl === 'none') return undefined
  return { efforts: REASONING_EFFORTS, defaultEffort: ReasoningEffortId('medium') }
}

/** Parse a Retry-After header: either delay-seconds or an HTTP-date (RFC 7231 两种形态都合法)。 */
function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  // HTTP-date 形态（如 "Wed, 21 Oct 2026 07:28:00 GMT"）：网关与代理常用它而非秒数。
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  const delta = dateMs - Date.now()
  return delta > 0 ? delta : undefined
}

/** Map one non-2xx provider response to a provider-neutral {@link LlmError}. */
async function httpError(provider: string, response: Response): Promise<LlmError> {
  const text = await response.text()
  let raw: OpenAiWireError | undefined
  try {
    raw = JSON.parse(text) as OpenAiWireError
  } catch {
    // HTTP status is authoritative when a gateway does not return JSON.
  }
  const detail = `${raw?.error?.code ?? ''} ${raw?.error?.type ?? ''} ${raw?.error?.message ?? ''} ${text}`.trim()
  const providerRetryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  // 供应商的 request id 是排障时唯一能拿给客服/工单的东西——之前算了却没带上。
  const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? undefined
  return new LlmError(
    `openai (${provider}): HTTP ${response.status} ${raw?.error?.message ?? text}`.trim(),
    classifyStatus(response.status, detail),
    {
      cause: new Error(text.slice(0, 512)),
      status: response.status,
      ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
      ...(requestId === null || requestId === undefined || requestId.length === 0
        ? {}
        : { requestId: ProviderRequestId(requestId) }),
    },
  )
}

/** Pick the stable failure code for one HTTP status and error detail. */
function classifyStatus(status: number, detail: string): string {
  if (status === 400) {
    return isContextWindowExceededError(detail) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_ARGS'
  }
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 404) return 'NOT_FOUND'
  if (status === 408) return 'TIMEOUT'
  if (status === 409) return 'CONFLICT'
  if (status === 429) {
    return isQuotaExceededError(detail) ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT'
  }
  if (status >= 500) return 'SERVER'
  return 'TRANSPORT'
}

/** Multi-route OpenAI-compatible adapter. */
export class OpenAiAdapter extends LlmAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly env: (name: string) => string | undefined
  private readonly idleTimeoutMs: number

  constructor(private readonly options: OpenAiAdapterConfig) {
    super()
    for (const [route, profile] of Object.entries(options.providers)) {
      assertProviderConfig(route, profile)
    }
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.env = options.env ?? ((name) => process.env[name])
    this.idleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  }

  override providerInfo(provider: string) {
    const profile = this.options.providers[provider]
    return { id: provider, name: profile?.displayName ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.options.providers[provider]
    if (profile === undefined) return Promise.resolve([])
    return Promise.resolve(
      profile.models.map((model) => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: ['text' as const],
      })),
    )
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.options.providers[provider]
    if (profile === undefined) return Promise.reject(unknownProvider(provider))
    const configured = profile.models.find((entry) => entry.id === model)
    const reasoning = reasoningInfoFor(profile)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...(configured?.description === undefined ? {} : { description: configured.description }),
      inputModalities: ['text' as const],
      ...(configured?.contextWindow === undefined ? {} : { context: { contextWindow: configured.contextWindow } }),
      ...(configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const profile = this.options.providers[options.provider]
    if (profile === undefined) throw unknownProvider(options.provider)
    return this.generate(options, profile)
  }

  /** Resolve the credential for one route at request time, validated for HTTP carriage. */
  private resolveApiKey(provider: string, profile: OpenAiProviderConfig): string {
    if (profile.apiKey !== undefined) {
      return assertUsableApiKey(profile.apiKey, '@ryharness/llm-openai', 'apiKey')
    }
    const envName = profile.apiKeyEnv as string
    const raw = this.env(envName)
    if (raw === undefined) {
      throw new LlmError(
        `@ryharness/llm-openai: provider "${provider}" needs its API key in the ${envName} environment variable`,
        MISSING_CREDENTIAL_CODE,
      )
    }
    return assertUsableApiKey(raw, '@ryharness/llm-openai', envName)
  }

  private async *generate(options: GenerateOptions, profile: OpenAiProviderConfig): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, profile.streamIdleTimeoutMs ?? this.idleTimeoutMs, 'OPENAI_IDLE')
    const iterator = this.request(options, profile, watchdog.signal, () => {
      watchdog.pulse()
    })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'OPENAI_IDLE') !== undefined) {
        throw new LlmError('openai: stream idle timeout', 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('openai: request aborted', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('openai: transport failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort()
      // 排水不 await：被 idle watchdog 放弃的 demand 可能永久挂起，await 它的
      // return() 会把已经定居的结果重新卡死（上游 dsh llm-deepseek 同款处理）。
      // 失败也改变不了请求已定居的事实，吞掉即可。
      void Promise.resolve(iterator.return(undefined)).catch(() => {})
    }
  }

  private async *request(
    options: GenerateOptions,
    profile: OpenAiProviderConfig,
    signal: AbortSignal,
    activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const apiKey = this.resolveApiKey(options.provider, profile)
    const body = serializeRequest(options, profile.reasoningControl)
    const baseURL = profile.baseURL.replace(/\/+$/, '')
    const response = await this.fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      signal,
      redirect: 'error',
      body: JSON.stringify(body),
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
        ...profile.headers,
      },
    })
    if (!response.ok) {
      throw await httpError(options.provider, response)
    }
    if (response.body === null) {
      throw new LlmError('openai: response carried no body', 'EMPTY_RESPONSE')
    }
    yield* translateChunks(parseSse(response.body, activity), options.model)
  }
}
