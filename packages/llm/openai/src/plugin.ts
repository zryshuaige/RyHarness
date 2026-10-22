/**
 * Cordis plugin entry: mount configured OpenAI-compatible routes onto the
 * harness LLM runtime. Exported both as `apply` (cordis apply-function plugin)
 * and as the package default export.
 *
 * The host may hand back the registration handle: the desktop app keeps one
 * adapter instance for the whole process and hot-swaps its route set when the
 * user adds or removes a provider. Registering a second adapter for the same
 * routes would fail with `DUPLICATE_ADAPTER`, so the handle is the only way to
 * stay on the plugin path for the initial mount and still support hot edits.
 * @module @ryharness/llm-openai/plugin
 */

import type { Context } from '@ryharness/cordis'
import type { AdapterRegistrationHandle } from '@ryharness/llm'
import '@ryharness/llm'
import { OpenAiAdapter } from './adapter.ts'
import type { OpenAiAdapterConfig } from './config.ts'

/** Plugin configuration: adapter options plus the optional registration handle sink. */
export type OpenAiPluginConfig = OpenAiAdapterConfig & {
  /** Called once when routes were registered (never for a dormant mount). */
  onRegistered?: (handle: AdapterRegistrationHandle) => void
}

/**
 * Register every configured provider route with `ctx.llm`.
 *
 * Runs against whatever `llm` service the context already holds; with zero
 * routes it mounts dormant (nothing registered) instead of throwing, matching
 * the upstream dormancy convention for unconfigured adapters.
 * @param ctx - the cordis context holding `ctx.llm`.
 * @param config - adapter configuration with one profile per provider route.
 */
export function apply(ctx: Context, config: OpenAiPluginConfig): void {
  const providers = config.providers ?? {}
  const routes = Object.keys(providers)
  if (routes.length === 0) {
    ctx.logger.info('llm-openai: no providers configured; mounting dormant')
    return
  }
  const adapter = new OpenAiAdapter(config)
  // The registration is owned by this plugin's fiber, so unloading the plugin
  // releases the routes. The handle outlives the call for hot route swaps.
  const handle = ctx.llm.registerAdapter(routes, adapter)
  config.onRegistered?.(handle)
  ctx.logger.info(`llm-openai: registered ${routes.length} provider route(s): ${routes.join(', ')}`)
}
