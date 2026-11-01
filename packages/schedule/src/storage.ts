/**
 * 提醒存储的两个后端：内存的与文件的。
 *
 * 提醒要**跨 Host 重启存活**——用户设了「明天上午九点提醒我」，关掉应用再打开，
 * 它还得在。所以默认给的是文件后端。
 *
 * 文件的形状是「一个 JSON 文件装全部提醒」：提醒量级是人的待办量级（几十条），
 * 整份读写比维护一堆小文件省心。写入走「临时文件 + rename」，崩在写一半时留下的
 * 不是半份 JSON，而是一份完整的旧数据。
 * @module @ryharness/schedule/storage
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ScheduleStatus, ScheduleStore, ScheduleTask, ScheduleTrigger } from './types.ts'

/** 内存后端：进程活着就有，进程死了就没。 */
export class MemoryScheduleStore implements ScheduleStore {
  private tasks: ScheduleTask[] = []

  load(): readonly ScheduleTask[] {
    return this.tasks.map((task) => {
      return cloneTask(task)
    })
  }

  save(tasks: readonly ScheduleTask[]): void {
    this.tasks = tasks.map((task) => {
      return cloneTask(task)
    })
  }
}

/** 文件后端的构造参数。 */
export interface FileScheduleStoreOptions {
  /** 文件路径（父目录会自动建）。 */
  readonly filePath: string
}

/** 文件里存的东西。 */
interface ScheduleFile {
  tasks: ScheduleTask[]
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/** 文件后端：提醒落在一个 JSON 文件里。 */
export class FileScheduleStore implements ScheduleStore {
  private readonly filePath: string

  constructor(options: FileScheduleStoreOptions) {
    this.filePath = options.filePath
  }

  load(): readonly ScheduleTask[] {
    if (!existsSync(this.filePath)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      // 半份 JSON 说明上次崩在写入中途：这份数据不可信，当没有提醒。
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const rawTasks = (parsed as { tasks?: unknown }).tasks
    if (!Array.isArray(rawTasks)) return []
    const out: ScheduleTask[] = []
    for (const raw of rawTasks) {
      const task = parseTask(raw)
      if (task !== undefined) out.push(task)
    }
    return out
  }

  save(tasks: readonly ScheduleTask[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: ScheduleFile = {
      tasks: tasks.map((task) => {
        return cloneTask(task)
      }),
    }
    const tmp = `${this.filePath}.${process.pid}.${tempSeq++}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
      }
      throw error
    }
  }
}

/** 判断一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 合法状态。 */
function parseStatus(value: unknown): ScheduleStatus | undefined {
  if (value === 'active' || value === 'disabled' || value === 'completed') return value
  return undefined
}

/** 合法触发方式；认不出来就当没有（那条提醒丢掉）。 */
function parseTrigger(value: unknown): ScheduleTrigger | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  if (kind === 'once') {
    const at = value.at
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
    return { kind: 'once', at }
  }
  if (kind === 'interval') {
    const everyMs = value.everyMs
    if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) return undefined
    return { kind: 'interval', everyMs }
  }
  if (kind === 'daily') {
    const time = value.time
    if (typeof time !== 'string') return undefined
    return { kind: 'daily', time }
  }
  if (kind === 'weekly') {
    const weekday = value.weekday
    const time = value.time
    if (typeof weekday !== 'number' || !Number.isInteger(weekday)) return undefined
    if (typeof time !== 'string') return undefined
    return { kind: 'weekly', weekday, time }
  }
  if (kind === 'cron') {
    const expression = value.expression
    if (typeof expression !== 'string') return undefined
    return { kind: 'cron', expression }
  }
  return undefined
}

/** 读一条提醒；缺字段就当没有这条。 */
function parseTask(value: unknown): ScheduleTask | undefined {
  if (!isRecord(value)) return undefined
  const id = value.id
  const conversationId = value.conversationId
  const title = value.title
  const text = value.text
  const trigger = parseTrigger(value.trigger)
  const status = parseStatus(value.status)
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  const fireCount = value.fireCount
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  if (typeof title !== 'string') return undefined
  if (typeof text !== 'string') return undefined
  if (trigger === undefined) return undefined
  if (status === undefined) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  if (typeof fireCount !== 'number' || !Number.isFinite(fireCount)) return undefined
  const nextRunAt = value.nextRunAt
  const lastRunAt = value.lastRunAt
  return {
    id,
    conversationId,
    title,
    text,
    trigger,
    status,
    createdAt,
    updatedAt,
    fireCount,
    ...(typeof nextRunAt === 'number' && Number.isFinite(nextRunAt) ? { nextRunAt } : {}),
    ...(typeof lastRunAt === 'number' && Number.isFinite(lastRunAt) ? { lastRunAt } : {}),
  }
}

/** 提醒拷贝：调用方改返回值不会改到存储里的东西。 */
function cloneTask(task: ScheduleTask): ScheduleTask {
  return {
    ...task,
    trigger: { ...task.trigger },
  }
}
