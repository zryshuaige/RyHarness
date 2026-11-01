/**
 * cron 表达式：自己写的五段解析器（分 时 日 月 周）。
 *
 * 为什么自己写：这一族只需要「五段 + 星号 / 列表 / 范围 / 步长」这一档，
 * 引一个外部依赖换来的是一大坨用不上的功能（秒段、@yearly、L/W/# 等），
 * 还得在装依赖时多担一份风险。自己写两百行，边界全在眼前，测得到。
 *
 * 支持的写法：
 * - 星号：全段；
 * - 星号加斜杠加 n（步长）：从最小值开始每隔 n（例：每 15 分钟 = 0,15,30,45）；
 * - a：单个值；
 * - a-b：闭区间；
 * - a-b/n：闭区间里每隔 n；
 * - a/n：从 a 到最大值每隔 n；
 * - 上面这些用逗号拼起来的列表（`1,15,20-30`）。
 *
 * 语义按标准 cron：**日**与**周**同时被限定时（都不是星号），任一匹配就算那天命中
 * （传统 cron 的 OR 规则）。这一条容易记错，所以单独立一条用例盯着。
 * @module @ryharness/schedule/cron
 */

import { ScheduleError } from './types.ts'

/** 解析出来的一份 cron 计划：每一段命中哪些值。 */
export interface CronSpec {
  /** 命中的分钟（0-59）。 */
  readonly minutes: readonly number[]
  /** 命中的小时（0-23）。 */
  readonly hours: readonly number[]
  /** 命中的日（1-31）。 */
  readonly daysOfMonth: readonly number[]
  /** 命中的月（1-12）。 */
  readonly months: readonly number[]
  /** 命中的星期（0-6，0 是周日）。 */
  readonly daysOfWeek: readonly number[]
  /** 日这一段是不是被限定过（不是 `*`）。 */
  readonly dayOfMonthRestricted: boolean
  /** 周这一段是不是被限定过（不是 `*`）。 */
  readonly dayOfWeekRestricted: boolean
}

/** 一段 cron 字段的范围。 */
interface FieldRange {
  /** 字段名（报错时用）。 */
  readonly name: string
  /** 最小值。 */
  readonly min: number
  /** 最大值。 */
  readonly max: number
}

/** 五段的字段顺序与范围。 */
const FIELDS: readonly FieldRange[] = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 6 },
]

/** 往后找下一次命中时，最多看多少年（够覆盖「2 月 29 日」这类稀疏计划）。 */
const HORIZON_YEARS = 5

/**
 * 解析一条五段 cron 表达式。
 * @param expression - 表达式，例如 `0 9 * * 1-5`。
 * @returns 解析出来的计划。
 * @throws ScheduleError - 段数不对或字段不合法时抛（码 `INVALID_INPUT`）。
 */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim()
  if (trimmed.length === 0) {
    throw new ScheduleError('INVALID_INPUT', 'cron 表达式是空的。')
  }
  const parts = trimmed.split(/\s+/u)
  if (parts.length !== FIELDS.length) {
    throw new ScheduleError(
      'INVALID_INPUT',
      `cron 表达式要五段（分 时 日 月 周），收到 ${parts.length} 段：「${trimmed}」。`,
    )
  }
  // 段数已经核对过，这里逐段解析不会越界。
  const [minuteText = '', hourText = '', dayText = '', monthText = '', weekText = ''] = parts
  const minutes = parseField(minuteText, FIELDS[0])
  const hours = parseField(hourText, FIELDS[1])
  const daysOfMonth = parseField(dayText, FIELDS[2])
  const months = parseField(monthText, FIELDS[3])
  const daysOfWeek = parseField(weekText, FIELDS[4])
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayText !== '*',
    dayOfWeekRestricted: weekText !== '*',
  }
}

/**
 * 解析一段字段。
 * @param part - 字段文本。
 * @param field - 这一段的取值范围。
 * @returns 命中的值（升序、去重）。
 */
function parseField(part: string, field: FieldRange): number[] {
  const hits = new Set<number>()
  for (const piece of part.split(',')) {
    const trimmed = piece.trim()
    if (trimmed.length === 0) {
      throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段里有空的项：「${part}」。`)
    }
    const slash = trimmed.indexOf('/')
    if (slash < 0) {
      for (const value of parseRange(trimmed, field)) hits.add(value)
      continue
    }
    const base = trimmed.slice(0, slash).trim()
    const stepText = trimmed.slice(slash + 1).trim()
    const step = Number.parseInt(stepText, 10)
    if (!Number.isInteger(step) || step <= 0 || stepText !== String(step)) {
      throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段里步长不合法：「${stepText}」。`)
    }
    const [from, to] = parseBounds(base, field)
    if (from > to) {
      throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段范围是反的：「${trimmed}」。`)
    }
    for (let value = from; value <= to; value += step) hits.add(value)
  }
  const out = [...hits].sort((a, b) => {
    return a - b
  })
  return out
}

/**
 * 一段字段的起止值。
 *
 * 三种基座：星号（整段）、单值（到最大值为止）、范围（闭区间）。
 * @param base - 基座文本。
 * @param field - 这一段的取值范围。
 * @returns 起值与止值。
 */
function parseBounds(base: string, field: FieldRange): [number, number] {
  if (base === '*') return [field.min, field.max]
  if (!base.includes('-')) return [parseSingle(base, field), field.max]
  const [leftText, rightText] = base.split('-', 2)
  const left = leftText === undefined ? '' : leftText.trim()
  const right = rightText === undefined ? '' : rightText.trim()
  const from = parseSingle(left, field)
  const to = parseSingle(right, field)
  if (from > to) {
    throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段范围是反的：「${base}」。`)
  }
  return [from, to]
}

/** 解析一段没有步长的字段（`*` / `a` / `a-b`）。 */
function parseRange(part: string, field: FieldRange): number[] {
  if (part === '*') {
    const out: number[] = []
    for (let value = field.min; value <= field.max; value++) out.push(value)
    return out
  }
  if (!part.includes('-')) {
    return [parseSingle(part, field)]
  }
  const [leftText, rightText] = part.split('-', 2)
  const left = leftText === undefined ? '' : leftText.trim()
  const right = rightText === undefined ? '' : rightText.trim()
  const from = parseSingle(left, field)
  const to = parseSingle(right, field)
  if (from > to) {
    throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段范围是反的：「${part}」。`)
  }
  const out: number[] = []
  for (let value = from; value <= to; value++) out.push(value)
  return out
}

/** 解析一个单个值（含星期 7 → 0 的归一）。 */
function parseSingle(part: string, field: FieldRange): number {
  const text = part.trim()
  const value = Number.parseInt(text, 10)
  if (!Number.isInteger(value) || text !== String(value)) {
    throw new ScheduleError('INVALID_INPUT', `cron 的「${field.name}」这一段里「${part}」不是数字。`)
  }
  // 星期允许写 7（很多 cron 这么写），归一成 0。
  if (field.name === '星期' && value === 7) return 0
  if (value < field.min || value > field.max) {
    throw new ScheduleError(
      'INVALID_INPUT',
      `cron 的「${field.name}」这一段里 ${value} 越界了（${field.min}-${field.max}）：「${part}」。`,
    )
  }
  return value
}

/**
 * 找下一次命中的时刻（严格晚于 `from`）。
 *
 * 走的是「天 → 时 → 分」三层：先按天扫，命中那天再在当天里找钟点。
 * 直接按分钟扫的话，「每年 2 月 29 日」这种计划要扫几万个空分钟。
 * @param spec - 解析出来的计划。
 * @param from - 起算时刻（Unix 毫秒）。
 * @returns 下一次命中的时刻（Unix 毫秒）；往后五年内没有命中时 undefined。
 */
export function nextCronTime(spec: CronSpec, from: number): number | undefined {
  const start = new Date(from)
  // 先把秒与毫秒抹掉，再往上一分钟走：cron 只精确到分钟，「严格晚于」按分钟算。
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const limitYear = start.getFullYear() + HORIZON_YEARS
  while (cursor.getFullYear() <= limitYear) {
    if (!matchesDate(spec, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      continue
    }
    const hit = firstTimeOnDay(spec, cursor, start)
    if (hit !== undefined) return hit
    cursor.setDate(cursor.getDate() + 1)
  }
  return undefined
}

/** 这一天是不是命中（日与周的 OR 规则）。 */
function matchesDate(spec: CronSpec, day: Date): boolean {
  if (!spec.months.includes(day.getMonth() + 1)) return false
  const domHit = spec.daysOfMonth.includes(day.getDate())
  const dowHit = spec.daysOfWeek.includes(day.getDay())
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return domHit || dowHit
  if (spec.dayOfMonthRestricted) return domHit
  if (spec.dayOfWeekRestricted) return dowHit
  return true
}

/** 这一天里第一个命中的钟点（不早于 `start`）。 */
function firstTimeOnDay(spec: CronSpec, day: Date, start: Date): number | undefined {
  const sameDay =
    day.getFullYear() === start.getFullYear() &&
    day.getMonth() === start.getMonth() &&
    day.getDate() === start.getDate()
  for (const hour of spec.hours) {
    if (sameDay && hour < start.getHours()) continue
    for (const minute of spec.minutes) {
      if (sameDay && hour === start.getHours() && minute < start.getMinutes()) continue
      const hit = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0)
      return hit.getTime()
    }
  }
  return undefined
}

/**
 * 这条 cron 是不是还命中得起来（往后五年内有下一次）。
 *
 * 用在「这条计划永远不会响」的时候提前报错：建一条永远不响的提醒等于白建。
 * @param spec - 解析出来的计划。
 * @param from - 起算时刻（Unix 毫秒）。
 * @returns 有下一次命中返回 true。
 */
export function cronHasFuture(spec: CronSpec, from: number): boolean {
  return nextCronTime(spec, from) !== undefined
}
