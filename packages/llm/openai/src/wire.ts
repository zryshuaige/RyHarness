/**
 * OpenAI `chat/completions` wire types (request, streaming chunk, error).
 * Only the fields the adapter reads are declared; the protocol tolerates more.
 * @module @ryagent/llm-openai/wire
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
  stream_options?: { include_usage: boolean }
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
  usage?: OpenAiWireUsage
}

/** Error document shape returned with non-2xx responses. */
export interface OpenAiWireError {
  error?: {
    message?: string
    type?: string
    code?: string | number
  }
}
