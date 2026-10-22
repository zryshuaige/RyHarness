/**
 * Retry executor for resolved provider retry policies.
 *
 * `LlmRuntime.stream()` runs every adapter dispatch through `streamWithRetry`:
 * when an attempt ends in a terminal `error` finish with a retryable code AND
 * the attempt delivered no content chunks, the whole dispatch is repeated
 * after a bounded exponential-backoff delay with symmetric jitter, honoring
 * the provider's `Retry-After` (`failure.providerRetryAfterMs`) when present.
 *
 * Retry safety rule: an attempt that already delivered content (any
 * block-start/delta/block-end chunk) is never repeated — repeating it would
 * duplicate content the consumer already saw. Usage chunks of a failed
 * attempt are discarded so only the surviving attempt reports usage.
 *
 * @module @ryharness/llm/retry-stream
 */

import { QUOTA_EXCEEDED_CODE } from './error.ts'
import type { ResolvedRetryPolicy } from './retry-policy.ts'
import type { LlmFailure, StreamChunk } from './types.ts'

/** Provider-requested delays are honored up to this cap (a stalled chat turn must not sleep for minutes). */
const MAX_PROVIDER_DELAY_MS = 60_000

/** Chunks that carry response content; delivering any of them makes the attempt unrepeatable. */
function isContentChunk(chunk: StreamChunk): boolean {
  return (
    chunk.type === 'block-start' ||
    chunk.type === 'text-delta' ||
    chunk.type === 'reasoning-delta' ||
    chunk.type === 'tool-call-delta' ||
    chunk.type === 'block-end'
  )
}

/**
 * Whether one terminal failure may be repeated under the policy. `always`
 * mode repeats everything; `normal` mode repeats its configured codes, plus
 * quota failures that carry a provider-requested delay (a quota window that
 * resets is transient; one without `Retry-After` is terminal).
 */
function isRetryableFailure(policy: ResolvedRetryPolicy, failure: LlmFailure): boolean {
  if (policy.mode === 'always') return true
  if (policy.retryableCodes.includes(failure.code)) return true
  return failure.code === QUOTA_EXCEEDED_CODE && failure.providerRetryAfterMs !== undefined
}

/**
 * Delay before retry attempt `attempt` (1-based): the provider-requested
 * delay when offered (capped), otherwise exponential backoff with symmetric
 * jitter around `initialDelayMs * 2^(attempt-1)`, bounded by `maxDelayMs`.
 */
function retryDelayMs(policy: ResolvedRetryPolicy, failure: LlmFailure, attempt: number): number {
  if (failure.providerRetryAfterMs !== undefined) {
    return Math.min(failure.providerRetryAfterMs, MAX_PROVIDER_DELAY_MS)
  }
  const base = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  const jitter = base * policy.jitterRatio
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * jitter))
}

/** Sleep that resolves `true` early when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, ms)
    const onAbort = (): void => {
      cleanup()
      resolve(true)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Stream one model call, repeating the dispatch under the retry policy.
 * @param policy - the resolved retry policy of the owning provider route.
 * @param open - starts one fresh dispatch attempt.
 * @param signal - caller cancellation; aborting stops retries immediately.
 * @returns the surviving attempt's chunk stream, or the last failure as a
 *   terminal `error` (or `aborted`) finish once retries are exhausted.
 */
export async function* streamWithRetry(
  policy: ResolvedRetryPolicy,
  open: () => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  let attempt = 0
  for (;;) {
    let contentDelivered = false
    let pendingUsage: StreamChunk[] = []
    let failure: LlmFailure | undefined
    for await (const chunk of open()) {
      // Hold back pre-content usage: a retried attempt's usage must not stack.
      if (chunk.type === 'usage' && !contentDelivered) {
        pendingUsage.push(chunk)
        continue
      }
      if (
        !contentDelivered &&
        chunk.type === 'finish' &&
        chunk.reason.kind === 'error' &&
        signal?.aborted !== true &&
        isRetryableFailure(policy, chunk.reason.failure)
      ) {
        failure = chunk.reason.failure
        break
      }
      if (isContentChunk(chunk)) contentDelivered = true
      for (const held of pendingUsage) yield held
      pendingUsage = []
      yield chunk
    }
    if (failure === undefined) return
    if (policy.mode === 'normal' && attempt >= policy.maxRetries) {
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    attempt++
    if (await sleep(retryDelayMs(policy, failure, attempt), signal)) {
      yield { type: 'finish', reason: { kind: 'aborted', failure } }
      return
    }
  }
}
