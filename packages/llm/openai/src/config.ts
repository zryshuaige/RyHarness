/**
 * Configuration for the RyAgent OpenAI-compatible adapter.
 *
 * One adapter instance owns any number of provider routes; each route is a
 * plain data profile `{ baseURL, apiKeyEnv, models }`, which is what makes the
 * same adapter serve OpenAI, SiliconFlow, or any self-hosted
 * `openai-completions` endpoint without code changes.
 * @module @ryagent/llm-openai/config
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
    throw new Error(`@ryagent/llm-openai: provider "${route}" needs a non-empty baseURL`)
  }
  if ((profile.apiKeyEnv === undefined) === (profile.apiKey === undefined)) {
    throw new Error(`@ryagent/llm-openai: provider "${route}" must set exactly one of apiKeyEnv / apiKey`)
  }
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    throw new Error(`@ryagent/llm-openai: provider "${route}" must declare at least one model`)
  }
  for (const model of profile.models) {
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`@ryagent/llm-openai: provider "${route}" has a model without an id`)
    }
  }
}
