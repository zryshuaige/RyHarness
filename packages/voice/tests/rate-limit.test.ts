/**
 * 节流：同音色最小间隔、全局在途上限、窗口过后恢复。
 *
 * 时钟是注入的，所以这些断言量的是"闸门的判定"，不是墙钟——测试不必真等 1.5 秒。
 */
import { describe, expect, it } from 'vitest'
import { createVoiceRateLimiter, DEFAULT_MAX_CONCURRENT, DEFAULT_MIN_INTERVAL_MS } from '../src/rate-limit.ts'

/** 可手动推进的时钟。 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

describe('同音色最小间隔', () => {
  it('窗口内的第二次被挡下，并给出还要等多久', () => {
    const clock = fakeClock()
    const limiter = createVoiceRateLimiter({ minIntervalMs: 1000, now: clock.now })
    expect(limiter.acquire('a')).toEqual({ ok: true })
    limiter.release()
    clock.advance(400)
    const blocked = limiter.acquire('a')
    expect(blocked.ok).toBe(false)
    expect(blocked.ok === false && blocked.reason).toBe('throttled')
    expect(blocked.ok === false && blocked.reason === 'throttled' ? blocked.retryAfterMs : 0).toBe(600)
  })

  it('窗口过后恢复：下一次直接放行', () => {
    const clock = fakeClock()
    const limiter = createVoiceRateLimiter({ minIntervalMs: 1000, now: clock.now })
    expect(limiter.acquire('a')).toEqual({ ok: true })
    limiter.release()
    clock.advance(1000)
    expect(limiter.acquire('a')).toEqual({ ok: true })
  })

  it('被挡下的那次不推迟这条音色的下一次（否则等于惩罚已经等了的人）', () => {
    const clock = fakeClock()
    const limiter = createVoiceRateLimiter({ minIntervalMs: 1000, now: clock.now })
    limiter.acquire('a')
    limiter.release()
    // 窗口内连点三次，全都应被挡下，但都不该把可用时刻往后推。
    for (let i = 0; i < 3; i++) {
      clock.advance(100)
      expect(limiter.acquire('a').ok).toBe(false)
    }
    clock.advance(700) // 距上一次**放行**已满 1000ms（被挡下的三次不计）
    expect(limiter.acquire('a')).toEqual({ ok: true })
  })

  it('间隔按音色各算各的（换一个音色不受牵连）', () => {
    const clock = fakeClock()
    const limiter = createVoiceRateLimiter({ minIntervalMs: 1000, now: clock.now })
    expect(limiter.acquire('a')).toEqual({ ok: true })
    limiter.release()
    expect(limiter.acquire('b')).toEqual({ ok: true })
    limiter.release()
    expect(limiter.acquire('a').ok).toBe(false)
  })

  it('minIntervalMs=0 时不限间隔', () => {
    const limiter = createVoiceRateLimiter({ minIntervalMs: 0 })
    for (let i = 0; i < 5; i++) {
      expect(limiter.acquire('a')).toEqual({ ok: true })
      limiter.release()
    }
  })
})

describe('全局在途上限', () => {
  it('超过上限时给出 busy（与"太密"是不同的原因，UI 的说法也不一样）', () => {
    const limiter = createVoiceRateLimiter({ minIntervalMs: 0, maxConcurrent: 2 })
    expect(limiter.acquire('a')).toEqual({ ok: true })
    expect(limiter.acquire('b')).toEqual({ ok: true })
    const third = limiter.acquire('c')
    expect(third.ok).toBe(false)
    expect(third.ok === false && third.reason).toBe('busy')
  })

  it('release 归还槽位；多余的 release 不会把计数带成负数', () => {
    const limiter = createVoiceRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 })
    limiter.acquire('a')
    limiter.release()
    expect(limiter.acquire('b')).toEqual({ ok: true })
    limiter.release()
    limiter.release()
    limiter.release()
    expect(limiter.acquire('c')).toEqual({ ok: true })
  })

  it('默认上限是个有限的数（不是"不限制"——合成是按字符计费的云端往返）', () => {
    const limiter = createVoiceRateLimiter({ minIntervalMs: 0 })
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT; i++) {
      expect(limiter.acquire(`p${i}`)).toEqual({ ok: true })
    }
    expect(limiter.acquire('overflow').ok).toBe(false)
  })

  it('默认同音色间隔是个有限的数', () => {
    expect(DEFAULT_MIN_INTERVAL_MS).toBeGreaterThan(0)
    const limiter = createVoiceRateLimiter()
    expect(limiter.acquire('a')).toEqual({ ok: true })
    limiter.release()
    expect(limiter.acquire('a').ok).toBe(false)
  })
})
