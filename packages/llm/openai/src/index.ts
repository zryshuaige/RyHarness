/**
 * RyAgent OpenAI-compatible LLM adapter.
 *
 * Implements the `@ryagent/llm` {@link LlmAdapter} seam against the
 * `chat/completions` + SSE protocol, with config-driven multi-provider routes,
 * streaming tool calling, usage extraction (including reasoning/cache tokens),
 * and provider-neutral error mapping.
 * @module @ryagent/llm-openai
 */

export { OpenAiAdapter } from './adapter.ts'
export type { OpenAiAdapterConfig, OpenAiProviderConfig } from './config.ts'
export { apply, apply as default } from './plugin.ts'
export { serializeRequest } from './serialize.ts'
export { mapFinishReason, mapUsage, translateChunks } from './translate.ts'
export type { OpenAiChatRequest, OpenAiWireMessage } from './wire.ts'
