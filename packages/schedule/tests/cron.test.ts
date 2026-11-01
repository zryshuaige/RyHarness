/**
 * cron 解析器：五段、星号 / 列表 / 范围 / 步长，以及边界。
 *
 * 这些用例盯的是「算下一次」这件事的每一档：解析对不对、越界报不报、
 * 日与周同时限定时是 OR 还是 AND。
 */
import { describe, expect, it } from 'vitest'
import { nextCronTime, parseCron, ScheduleError } from '../src/index.ts'

/** 某个本地时刻的毫秒数。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** 把算出来的时刻拆成年月日时分，方便断言。 */
function parts(value: number): [number, number, number, number, number] {
  const date = new Date(value)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
}

describe('cron 表达式的解析', () => {
  it('五段各管各的：分 时 日 月 周', () => {
    const spec = parseCron('30 9 15 6 3')
    expect(spec.minutes).toEqual([30])
    expect(spec.hours).toEqual([9])
    expect(spec.daysOfMonth).toEqual([15])
    expect(spec.months).toEqual([6])
    expect(spec.daysOfWeek).toEqual([3])
  })

  it('* 是整段', () => {
    const spec = parseCron('* * * * *')
    expect(spec.minutes).toHaveLength(60)
    expect(spec.hours).toHaveLength(24)
    expect(spec.daysOfMonth).toHaveLength(31)
    expect(spec.months).toHaveLength(12)
    expect(spec.daysOfWeek).toHaveLength(7)
  })

  it('*/n 从最小值开始每隔 n', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('0 */6 * * *').hours).toEqual([0, 6, 12, 18])
  })

  it('列表：逗号拼起来的每一项都要算进去', () => {
    expect(parseCron('1,15,20-30 * * * *').minutes).toEqual([1, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])
  })

  it('范围：a-b 是闭区间', () => {
    expect(parseCron('0 9-11 * * *').hours).toEqual([9, 10, 11])
  })

  it('范围带步长：a-b/n', () => {
    expect(parseCron('0-30/10 * * * *').minutes).toEqual([0, 10, 20, 30])
  })

  it('a/n：从 a 到最大值每隔 n', () => {
    expect(parseCron('50/5 * * * *').minutes).toEqual([50, 55])
  })

  it('星期写 7 也认，归一成周日', () => {
    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual([0])
  })

  it('段数不对就报错，并说清要五段', () => {
    let caught: unknown
    try {
      parseCron('0 9 * *')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ScheduleError)
    if (caught instanceof ScheduleError) {
      expect(caught.code).toBe('INVALID_INPUT')
      expect(caught.message).toContain('五段')
    }
  })

  it('越界的值要报错，并说清范围', () => {
    expect(() => {
      parseCron('99 * * * *')
    }).toThrow(ScheduleError)
    expect(() => {
      parseCron('0 25 * * *')
    }).toThrow(ScheduleError)
    expect(() => {
      parseCron('0 9 32 * *')
    }).toThrow(ScheduleError)
    expect(() => {
      parseCron('0 9 * 13 *')
    }).toThrow(ScheduleError)
    expect(() => {
      parseCron('0 9 * * 8')
    }).toThrow(ScheduleError)
  })

  it('不是数字的字段要报错', () => {
    expect(() => {
      parseCron('abc * * * *')
    }).toThrow(ScheduleError)
  })

  it('步长不合法要报错', () => {
    expect(() => {
      parseCron('*/0 * * * *')
    }).toThrow(ScheduleError)
    expect(() => {
      parseCron('*/x * * * *')
    }).toThrow(ScheduleError)
  })

  it('反着的范围要报错', () => {
    expect(() => {
      parseCron('30-10 * * * *')
    }).toThrow(ScheduleError)
  })

  it('空表达式要报错', () => {
    expect(() => {
      parseCron('   ')
    }).toThrow(ScheduleError)
  })
})

describe('cron 的下一次命中', () => {
  it('每天九点：今天没到就今天，到了就明天', () => {
    const spec = parseCron('0 9 * * *')
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 8, 0)) ?? 0)).toEqual([2026, 3, 10, 9, 0])
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 9, 30)) ?? 0)).toEqual([2026, 3, 11, 9, 0])
  })

  it('严格晚于起算时刻：正好在那一刻不算下一次', () => {
    const spec = parseCron('0 9 * * *')
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 9, 0)) ?? 0)).toEqual([2026, 3, 11, 9, 0])
  })

  it('工作日早上：周一到周五', () => {
    const spec = parseCron('0 9 * * 1-5')
    // 2026-03-10 是周二。
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 8, 0)) ?? 0)).toEqual([2026, 3, 10, 9, 0])
    // 周六（2026-03-14）下一次是下周一。
    expect(parts(nextCronTime(spec, at(2026, 3, 14, 8, 0)) ?? 0)).toEqual([2026, 3, 16, 9, 0])
  })

  it('每 15 分钟：下一次落在整刻上', () => {
    const spec = parseCron('*/15 * * * *')
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 10, 1)) ?? 0)).toEqual([2026, 3, 10, 10, 15])
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 10, 15)) ?? 0)).toEqual([2026, 3, 10, 10, 30])
  })

  it('日与周同时限定时是 OR：命中任一就算那天', () => {
    const spec = parseCron('0 9 15 * 1')
    expect(spec.dayOfMonthRestricted).toBe(true)
    expect(spec.dayOfWeekRestricted).toBe(true)
    // 2026-03-15 是周日：日命中。
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 0, 0)) ?? 0)).toEqual([2026, 3, 15, 9, 0])
    // 2026-03-16 是周一：周命中。
    expect(parts(nextCronTime(spec, at(2026, 3, 15, 9, 30)) ?? 0)).toEqual([2026, 3, 16, 9, 0])
  })

  it('只限日时就是普通的那一天', () => {
    const spec = parseCron('0 9 15 * *')
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 0, 0)) ?? 0)).toEqual([2026, 3, 15, 9, 0])
    expect(parts(nextCronTime(spec, at(2026, 3, 15, 9, 0)) ?? 0)).toEqual([2026, 4, 15, 9, 0])
  })

  it('跨月：三月没命中就落到四月', () => {
    const spec = parseCron('0 9 1 4 *')
    expect(parts(nextCronTime(spec, at(2026, 3, 10, 0, 0)) ?? 0)).toEqual([2026, 4, 1, 9, 0])
  })

  it('往后五年内没有命中时给 undefined，而不是死循环', () => {
    // 2 月 30 日不存在：永远不命中。
    const spec = parseCron('0 9 30 2 *')
    expect(nextCronTime(spec, at(2026, 3, 10, 0, 0))).toBeUndefined()
  })
})
