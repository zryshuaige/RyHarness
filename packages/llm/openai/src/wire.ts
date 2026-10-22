/**
 * OpenAI `chat/completions` wire types (request, streaming chunk, error).
 * Only the fields the adapter reads are declared; the protocol tolerates more.
 * @module @ryharness/llm-openai/wire
 */

/** One message in the OpenAI chat wire format. */
export interface OpenAiWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_calls?: OpenAiWireToolCall[]
  tool_call_id?: string
}

/** A completed tool call on an assistant message. */
export interface OpenAiWireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** Raw JSON string, exactly as the model produced it. */
    arguments: string
  }
}

/** One function tool declaration. */
export interface OpenAiWireTool {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>
  }
}

/** Request body for `POST {baseURL}/chat/completions`. */
export interface OpenAiChatRequest {
  model: string
  messages: OpenAiWireMessage[]
  tools?: OpenAiWireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
  stream: true
  /** Ask endpoints that support it to emit a final usage chunk. */
  stream_options?: { include_usage: true }
  /**
   * 思考强度。OpenAI 兼容协议的事实标准字段名（OpenAI / Kimi / GLM / MiniMax 都用它），
   * 取值逐模型不同——见 `LlmModelReasoningInfo.efforts`。
   */
  reasoning_effort?: string
  /**
   * 思考开关，非 OpenAI 标准但被多家采用（MiniMax / Kimi / GLM）。
   *
   * 两家对这个字段的接受度不一样，所以只在用户**显式选了档位**时才发 `reasoning_effort`，
   * 而 `thinking` 只在适配器明确知道该路由认这个字段时才发——凭空猜一个字段发出去，
   * 换来的是一片 400。
   */
  thinking?: { type: 'enabled' | 'disabled' | 'adaptive' }
}

/** Per-token usage accounting, present on the terminal chunk when requested. */
export interface OpenAiWireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cache_read_tokens?: number
    cache_creation_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

/** One entry of `choices` in a streaming chunk. */
export interface OpenAiStreamChoice {
  index: number
  delta: {
    role?: 'assistant'
    content?: string | null
    /** DeepSeek/思考型模型的推理增量，与可见 content 分通道到达。 */
    reasoning_content?: string | null
    tool_calls?: {
      /** Position in the request's parallel tool-call array; present on every entry. */
      index: number
      /** Present only on the first chunk of one tool call. */
      id?: string
      type?: 'function'
      function?: {
        /** Present only on the first chunk of one tool call. */
        name?: string
        /** Incremental raw JSON fragment. */
        arguments?: string
      }
    }[]
  }
  /** Present only on the chunk that ends the stream. */
  finish_reason?: string | null
}

/** One SSE `chat.completion.chunk` event payload. */
export interface OpenAiStreamChunk {
  id?: string
  created?: number
  model?: string
  choices: OpenAiStreamChoice[]
  /**
   * Per the OpenAI spec this is `null` on every non-terminal chunk even when
   * `include_usage` is set; DeepSeek follows that literally.
   */
  usage?: OpenAiWireUsage | null
}

/** Error document shape returned with non-2xx responses. */
export interface OpenAiWireError {
  error?: {
    message?: string
    type?: string
    code?: string | number
  }
}
