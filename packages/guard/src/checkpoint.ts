/**
 * checkpoint（崩溃可恢复）。
 *
 * 现在 agent 循环的顺序是「工具执行完 → 结果进内存历史 → 整条发言落库」。崩在中间时，
 * **副作用已经发生但日志里没有这条调用**——重开之后模型不知道发生过什么，重试又会把副作用
 * 做第二遍。
 *
 * 落盘顺序反过来：**先写 checkpoint，再进历史**。调用请求先落盘、结果再落盘，写完才允许
 * 结果进历史。于是任何时刻崩溃，重开都能从 checkpoint 里读出「哪条调用发生过、结果是什么」。
 *
 * 落在哪：单独的 JSONL 文件（一个会话一份），不复用会话库。三条理由：
 *   1. 会话库是**单写者**模型（见 packages/session/src/store.ts 的开篇注释），而 checkpoint
 *      要写在工具执行的关键路径上，多一个写者就破坏了这个前提；
 *   2. 会话库的 schema 与迁移归 packages/session 管，另起一份文件免得两套迁移互相踩；
 *   3. 崩溃恢复只需要「尾部若干行」，追加写 + 逐行 fsync 就够，不需要索引与查询；
 *      JSONL 人能直接读——崩了 cat 一下就知道最后一步停在哪。
 * @module @ryharness/guard/checkpoint
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GuardToolResult } from './timeout.ts'

/** 一轮开始的记录：这一轮打算做什么。 */
export interface CheckpointTurnStart {
  kind: 'turn-start'
  /** 文件内单调递增的序号。 */
  seq: number
  /** 轮次 id（宿主生成，同一轮内的所有记录共用）。 */
  turnId: string
  /** 落盘时刻（Unix 毫秒）。 */
  at: number
  /** 这一轮打算做什么（写给恢复方看的一句话）。 */
  intent: string
}

/** 一次工具调用的请求记录。 */
export interface CheckpointCall {
  kind: 'call'
  seq: number
  turnId: string
  at: number
  /** 工具调用 id（与模型给的 callId 对齐）。 */
  callId: string
  /** 工具名。 */
  name: string
  /** 参数原文，逐字节保存（判定重复调用靠它）。 */
  arguments: string
}

/** 一次工具调用的结果记录。 */
export interface CheckpointResult {
  kind: 'result'
  seq: number
  turnId: string
  at: number
  /** 对应 {@link CheckpointCall.callId}。 */
  callId: string
  /** 工具结果正文。 */
  content: string
  /** 是否是错误结果。 */
  isError: boolean
}

/** 一轮结束的记录。 */
export interface CheckpointTurnEnd {
  kind: 'turn-end'
  seq: number
  turnId: string
  at: number
}

/** checkpoint 文件里的一条记录。 */
export type CheckpointRecord = CheckpointTurnStart | CheckpointCall | CheckpointResult | CheckpointTurnEnd

/** 一条没跑完的调用：请求落盘了，结果没有。 */
export interface UnfinishedCall {
  /** 所属轮次。 */
  turnId: string
  /** 工具调用 id。 */
  callId: string
  /** 工具名。 */
  name: string
  /** 参数原文。 */
  arguments: string
  /** 请求落盘的时刻。 */
  at: number
}

/** 崩溃恢复的读出结果。 */
export interface CheckpointRecovery {
  /** 上次没跑完的调用（按落盘顺序）。 */
  unfinished: UnfinishedCall[]
  /** 最后一轮的意图（恢复方据此决定怎么续）。 */
  intent?: string
  /** 最后一轮的 id。 */
  turnId?: string
  /** 读到了但解析不了的行数（崩在半行时会有）。 */
  damagedLines: number
}

/** checkpoint 日志的写入选项。 */
export interface CheckpointJournalOptions {
  /** checkpoint 文件路径（不存在会自动创建，父目录也会建）。 */
  filePath: string
  /**
   * 每次追加是否 fsync。默认 true——还留在 OS 缓冲里的写等于没写，而崩溃恢复要的正是
   * 「写完就在盘上」。
   */
  fsync?: boolean
}

/** 会话 id → 文件名片段。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_')
  // '.' 与 '..' 是合法的文件名字符，却不是合法的目录名——放行等于让路径指到外面去。
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'unknown'
  return cleaned
}

/**
 * 一个会话的 checkpoint 文件路径。
 * @param directory - checkpoint 根目录（宿主给，通常是应用数据目录）。
 * @param conversationId - 会话 id。
 */
export function defaultCheckpointPath(directory: string, conversationId: string): string {
  return join(directory, safeSegment(conversationId), 'checkpoint.jsonl')
}

/** 判断一个值是不是普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 解析一行；解析不出来（半行、格式不认识）返回 undefined，由调用方计数。 */
function parseRecord(line: string): CheckpointRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isPlainObject(value)) return undefined
  const seq = readNumber(value.seq)
  const turnId = readString(value.turnId)
  const at = readNumber(value.at)
  if (seq === undefined || turnId === undefined || at === undefined) return undefined
  const kind = readString(value.kind)
  switch (kind) {
    case 'turn-start': {
      const intent = readString(value.intent)
      if (intent === undefined) return undefined
      return { kind: 'turn-start', seq, turnId, at, intent }
    }
    case 'call': {
      const callId = readString(value.callId)
      const name = readString(value.name)
      const args = readString(value.arguments)
      if (callId === undefined || name === undefined || args === undefined) return undefined
      return { kind: 'call', seq, turnId, at, callId, name, arguments: args }
    }
    case 'result': {
      const callId = readString(value.callId)
      const content = readString(value.content)
      if (callId === undefined || content === undefined) return undefined
      return { kind: 'result', seq, turnId, at, callId, content, isError: value.isError === true }
    }
    case 'turn-end':
      return { kind: 'turn-end', seq, turnId, at }
    default:
      return undefined
  }
}

/**
 * 读出 checkpoint 文件里的全部记录。
 *
 * 解析不了的行被跳过而不是让整个读取失败：崩在写一半的行上时，那一行本来就是残缺的，
 * 但它前面的记录仍然是好的——恢复方要的是「最后一步停在哪」，不是「文件能不能读」。
 */
export function readCheckpointRecords(filePath: string): { records: CheckpointRecord[]; damagedLines: number } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    // 文件还不存在 = 这一轮还没开始过，不是错误。
    return { records: [], damagedLines: 0 }
  }
  const records: CheckpointRecord[] = []
  let damagedLines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const record = parseRecord(line)
    if (record === undefined) {
      damagedLines += 1
      continue
    }
    records.push(record)
  }
  return { records, damagedLines }
}

/** 文件里已经用掉的最大序号。 */
function lastSeqOf(filePath: string): number {
  const { records } = readCheckpointRecords(filePath)
  let max = 0
  for (const record of records) {
    if (record.seq > max) max = record.seq
  }
  return max
}

/**
 * checkpoint 写入器：按顺序往文件里追加记录。
 *
 * 每次追加都单独 write + fsync：崩溃恢复要的是「这一行已经在盘上」，攒着一起写等于
 * 把最近的几条调用一并丢掉——而丢掉的恰恰是崩溃点附近最要紧的那几条。
 */
export class CheckpointJournal {
  /** checkpoint 文件路径。 */
  readonly filePath: string
  private readonly fd: number
  private readonly shouldFsync: boolean
  private nextSeq: number
  private closed = false

  constructor(options: CheckpointJournalOptions) {
    this.filePath = options.filePath
    this.shouldFsync = options.fsync ?? true
    mkdirSync(dirname(this.filePath), { recursive: true })
    // 续写同一个文件时序号要接着走：序号乱掉会让恢复方看不懂记录的先后。
    this.nextSeq = lastSeqOf(this.filePath) + 1
    this.fd = openSync(this.filePath, 'a')
  }

  /** 记下「这一轮打算做什么」。 */
  appendTurnStart(input: { turnId: string; intent: string }): CheckpointTurnStart {
    const record: CheckpointTurnStart = {
      kind: 'turn-start',
      seq: this.takeSeq(),
      turnId: input.turnId,
      at: Date.now(),
      intent: input.intent,
    }
    this.append(record)
    return record
  }

  /** 记下「要调用哪个工具、参数是什么」。 */
  appendCall(input: { turnId: string; callId: string; name: string; arguments: string }): CheckpointCall {
    const record: CheckpointCall = {
      kind: 'call',
      seq: this.takeSeq(),
      turnId: input.turnId,
      at: Date.now(),
      callId: input.callId,
      name: input.name,
      arguments: input.arguments,
    }
    this.append(record)
    return record
  }

  /** 记下「这次调用结果是什么」。 */
  appendResult(input: { turnId: string; callId: string; content: string; isError?: boolean }): CheckpointResult {
    const record: CheckpointResult = {
      kind: 'result',
      seq: this.takeSeq(),
      turnId: input.turnId,
      at: Date.now(),
      callId: input.callId,
      content: input.content,
      isError: input.isError === true,
    }
    this.append(record)
    return record
  }

  /** 记下「这一轮收尾了」。 */
  appendTurnEnd(input: { turnId: string }): CheckpointTurnEnd {
    const record: CheckpointTurnEnd = {
      kind: 'turn-end',
      seq: this.takeSeq(),
      turnId: input.turnId,
      at: Date.now(),
    }
    this.append(record)
    return record
  }

  /** 关闭文件句柄。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.fd)
  }

  /** 取下一个序号。 */
  private takeSeq(): number {
    const seq = this.nextSeq
    this.nextSeq += 1
    return seq
  }

  /** 追加一行并落盘。 */
  private append(record: CheckpointRecord): void {
    if (this.closed) throw new Error('checkpoint journal 已关闭')
    writeSync(this.fd, `${JSON.stringify(record)}\n`)
    if (this.shouldFsync) fsyncSync(this.fd)
  }
}

/**
 * 崩溃恢复入口：读出「上次没跑完的调用」。
 *
 * 判定口径：**有 `call` 记录但没有对应 `result` 记录**的调用就是没跑完的——请求已经发出去
 * 了（副作用可能已经发生），但结果没落盘，宿主无从知道它到底做了什么。
 */
export function recoverCheckpoint(filePath: string): CheckpointRecovery {
  const { records, damagedLines } = readCheckpointRecords(filePath)
  const finished = new Set<string>()
  for (const record of records) {
    if (record.kind === 'result') finished.add(record.callId)
  }
  const unfinished: UnfinishedCall[] = []
  for (const record of records) {
    if (record.kind !== 'call') continue
    if (finished.has(record.callId)) continue
    unfinished.push({
      turnId: record.turnId,
      callId: record.callId,
      name: record.name,
      arguments: record.arguments,
      at: record.at,
    })
  }
  // 最后一轮的意图：恢复方要知道「当时打算做什么」才知道该从哪儿续。
  let intent: string | undefined
  let turnId: string | undefined
  for (const record of records) {
    if (record.kind !== 'turn-start') continue
    intent = record.intent
    turnId = record.turnId
  }
  return {
    unfinished,
    ...(intent === undefined ? {} : { intent }),
    ...(turnId === undefined ? {} : { turnId }),
    damagedLines,
  }
}

/** 一次带 checkpoint 的工具调用。 */
export interface CheckpointedToolCall {
  /** 写入器。 */
  journal: CheckpointJournal
  /** 所属轮次。 */
  turnId: string
  /** 工具调用 id。 */
  callId: string
  /** 工具名。 */
  name: string
  /** 参数原文。 */
  arguments: string
  /** 工具执行体。 */
  execute: () => Promise<GuardToolResult>
}

/** 错误转成一句能落盘的文字。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 跑一次工具调用，并把请求与结果**先落盘**。
 *
 * 顺序是这一层的全部意义：调用请求先落盘 → 工具执行 → 结果落盘 → 返回结果。宿主拿到
 * 返回值才让结果进历史，于是「结果进了历史但日志里没有」这件事不可能发生。
 *
 * 工具抛错时同样落一条错误结果：那次调用**已经发生过**，不落盘就等于把副作用藏起来。
 */
export async function runCheckpointedToolCall(input: CheckpointedToolCall): Promise<GuardToolResult> {
  input.journal.appendCall({
    turnId: input.turnId,
    callId: input.callId,
    name: input.name,
    arguments: input.arguments,
  })
  let result: GuardToolResult
  try {
    result = await input.execute()
  } catch (error) {
    result = { content: `工具「${input.name}」执行失败：${errorText(error)}`, isError: true }
  }
  input.journal.appendResult({
    turnId: input.turnId,
    callId: input.callId,
    content: result.content,
    isError: result.isError === true,
  })
  return result
}
