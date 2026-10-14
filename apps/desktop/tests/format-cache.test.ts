/**
 * 时间格式化的 Intl 缓存：会话列表一屏几十行、流式重绘又乘一遍，
 * 每格时间戳都重建一次 Intl.DateTimeFormat 是不该付的成本。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateTimeFormatterCount, formatTime } from '../renderer/src/lib/format.ts'

/** 缓存之前的实现：toLocale* 每次调用都会重新走一遍 ICU 初始化。 */
function legacyFormatTime(ts: number, now: number): string {
  const date = new Date(ts)
  const today = new Date(now)
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const NOW = new Date('2026-10-14T15:30:00').getTime()

describe('formatTime 的 Intl 缓存', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('反复格式化不再新建 Intl.DateTimeFormat（实例数不随调用次数增长）', () => {
    const constructions = vi.spyOn(Intl, 'DateTimeFormat')
    // 两条分支各预热一次（今天的时刻 / 非今天的日期），之后只看是否还在长。
    formatTime(NOW)
    formatTime(NOW - 48 * 3_600_000)
    const afterWarmup = dateTimeFormatterCount()
    const constructedAtWarmup = constructions.mock.calls.length

    for (let i = 0; i < 1000; i++) {
      formatTime(NOW - (i % 400) * 60_000)
      formatTime(NOW - 48 * 3_600_000 - i * 60_000)
    }

    expect(constructions.mock.calls.length).toBe(constructedAtWarmup)
    expect(dateTimeFormatterCount()).toBe(afterWarmup)
    // 今天的时刻与非今天的日期各一个实例，正好两个。
    expect(afterWarmup).toBe(2)
    constructions.mockRestore()
  })

  it('输出与缓存之前的实现逐格相同（今天走时刻、别的日子走日期）', () => {
    const samples = [
      NOW,
      NOW - 5 * 60_000,
      NOW - 26 * 3_600_000, // 昨天同一时刻
      new Date('2026-01-02T08:00:00').getTime(),
      new Date('2025-10-14T00:00:00').getTime(),
    ]
    for (const ts of samples) {
      expect(formatTime(ts)).toBe(legacyFormatTime(ts, NOW))
    }
    // 今天的样本必须是时刻，跨天必须是日期，防止两边实现同时写错还互相印证。
    expect(formatTime(NOW - 60_000)).toMatch(/\d{2}:\d{2}/)
    expect(formatTime(NOW - 48 * 3_600_000)).not.toMatch(/\d{2}:\d{2}/)
  })
})
