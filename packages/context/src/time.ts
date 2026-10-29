/**
 * 当前时间：让模型知道「现在几点」，免得它自己猜。
 * @module @ryharness/context/time
 */

/** 时区里的一份挂钟时间。 */
interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** 装配出来的时间上下文。 */
export interface TimeBlock {
  /** 本地时间，形如 '2026-10-29 21:34:00'。 */
  local: string
  /** 时区标识（IANA 名）。 */
  timeZone: string
  /** 相对 UTC 的偏移，形如 'UTC+08:00'。 */
  offset: string
  /** 给模型的正文。 */
  text: string
}

/** 装配时间上下文的参数。 */
export interface TimeContextOptions {
  /** 取当前时间的方式（默认取系统时间）；测试注入固定时刻。 */
  now?: () => Date
  /** 时区（IANA 名，如 'Asia/Shanghai'）；缺省用系统时区。 */
  timeZone?: string
}

/**
 * 装配当前时间。
 * @param options - 取时间与时区的方式。
 * @returns 时间上下文。
 */
export function buildTimeContext(options: TimeContextOptions = {}): TimeBlock {
  const date = (options.now ?? (() => new Date()))()
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const zone = zoneParts(date, timeZone)
  const local =
    `${pad(zone.year, 4)}-${pad(zone.month, 2)}-${pad(zone.day, 2)} ` +
    `${pad(zone.hour, 2)}:${pad(zone.minute, 2)}:${pad(zone.second, 2)}`
  const minutes = offsetMinutes(date, timeZone)
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const offset = `UTC${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`
  return {
    local,
    timeZone,
    offset,
    text: `[当前时间]\n${local}（${timeZone}，${offset}）`,
  }
}

/** 取某个时刻在指定时区里的挂钟时间。 */
function zoneParts(date: Date, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/**
 * 时区相对 UTC 的偏移（分钟）。
 *
 * 拿「时区里的挂钟时间」和「同一时刻的 UTC 挂钟时间」相减：两个时间当成同一个
 * 挂钟读数去比，差值就是偏移。比读时区名可靠——夏令时切换时名字会变，偏移也会。
 */
function offsetMinutes(date: Date, timeZone: string): number {
  const zone = zoneParts(date, timeZone)
  const asZone = Date.UTC(zone.year, zone.month - 1, zone.day, zone.hour, zone.minute, zone.second)
  const asUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  )
  return Math.round((asZone - asUtc) / 60_000)
}

/** 补零到固定宽度。 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}
