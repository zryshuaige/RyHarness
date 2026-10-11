/**
 * Cordis plugin entry: mount configured OpenAI-compatible routes onto the
 * harness LLM runtime. Exported both as `apply` (cordis apply-function plugin)
 * and as the package default export.
 * @module @ryagent/llm-openai/plugin
 */

import type { Context } from '@ryagent/cordis'
import '@ryagent/llm'
import { OpenAiAdapter } from './adapter.ts'
import type { OpenAiAdapterConfig } from './config.ts'

/** Plugin configuration: the same shape the adapter constructor takes. */
export type OpenAiPluginConfig = OpenAiAdapterConfig

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
  ctx.llm.registerAdapter(routes, adapter)
  ctx.logger.info(`llm-openai: registered ${routes.length} provider route(s): ${routes.join(', ')}`)
}
