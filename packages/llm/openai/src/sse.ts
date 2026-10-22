/**
 * Incremental SSE parser for `chat/completions` streams: byte stream in,
 * `data:` payload strings out (`[DONE]` is consumed here, never yielded).
 * Built on `eventsource-parser`; every decoded chunk counts as wire activity
 * for the idle watchdog.
 * @module @ryharness/llm-openai/sse
 */

import { LlmError } from '@ryharness/llm'
import { createParser } from 'eventsource-parser'

/**
 * Yield each SSE `data` payload in arrival order.
 * @param body - the fetch response byte stream.
 * @param onActivity - invoked per decoded transport chunk (watchdog pulse).
 * @returns an async iterable of raw event payloads.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void = () => {},
): AsyncGenerator<string> {
  let error: unknown
  const queue: string[] = []
  // eventsource-parser is push-based; the parser callback appends to `queue`
  // and the loop below drains it after every feed, which keeps ordering
  // without a heavier pull-based bridge.
  const parser = createParser({
    onEvent: (event) => {
      onActivity()
      if (event.data === '[DONE]') return
      queue.push(event.data)
    },
  })
  const decoder = new TextDecoder()
  try {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        onActivity()
        parser.feed(decoder.decode(value, { stream: true }))
        while (queue.length > 0) yield queue.shift() as string
      }
      parser.feed(decoder.decode())
      while (queue.length > 0) yield queue.shift() as string
    } finally {
      reader.releaseLock()
    }
  } catch (cause) {
    error = cause
  }
  // Surface a transport failure after all queued events; a mid-stream reset
  // must not silently truncate the conversation.
  if (error !== undefined) {
    throw new LlmError('openai: SSE stream transport failed', 'TRANSPORT', { cause: error })
  }
}
