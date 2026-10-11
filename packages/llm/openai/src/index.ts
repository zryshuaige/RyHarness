/**
 * RyAgent OpenAI-compatible LLM adapter.
 *
 * Implements the `@ryagent/llm` {@link LlmAdapter} seam against the
 * `chat/completions` + SSE protocol, with config-driven multi-provider routes,
 * streaming tool calling, usage extraction (including reasoning/cache tokens),
 * and provider-neutral error mapping.
 * @module @ryagent/llm-openai
 */

export type { OpenAiAdapterConfig, OpenAiModelConfig, OpenAiProviderConfig } from './config.ts'
export { assertProviderConfig } from './config.ts'
export type {
  OpenAiChatRequest,
  OpenAiStreamChunk,
  OpenAiStreamChoice,
  OpenAiWireError,
  OpenAiWireMessage,
  OpenAiWireTool,
  OpenAiWireToolCall,
  OpenAiWireUsage,
} from './wire.ts'
export { serializeRequest, serializeTools } from './serialize.ts'
export { parseSse } from './sse.ts'
export { mapFinishReason, mapUsage, translateChunks } from './translate.ts'
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, MISSING_CREDENTIAL_CODE, OpenAiAdapter } from './adapter.ts'
export { apply, type OpenAiPluginConfig } from './plugin.ts'
export { apply as default } from './plugin.ts'
