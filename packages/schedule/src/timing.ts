/**
 * 触发时间怎么算：五种触发方式各自的「下一次什么时候响」。
 *
 * 这一层是纯计算，不碰存储也不碰投递。它要回答的问题只有一个：
 * **给定一条提醒与一个时刻，下一次响是什么时候。**
 *
 * 两种时间基准要分清：
 * - **钟点类**（每日 / 每周 / cron）按**本地时间**算——「每天 9 点」就是每天早上九点，
 *   跨夏令时也跟着钟点走；
 * - **间隔类**（固定间隔）按**建立时刻对齐**算——每 30 分钟一次就是建立后的每个整半小时，
 *   不会因为某一次投递晚了就整体漂移。
 * @module @ryharness/schedule/timing
 */

import { type CronSpec, nextCronTime, parseCron } from './cron.ts'
import { ScheduleError, type ScheduleTrigger } from './types.ts'

/** 一天的某个钟点。 */
export interface TimeOfDay {
  /** 小时（0-23）。 */
  readonly hour: number
  /** 分钟（0-59）。 */
  readonly minute: number
}

/**
 * 解析 `HH:MM` 这样的钟点。
 *
 * 只认「小时:分钟」这一种写法，不认「上午九点」「9点半」——时刻是给人看的，
 * 机器解析的部分越少，歧义越少。
 * @param text - 钟点文本，例如 `09:30`。
 * @returns 解析出来的钟点。
 * @throws ScheduleError - 格式不对时抛（码 `INVALID_INPUT`）。
 */
export function parseTimeOfDay(text: string): TimeOfDay {
  const trimmed = text.trim()
  const match = /^(\d{1,2}):(\d{2})$/u.exec(trimmed)
  if (match === null) {
    throw new ScheduleError('INVALID_INPUT', `钟点要写成 HH:MM（收到「${text}」）。`)
  }
  const hourText = match[1] ?? ''
  const minuteText = match[2] ?? ''
  const hour = Number.parseInt(hourText, 10)
  const minute = Number.parseInt(minuteText, 10)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new ScheduleError('INVALID_INPUT', `钟点不是数字：「${text}」。`)
  }
  if (hour < 0 || hour > 23) {
    throw new ScheduleError('INVALID_INPUT', `钟点的小时要落在 0-23（收到 ${hour}）。`)
  }
  if (minute < 0 || minute > 59) {
    throw new ScheduleError('INVALID_INPUT', `钟点的分钟要落在 0-59（收到 ${minute}）。`)
  }
  return { hour, minute }
}

/**
 * 把钟点渲染成 `HH:MM`。
 * @param time - 钟点。
 * @returns 两位数的小时与分钟。
 */
export function formatTimeOfDay(time: TimeOfDay): string {
  const hour = String(time.hour).padStart(2, '0')
  const minute = String(time.minute).padStart(2, '0')
  return `${hour}:${minute}`
}

/**
 * 下一次「每天这个钟点」的时刻（严格晚于 `from`）。
 * @param time - 钟点。
 * @param from - 起算时刻（Unix 毫秒）。
 * @returns 下一次命中的时刻（Unix 毫秒）。
 */
export function nextDailyTime(time: TimeOfDay, from: number): number {
  const base = new Date(from)
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.hour, time.minute, 0, 0)
  if (candidate.getTime() > from) return candidate.getTime()
  const tomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, time.hour, time.minute, 0, 0)
  return tomorrow.getTime()
}

/**
 * 下一次「每周这天的这个钟点」的时刻（严格晚于 `from`）。
 *
 * 算的是「往后推几天才到目标星期几」，不是逐天试：本周这个钟点已经过了，
 * 就落到下周同一钟点。
 * @param weekday - 星期几（0 是周日，6 是周六）。
 * @param time - 钟点。
 * @param from - 起算时刻（Unix 毫秒）。
 * @returns 下一次命中的时刻（Unix 毫秒）。
 */
export function nextWeeklyTime(weekday: number, time: TimeOfDay, from: number): number {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ScheduleError('INVALID_INPUT', `星期几要落在 0-6（0 是周日，收到 ${weekday}）。`)
  }
  const base = new Date(from)
  // 今天往后推几天到目标星期几（0-6 天之内必到）。
  const delta = (weekday - base.getDay() + 7) % 7
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta)
  const candidate = new Date(target.getFullYear(), target.getMonth(), target.getDate(), time.hour, time.minute, 0, 0)
  if (candidate.getTime() > from) return candidate.getTime()
  // 本周这个钟点已经过了：下周同一钟点。
  const next = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 7, time.hour, time.minute, 0, 0)
  return next.getTime()
}

/**
 * 下一次「每隔这么久」的时刻（对齐到建立时刻）。
 *
 * 对齐而不是「从上次响完往后推」：后者会让投递耗时一点点累积，提醒越响越晚。
 * @param anchor - 对齐基准（通常是提醒建立时刻）。
 * @param everyMs - 间隔（毫秒）。
 * @param from - 起算时刻（Unix 毫秒）。
 * @returns 下一次命中的时刻（Unix 毫秒）。
 */
export function nextIntervalTime(anchor: number, everyMs: number, from: number): number {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new ScheduleError('INVALID_INPUT', `间隔要是一个正的毫秒数（收到 ${everyMs}）。`)
  }
  if (from < anchor) return anchor + everyMs
  const elapsed = from - anchor
  const steps = Math.floor(elapsed / everyMs) + 1
  return anchor + steps * everyMs
}

/**
 * 触发方式的下一次响的时刻。
 *
 * 一次性触发过了那个点就**没有下一次**（返回 undefined）——它只响一次。
 * @param trigger - 触发方式。
 * @param from - 起算时刻（Unix 毫秒）。
 * @param anchor - 间隔类触发的对齐基准（其它触发方式用不上）。
 * @returns 下一次命中的时刻（Unix 毫秒）；没有下一次时 undefined。
 */
export function computeNextRun(trigger: ScheduleTrigger, from: number, anchor: number = from): number | undefined {
  if (trigger.kind === 'once') {
    return trigger.at > from ? trigger.at : undefined
  }
  if (trigger.kind === 'interval') {
    return nextIntervalTime(anchor, trigger.everyMs, from)
  }
  if (trigger.kind === 'daily') {
    return nextDailyTime(parseTimeOfDay(trigger.time), from)
  }
  if (trigger.kind === 'weekly') {
    return nextWeeklyTime(trigger.weekday, parseTimeOfDay(trigger.time), from)
  }
  if (trigger.kind === 'cron') {
    const spec = parseCron(trigger.expression)
    return nextCronTime(spec, from)
  }
  return undefined
}

/**
 * 触发方式的一句话说明（给模型与界面看）。
 * @param trigger - 触发方式。
 * @returns 中文说明。
 */
export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'once') return `一次性：${new Date(trigger.at).toLocaleString('zh-CN')}`
  if (trigger.kind === 'interval') return `每 ${Math.round(trigger.everyMs / 60000)} 分钟一次`
  if (trigger.kind === 'daily') return `每天 ${trigger.time}`
  if (trigger.kind === 'weekly') return `每${weekdayName(trigger.weekday)} ${trigger.time}`
  if (trigger.kind === 'cron') return `cron：${trigger.expression}`
  return '未知触发方式'
}

/** 星期几的中文名。 */
export function weekdayName(weekday: number): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[weekday] ?? `星期${weekday}`
}

/** cron 计划的中文摘要（给界面看）。 */
export function describeCron(spec: CronSpec): string {
  return `${spec.minutes.join(',')} 分 ${spec.hours.join(',')} 时 ${spec.daysOfMonth.join(',')} 日 ${spec.months.join(
    ',',
  )} 月 ${spec.daysOfWeek.join(',')} 周`
}
