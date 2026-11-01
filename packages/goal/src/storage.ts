/**
 * 目标存储的两个后端：内存的与文件的。
 *
 * 目标要**跨重启还在**——助理把一件事记下来，用户关掉应用，第二天回来它还在。
 * 所以默认给的是文件后端；内存后端是给短命进程（测试、一次性脚本）用的。
 *
 * 文件后端的形状是「一个 JSON 文件装全部会话」而不是「一个会话一个文件」：
 * 目标量级是人的待办量级（几十条），整份读写比维护一堆小文件省心得多，也不会
 * 出现「目录里堆了几百个文件」这种没人愿意收拾的场面。写入走「临时文件 + rename」，
 * 崩在写一半时留下的不是半份 JSON，而是一份完整的旧数据。
 * @module @ryharness/goal/storage
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Goal, GoalChange, GoalRecord, GoalStatus, GoalStore } from './types.ts'

/** 内存后端：进程活着就有，进程死了就没。 */
export class MemoryGoalStore implements GoalStore {
  private readonly records = new Map<string, GoalRecord>()

  load(sessionId: string): GoalRecord | undefined {
    const record = this.records.get(sessionId)
    if (record === undefined) return undefined
    return cloneRecord(record)
  }

  save(sessionId: string, record: GoalRecord): void {
    this.records.set(sessionId, cloneRecord(record))
  }

  listSessions(): readonly string[] {
    return [...this.records.keys()]
  }
}

/** 文件后端的构造参数。 */
export interface FileGoalStoreOptions {
  /** 文件路径（父目录会自动建）。 */
  readonly filePath: string
}

/** 文件里存的东西：一个会话 id → 一份档案。 */
interface GoalFile {
  sessions: Record<string, GoalRecord>
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/**
 * 文件后端：目标落在一个 JSON 文件里。
 *
 * 读的时候坏数据不挡启动——整份文件坏掉就当没有目标（用户重设一个就行），
 * 但单条记录坏掉只丢那一条：一个人一个会话坏掉，不该让别的会话的目标也没了。
 */
export class FileGoalStore implements GoalStore {
  private readonly filePath: string

  constructor(options: FileGoalStoreOptions) {
    this.filePath = options.filePath
  }

  load(sessionId: string): GoalRecord | undefined {
    const sessions = readSessions(this.filePath)
    const record = sessions[sessionId]
    if (record === undefined) return undefined
    return cloneRecord(record)
  }

  save(sessionId: string, record: GoalRecord): void {
    const sessions = readSessions(this.filePath)
    sessions[sessionId] = cloneRecord(record)
    writeSessions(this.filePath, sessions)
  }

  listSessions(): readonly string[] {
    return Object.keys(readSessions(this.filePath))
  }
}

/** 读整份文件；坏文件当空。 */
function readSessions(filePath: string): Record<string, GoalRecord> {
  if (!existsSync(filePath)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    // 半份 JSON 说明上次崩在写入中途：这份数据不可信，当没有目标。
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const sessions = (parsed as { sessions?: unknown }).sessions
  if (typeof sessions !== 'object' || sessions === null) return {}
  const out: Record<string, GoalRecord> = {}
  for (const [sessionId, value] of Object.entries(sessions)) {
    const record = parseRecord(value)
    if (record === undefined) continue
    out[sessionId] = record
  }
  return out
}

/** 原子写：先写同目录临时文件，再 rename 覆盖目标。 */
function writeSessions(filePath: string, sessions: Record<string, GoalRecord>): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const payload: GoalFile = { sessions }
  const tmp = `${filePath}.${process.pid}.${tempSeq++}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
    }
    throw error
  }
}

/** 判断一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 合法状态；不认识的一律当没有。 */
function parseStatus(value: unknown): GoalStatus | undefined {
  if (value === 'active' || value === 'paused' || value === 'blocked') return value
  if (value === 'completed' || value === 'cleared') return value
  return undefined
}

/** 合法动作。 */
function parseAction(value: unknown): GoalChange['action'] | undefined {
  const actions: readonly GoalChange['action'][] = [
    'created',
    'updated',
    'paused',
    'resumed',
    'completed',
    'blocked',
    'cleared',
  ]
  for (const action of actions) {
    if (value === action) return action
  }
  return undefined
}

/** 读一个目标；缺字段就当没有这条。 */
function parseGoal(value: unknown): Goal | undefined {
  if (!isRecord(value)) return undefined
  const id = value.id
  const sessionId = value.sessionId
  const title = value.title
  const description = value.description
  const criteria = value.criteria
  const status = parseStatus(value.status)
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof title !== 'string') return undefined
  if (typeof description !== 'string') return undefined
  if (typeof criteria !== 'string') return undefined
  if (status === undefined) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  return {
    id,
    sessionId,
    title,
    description,
    criteria,
    status,
    createdAt,
    updatedAt,
  }
}

/** 读一条变更；缺字段就当没有这条。 */
function parseChange(value: unknown): GoalChange | undefined {
  if (!isRecord(value)) return undefined
  const at = value.at
  const action = parseAction(value.action)
  const goalId = value.goalId
  const summary = value.summary
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  if (action === undefined) return undefined
  if (typeof goalId !== 'string' || goalId.length === 0) return undefined
  if (typeof summary !== 'string') return undefined
  const from = parseStatus(value.from)
  const to = parseStatus(value.to)
  return {
    at,
    action,
    goalId,
    summary,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  }
}

/** 读一份档案；坏字段逐条丢弃。 */
function parseRecord(value: unknown): GoalRecord | undefined {
  if (!isRecord(value)) return undefined
  const goal = value.goal === undefined ? undefined : parseGoal(value.goal)
  const rawHistory = value.history
  const history: GoalChange[] = []
  if (Array.isArray(rawHistory)) {
    for (const raw of rawHistory) {
      const change = parseChange(raw)
      if (change !== undefined) history.push(change)
    }
  }
  if (goal === undefined && history.length === 0) return undefined
  return {
    ...(goal === undefined ? {} : { goal }),
    history,
  }
}

/** 档案拷贝：调用方改返回值不会改到存储里的东西。 */
function cloneRecord(record: GoalRecord): GoalRecord {
  return {
    ...(record.goal === undefined ? {} : { goal: { ...record.goal } }),
    history: record.history.map((change) => {
      return { ...change }
    }),
  }
}
