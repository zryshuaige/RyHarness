/**
 * 五种触发方式各自怎么算下一次。
 *
 * 这些用例盯的是「提醒到底什么时候响」：一次性、固定间隔、每日、每周、cron，
 * 每一档的边界都钉住。间隔那一档尤其要盯对齐——提醒不能越响越晚。
 */
import { describe, expect, it } from 'vitest'
import {
  computeNextRun,
  nextDailyTime,
  nextIntervalTime,
  nextWeeklyTime,
  parseTimeOfDay,
  ScheduleError,
  weekdayName,
} from '../src/index.ts'

/** 某个本地时刻的毫秒数。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** 把算出来的时刻拆成年月日时分。 */
function parts(value: number): [number, number, number, number, number] {
  const date = new Date(value)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
}

describe('钟点的解析', () => {
  it('HH:MM 认得', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hour: 9, minute: 30 })
    expect(parseTimeOfDay('9:30')).toEqual({ hour: 9, minute: 30 })
    expect(parseTimeOfDay('00:00')).toEqual({ hour: 0, minute: 0 })
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 })
  })

  it('不认的写法要报错', () => {
    expect(() => {
      parseTimeOfDay('上午九点')
    }).toThrow(ScheduleError)
    expect(() => {
      parseTimeOfDay('9')
    }).toThrow(ScheduleError)
    expect(() => {
      parseTimeOfDay('9:3')
    }).toThrow(ScheduleError)
  })

  it('越界的钟点要报错', () => {
    expect(() => {
      parseTimeOfDay('24:00')
    }).toThrow(ScheduleError)
    expect(() => {
      parseTimeOfDay('12:60')
    }).toThrow(ScheduleError)
  })
})

describe('每日与每周', () => {
  it('每日：今天还没到就今天', () => {
    const time = parseTimeOfDay('09:00')
    expect(parts(nextDailyTime(time, at(2026, 3, 10, 8, 0)) ?? 0)).toEqual([2026, 3, 10, 9, 0])
  })

  it('每日：今天已经过了就明天', () => {
    const time = parseTimeOfDay('09:00')
    expect(parts(nextDailyTime(time, at(2026, 3, 10, 9, 30)) ?? 0)).toEqual([2026, 3, 11, 9, 0])
  })

  it('每周：指定星期几的那一天', () => {
    const time = parseTimeOfDay('08:30')
    // 2026-03-10 是周二，星期几用 2 表示。
    expect(parts(nextWeeklyTime(2, time, at(2026, 3, 10, 7, 0)) ?? 0)).toEqual([2026, 3, 10, 8, 30])
    // 要下周二。
    expect(parts(nextWeeklyTime(2, time, at(2026, 3, 10, 9, 0)) ?? 0)).toEqual([2026, 3, 17, 8, 30])
  })

  it('每周：星期几越界要报错', () => {
    expect(() => {
      nextWeeklyTime(7, parseTimeOfDay('09:00'), at(2026, 3, 10, 0, 0))
    }).toThrow(ScheduleError)
  })

  it('星期几的中文名', () => {
    expect(weekdayName(0)).toBe('周日')
    expect(weekdayName(6)).toBe('周六')
  })
})

describe('固定间隔', () => {
  it('对齐到建立时刻：第一次是建立后一个整间隔', () => {
    const anchor = at(2026, 3, 10, 10, 0)
    expect(parts(nextIntervalTime(anchor, 30 * 60_000, anchor) ?? 0)).toEqual([2026, 3, 10, 10, 30])
  })

  it('不会越响越晚：十分钟后仍然是半点', () => {
    const anchor = at(2026, 3, 10, 10, 0)
    expect(parts(nextIntervalTime(anchor, 30 * 60_000, at(2026, 3, 10, 10, 7)) ?? 0)).toEqual([2026, 3, 10, 10, 30])
  })

  it('跳过已经过去的那些次，直接排到将来', () => {
    const anchor = at(2026, 3, 10, 10, 0)
    expect(parts(nextIntervalTime(anchor, 30 * 60_000, at(2026, 3, 10, 12, 5)) ?? 0)).toEqual([2026, 3, 10, 12, 30])
  })

  it('间隔不合法要报错', () => {
    expect(() => {
      nextIntervalTime(at(2026, 3, 10, 10, 0), 0, at(2026, 3, 10, 10, 0))
    }).toThrow(ScheduleError)
    expect(() => {
      nextIntervalTime(at(2026, 3, 10, 10, 0), -1, at(2026, 3, 10, 10, 0))
    }).toThrow(ScheduleError)
  })
})

describe('五种触发方式的下一次', () => {
  it('一次性：还没到就排到那一刻', () => {
    const at1 = at(2026, 3, 10, 15, 0)
    expect(computeNextRun({ kind: 'once', at: at1 }, at(2026, 3, 10, 10, 0))).toBe(at1)
  })

  it('一次性：过了就没有下一次', () => {
    const at1 = at(2026, 3, 10, 15, 0)
    expect(computeNextRun({ kind: 'once', at: at1 }, at(2026, 3, 10, 16, 0))).toBeUndefined()
  })

  it('固定间隔：按间隔算', () => {
    const anchor = at(2026, 3, 10, 10, 0)
    const next = computeNextRun({ kind: 'interval', everyMs: 60_000 }, at(2026, 3, 10, 10, 0), anchor)
    expect(parts(next ?? 0)).toEqual([2026, 3, 10, 10, 1])
  })

  it('每日：按钟点算', () => {
    const next = computeNextRun({ kind: 'daily', time: '09:00' }, at(2026, 3, 10, 8, 0))
    expect(parts(next ?? 0)).toEqual([2026, 3, 10, 9, 0])
  })

  it('每周：按星期与钟点算', () => {
    const next = computeNextRun({ kind: 'weekly', weekday: 3, time: '08:00' }, at(2026, 3, 10, 0, 0))
    expect(parts(next ?? 0)).toEqual([2026, 3, 11, 8, 0])
  })

  it('cron：按表达式算', () => {
    const next = computeNextRun({ kind: 'cron', expression: '0 9 * * 1-5' }, at(2026, 3, 14, 8, 0))
    expect(parts(next ?? 0)).toEqual([2026, 3, 16, 9, 0])
  })

  it('cron 表达式不合法时报错', () => {
    expect(() => {
      computeNextRun({ kind: 'cron', expression: '不合法' }, at(2026, 3, 10, 0, 0))
    }).toThrow(ScheduleError)
  })
})
