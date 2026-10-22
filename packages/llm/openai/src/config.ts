/**
 * Configuration for the RyHarness OpenAI-compatible adapter.
 *
 * One adapter instance owns any number of provider routes; each route is a
 * plain data profile `{ baseURL, apiKeyEnv, models }`, which is what makes the
 * same adapter serve OpenAI, SiliconFlow, or any self-hosted
 * `openai-completions` endpoint without code changes.
 * @module @ryharness/llm-openai/config
 */

/** Static description of one model a route advertises. */
export interface OpenAiModelConfig {
  /** Model id sent as `model` on the wire. */
  id: string
  /** Human-readable name for selectors; defaults to the id. */
  name?: string
  /** Optional user-facing distinction from similar models. */
  description?: string
  /** Combined request+response context capacity in tokens, when known. */
  contextWindow?: number
  /** Adapter-configured per-request output cap materialized when callers omit `maxTokens`. */
  maxTokens?: number
}

/** One provider route profile. */
export interface OpenAiProviderConfig {
  /** Endpoint root, e.g. `https://api.siliconflow.cn/v1`; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Name of the environment variable holding the API key. Resolved per
   * request, so rotating the environment never restarts the process. Exactly
   * one of `apiKeyEnv` / `apiKey` must be set.
   */
  apiKeyEnv?: string
  /** Direct API key (tests and sealed deployments); prefer `apiKeyEnv` elsewhere. */
  apiKey?: string
  /** Human-readable provider name; defaults to the route key. */
  displayName?: string
  /** Models this route advertises through `listModels()` / `resolveModel()`. */
  models: OpenAiModelConfig[]
  /** Extra request headers merged after the adapter's own (e.g. a gateway token). */
  headers?: Record<string, string>
  /** Stream idle timeout for this route, in milliseconds. */
  streamIdleTimeoutMs?: number
  /**
   * 这条路由怎么表达「思考强度」，决定适配器往请求里发哪个字段。
   *
   * `chat/completions` 没有统一的思考参数，各家各给一份，而**发错字段就是 400**：
   * - `effort`：只认顶层 `reasoning_effort`（OpenAI / Kimi / GLM / MiniMax 都认），
   *   这是默认值——不发 `thinking` 最安全，不认的端点会忽略它。
   * - `thinking-adaptive`：额外认 `thinking: {type}`，且关思考时用 MiniMax / Kimi 的
   *   词 `adaptive` 而非 OpenAI 的 `disabled`。
   * - `none`：不认任何思考参数（默认）。此时内核只声明可用档位、不往请求里塞字段，
   *   免得用户选了档位就换来一整轮 400。
   */
  reasoningControl?: 'effort' | 'thinking-adaptive' | 'none'
}

/** Adapter construction options. */
export interface OpenAiAdapterConfig {
  /** Every provider route this adapter serves, keyed by the route id registered with `LlmRuntime.registerAdapter()`. */
  providers: Record<string, OpenAiProviderConfig>
  /** Default stream idle timeout when a route does not set one (default 60_000). */
  streamIdleTimeoutMs?: number
  /** Fetch implementation override; tests inject a mock here. */
  fetch?: typeof fetch
  /** Environment lookup override; defaults to `process.env[name]`. */
  env?: (name: string) => string | undefined
}

/** Validate one provider profile; throws a plain `Error` naming the bad field. */
export function assertProviderConfig(route: string, profile: OpenAiProviderConfig): void {
  if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) {
    throw new Error(`@ryharness/llm-openai: provider "${route}" needs a non-empty baseURL`)
  }
  if ((profile.apiKeyEnv === undefined) === (profile.apiKey === undefined)) {
    throw new Error(`@ryharness/llm-openai: provider "${route}" must set exactly one of apiKeyEnv / apiKey`)
  }
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    throw new Error(`@ryharness/llm-openai: provider "${route}" must declare at least one model`)
  }
  for (const model of profile.models) {
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`@ryharness/llm-openai: provider "${route}" has a model without an id`)
    }
  }
}
