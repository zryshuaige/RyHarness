/**
 * OpenAI-compatible `chat/completions` adapter for the RyAgent LLM seam.
 *
 * One instance serves any number of provider routes (OpenAI, SiliconFlow,
 * self-hosted vLLM/Ollama gateways...) from plain configuration; the only
 * required {@link LlmAdapter} method, `stream()`, is a direct-fetch SSE
 * pipeline: serialize → POST → parse SSE → translate chunks.
 * @module @ryagent/llm-openai/adapter
 */

import {
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@ryagent/llm'
import { assertUsableApiKey } from '@ryagent/llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@ryagent/llm'
import { idleWatchdog, timeoutOf } from '@ryagent/timeout'
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
  return new LlmError(`@ryagent/llm-openai: no provider route "${provider}" is configured`, 'NO_ADAPTER')
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
  const retryAfter = response.headers.get('retry-after')
  const providerRetryAfterMs = retryAfter !== null && /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : undefined
  const failure = { message: `openai (${provider}): HTTP ${response.status} ${raw?.error?.message ?? text}`.trim(), code: classifyStatus(response.status, detail), ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs } }
  return new LlmError(failure.message, failure.code, {
    cause: new Error(text.slice(0, 512)),
  })
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
    return Promise.resolve(profile.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: ['text' as const],
    })))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.options.providers[provider]
    if (profile === undefined) return Promise.reject(unknownProvider(provider))
    const configured = profile.models.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      ...configured?.description === undefined ? {} : { description: configured.description },
      inputModalities: ['text' as const],
      ...configured?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: configured.contextWindow } },
      ...configured?.maxTokens === undefined ? {} : { defaultMaxTokens: configured.maxTokens },
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
      return assertUsableApiKey(profile.apiKey, '@ryagent/llm-openai', 'apiKey')
    }
    const envName = profile.apiKeyEnv as string
    const raw = this.env(envName)
    if (raw === undefined) {
      throw new LlmError(
        `@ryagent/llm-openai: provider "${provider}" needs its API key in the ${envName} environment variable`,
        MISSING_CREDENTIAL_CODE,
      )
    }
    return assertUsableApiKey(raw, '@ryagent/llm-openai', envName)
  }

  private async *generate(
    options: GenerateOptions,
    profile: OpenAiProviderConfig,
  ): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, profile.streamIdleTimeoutMs ?? this.idleTimeoutMs, 'OPENAI_IDLE')
    const iterator = this.request(options, profile, watchdog.signal, () => { watchdog.pulse() })
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
      try {
        await iterator.return(undefined)
      } catch {
        // The request already settled; aborting its reader cannot replace that outcome.
      }
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
    const body = serializeRequest(options)
    const baseURL = profile.baseURL.replace(/\/+$/, '')
    const response = await this.fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      signal,
      redirect: 'error',
      body: JSON.stringify(body),
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        'authorization': `Bearer ${apiKey}`,
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
