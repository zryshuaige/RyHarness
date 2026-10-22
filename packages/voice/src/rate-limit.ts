/**
 * 合成节流：同一音色两次之间的最小间隔 + 全局在途上限。
 *
 * 为什么要有：朗读是"点一下就想立刻听到"的交互，一次合成又是按字符计费的云端
 * 调用。少了这道闸，连点五下就会同时发五个几乎一样的请求——用户听到的是叠在一起的
 * 五个声音，账单上也是五笔。
 * @module @ryharness/voice/rate-limit
 */

/** 默认的同音色最小间隔（毫秒）。低于这个间隔连发，人耳听到的是叠音而不是"更快"。 */
export const DEFAULT_MIN_INTERVAL_MS = 1_500

/** 默认的全局在途上限。合成是网络往返，压着并发只会让每个人都更慢。 */
export const DEFAULT_MAX_CONCURRENT = 4

/** 节流器配置。时钟可注入，测试因此不必真等。 */
export interface RateLimitOptions {
  /** 同一音色两次合成之间的最小间隔毫秒；0 = 不限。 */
  minIntervalMs?: number
  /** 全局同时在途的合成数上限；<= 0 表示不限。 */
  maxConcurrent?: number
  /** 时钟（毫秒）。默认 `Date.now`。 */
  now?: () => number
}

/** 一次 acquire 的结论。 */
export type RateLimitVerdict =
  | { ok: true }
  | { ok: false; reason: 'throttled'; retryAfterMs: number }
  | { ok: false; reason: 'busy' }

/** 节流器。用完一次合成必须 {@link VoiceRateLimiter.release}，否则并发槽会漏。 */
export interface VoiceRateLimiter {
  /** 登记一次合成；被挡下时给出原因与还要等多久。 */
  acquire(profileId: string): RateLimitVerdict
  /** 归还并发槽（成功、失败都要还）。 */
  release(): void
}

/**
 * 造一个节流器。
 *
 * 记时刻而不是记"上一次是否放行"：并发的两次请求在各自的 acquire 里读同一个
 * 窗口，只有被挡下的那次不占槽也不推迟下一次——否则一次被拒的连点会把这条音色的
 * 下次可用时刻推后，等于惩罚已经等了的人。
 */
export function createVoiceRateLimiter(options: RateLimitOptions = {}): VoiceRateLimiter {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const now = options.now ?? Date.now
  const lastGrantedAt = new Map<string, number>()
  let inFlight = 0

  return {
    acquire(profileId: string): RateLimitVerdict {
      if (maxConcurrent > 0 && inFlight >= maxConcurrent) return { ok: false, reason: 'busy' }
      const at = now()
      const previous = lastGrantedAt.get(profileId)
      if (minIntervalMs > 0 && previous !== undefined && at - previous < minIntervalMs) {
        return { ok: false, reason: 'throttled', retryAfterMs: minIntervalMs - (at - previous) }
      }
      lastGrantedAt.set(profileId, at)
      inFlight += 1
      return { ok: true }
    },
    release(): void {
      inFlight = Math.max(0, inFlight - 1)
    },
  }
}
