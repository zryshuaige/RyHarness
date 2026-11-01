/**
 * 本机私有文件后端：溢出文本落到应用数据目录下的会话私有子目录。
 *
 * 为什么是文件而不是塞回内存或数据库：
 * - 溢出的东西**天生是大块的**（几万到几百万字符），内存里攒着迟早把进程拖垮；
 * - 它是**一次性的**：模型看完就丢，不需要索引、事务、迁移；
 * - 落盘之后，崩溃重启也还在——模型下一轮还能把上次的结果取回来。
 *
 * 目录长这样：`<dataDir>/spills/<会话slug>/<id>.txt`。
 * 会话目录名是「可读前缀 + 会话 id 的哈希」：可读前缀方便人排查，哈希保证两个
 * 不同的会话 id 不会因为清洗后重名而落到同一个目录里（清洗规则挡不住所有 id）。
 * 没有会话归属的文本单独放 `_shared/`——定位符本身就是那把钥匙。
 *
 * 明确不做（上游 dsh 有，我们这轮没有）：
 * - **不做 zstd 压缩**：溢出文本要能被人直接打开看，压缩会让排查变麻烦。
 * - **不做代际文件轮转**：上游按代次换目录，我们只有一层。
 * 详见 README。
 * @module @ryharness/spill/local
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, type Stats, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SPILL_READ_TOOL_NAME,
  type SpillCleanupOptions,
  type SpillCleanupResult,
  SpillError,
  type SpillMeta,
  type SpillReadOptions,
  type SpillReadResult,
  type SpillRef,
  type SpillStore,
} from './types.ts'

/** 溢出目录名（在数据目录下）。 */
const SPILLS_DIR = 'spills'
/** 没有会话归属的文本放这儿。 */
const SHARED_DIR = '_shared'
/** 正文文件后缀。 */
const TEXT_SUFFIX = '.txt'
/** 元信息文件后缀（跟正文同目录，删的时候一起删）。 */
const META_SUFFIX = '.meta.json'
/** 总量上限：64 MiB。 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
/** 单条上限：8 MiB。再大的工具结果溢出去也没意义。 */
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** 默认过期年龄：7 天。 */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** 定位符的合法形状：只允许这些字符，就不可能拼出路径。 */
const SPILL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 定位符像不像一个合法的 id。 */
export function isSpillId(id: string): boolean {
  return SPILL_ID_PATTERN.test(id)
}

/**
 * 会话 id → 目录名。
 *
 * 清洗规则挡不住所有 id（`..`、斜杠、盘符都可能出现在会话 id 里），所以除了清洗
 * 还要加一段哈希：两个不同的会话 id 清洗后重名时，哈希把它们分开。
 * @param sessionId - 会话 id。
 * @returns 目录名（一段安全的文件名）。
 */
export function sessionSlug(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${readable}-${digest}`
}

/** 索引里的一条记录。 */
interface SpillRecord {
  readonly id: string
  readonly sessionSlug: string
  readonly sessionId?: string
  /** 正文文件的绝对路径。 */
  readonly path: string
  readonly bytes: number
  readonly chars: number
  readonly createdAt: string
  readonly createdAtMs: number
  readonly tool?: string
  readonly note?: string
}

/** 本机私有文件存储的构造参数。 */
export interface LocalSpillStoreOptions {
  /** 数据目录：溢出文件落在 `<dataDir>/spills/` 下面。 */
  readonly dataDir: string
  /** 总量上限（字节）。缺省 64 MiB。 */
  readonly maxBytes?: number
  /** 单条上限（字节）。缺省 8 MiB。 */
  readonly maxEntryBytes?: number
  /** 过期年龄（毫秒）：清理时删掉比这更老的。缺省 7 天。 */
  readonly maxAgeMs?: number
  /** 时钟（测试注入用）。 */
  readonly now?: () => number
  /** 定位符生成（测试注入用）。 */
  readonly newId?: () => string
}

/** 读同目录下的元信息文件；读不到就当没有（不因为旁挂文件丢了正文而整条报废）。 */
function readMeta(textPath: string): Record<string, unknown> | undefined {
  const metaPath = textPath.replace(/\.txt$/, META_SUFFIX)
  if (!existsSync(metaPath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 元信息里的字符串字段。 */
function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 取文件信息；文件不在了（可能刚被清掉）返回 undefined。 */
function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * 本机私有文件存储。
 *
 * 一个实例管一个数据目录下的所有会话：会话归属体现在目录上，取回时按目录核对。
 * 实例内部维护一份索引（id → 记录），容量核算与清理都靠它；索引在首次使用时
 * 扫盘建立，之后由本实例自己的写入/删除维护。
 */
export class LocalSpillStore implements SpillStore {
  private readonly dataDir: string
  private readonly maxBytes: number
  private readonly maxEntryBytes: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private readonly newId: () => string
  private index: Map<string, SpillRecord> | undefined

  constructor(options: LocalSpillStoreOptions) {
    this.dataDir = options.dataDir
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? defaultId
  }

  /**
   * 存下一段文字。
   *
   * 存不下就抛错——**不悄悄截断**：上层拿到错误才知道该保留原文，而不是让模型
   * 拿到一段缺了尾巴的预览却以为那就是全部。
   * @param text - 正文。
   * @param meta - 元信息（会话归属、来源工具）。
   * @returns 定位符。
   */
  store(text: string, meta?: SpillMeta): SpillRef {
    if (typeof text !== 'string') {
      throw new SpillError('INVALID_INPUT', '溢出文本必须是字符串。')
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxEntryBytes) {
      throw new SpillError('CAPACITY_EXCEEDED', `这一段有 ${bytes} 字节，超过单条上限 ${this.maxEntryBytes} 字节。`)
    }
    const index = this.ensureIndex()
    const used = this.usedBytes(index)
    if (used + bytes > this.maxBytes) {
      throw new SpillError(
        'CAPACITY_EXCEEDED',
        `溢出目录已经用了 ${used} 字节，加上这一段会超过上限 ${this.maxBytes} 字节。`,
      )
    }
    const sessionId = meta?.sessionId
    const slug = sessionId === undefined ? SHARED_DIR : sessionSlug(sessionId)
    const id = this.newId()
    if (!isSpillId(id)) {
      throw new SpillError('INVALID_INPUT', `生成的定位符不合法：${id}`)
    }
    const dir = join(this.spillsRoot(), slug)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${id}${TEXT_SUFFIX}`)
    const createdAtMs = this.now()
    const createdAt = new Date(createdAtMs).toISOString()
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
    const record: SpillRecord = {
      id,
      sessionSlug: slug,
      ...(sessionId === undefined ? {} : { sessionId }),
      path,
      bytes,
      chars: text.length,
      createdAt,
      createdAtMs,
      ...(meta?.tool === undefined ? {} : { tool: meta.tool }),
      ...(meta?.note === undefined ? {} : { note: meta.note }),
    }
    this.writeMeta(record, meta)
    index.set(id, record)
    return this.toRef(record)
  }

  /**
   * 按定位符取回原文。
   * @param locator - 定位符（id 或 {@link SpillRef}）。
   * @param options - 会话归属与分页位置。
   * @returns 取回的那一段。
   */
  read(locator: string | SpillRef, options?: SpillReadOptions): SpillReadResult {
    const id = typeof locator === 'string' ? locator : locator.id
    if (!isSpillId(id)) {
      throw new SpillError('INVALID_INPUT', `定位符不合法：${id}`)
    }
    const record = this.find(id)
    if (record === undefined) {
      throw new SpillError('NOT_FOUND', '找不到这段溢出文本（可能已经被清理了）。')
    }
    this.assertSession(record, options?.sessionId)
    let raw: string
    try {
      raw = readFileSync(record.path, 'utf8')
    } catch (error) {
      throw new SpillError('READ_FAILED', `读这段溢出文本失败：${messageOf(error)}`)
    }
    const offset = clampOffset(options?.offset, raw.length)
    const limit = clampLimit(options?.limit, raw.length - offset)
    const text = raw.slice(offset, offset + limit)
    const nextOffset = offset + text.length < raw.length ? offset + text.length : undefined
    return {
      id: record.id,
      text,
      chars: raw.length,
      offset,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      hasMore: nextOffset !== undefined,
      createdAt: record.createdAt,
      meta: this.toMeta(record),
    }
  }

  /**
   * 删掉一条。
   * @param locator - 定位符。
   * @returns 删掉了返回 true。
   */
  remove(locator: string | SpillRef): boolean {
    const id = typeof locator === 'string' ? locator : locator.id
    const index = this.ensureIndex()
    const record = index.get(id)
    if (record === undefined) return false
    this.deleteRecord(record)
    index.delete(id)
    return true
  }

  /**
   * 清理：过期或指定会话的溢出文件。
   * @param options - 清理条件。
   * @returns 清掉几条、腾出多少字节。
   */
  cleanup(options?: SpillCleanupOptions): SpillCleanupResult {
    const index = this.ensureIndex()
    const olderThanMs = options?.olderThanMs ?? this.maxAgeMs
    const nowMs = this.now()
    const wantedSlug = options?.sessionId === undefined ? undefined : sessionSlug(options.sessionId)
    let removed = 0
    let freedBytes = 0
    for (const [id, record] of [...index]) {
      if (wantedSlug !== undefined && record.sessionSlug !== wantedSlug) continue
      if (nowMs - record.createdAtMs < olderThanMs) continue
      this.deleteRecord(record)
      index.delete(id)
      removed += 1
      freedBytes += record.bytes
    }
    return { removed, freedBytes }
  }

  /**
   * 列出现有的溢出文本（新到旧）。
   * @param sessionId - 只列这个会话的（缺省列全部）。
   * @returns 定位符列表。
   */
  list(sessionId?: string): SpillRef[] {
    const index = this.ensureIndex()
    const wantedSlug = sessionId === undefined ? undefined : sessionSlug(sessionId)
    const records = [...index.values()].filter((record) => {
      return wantedSlug === undefined || record.sessionSlug === wantedSlug
    })
    records.sort((a, b) => {
      return b.createdAtMs - a.createdAtMs
    })
    return records.map((record) => {
      return this.toRef(record)
    })
  }

  /** 溢出目录的绝对路径。 */
  private spillsRoot(): string {
    return join(this.dataDir, SPILLS_DIR)
  }

  /** 索引：第一次用时扫盘建好。 */
  private ensureIndex(): Map<string, SpillRecord> {
    if (this.index === undefined) this.index = this.scan()
    return this.index
  }

  /** 扫盘建索引。 */
  private scan(): Map<string, SpillRecord> {
    const out = new Map<string, SpillRecord>()
    const root = this.spillsRoot()
    if (!existsSync(root)) return out
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const slug = dir.name
      const dirPath = join(root, slug)
      for (const file of readdirSync(dirPath, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(TEXT_SUFFIX)) continue
        const id = file.name.slice(0, -TEXT_SUFFIX.length)
        if (!isSpillId(id)) continue
        const path = join(dirPath, file.name)
        const stat = safeStat(path)
        if (stat === undefined) continue
        const meta = readMeta(path)
        const createdAtMs = typeof meta?.createdAtMs === 'number' ? meta.createdAtMs : stat.mtimeMs
        const sessionId = metaString(meta, 'sessionId')
        const tool = metaString(meta, 'tool')
        const note = metaString(meta, 'note')
        out.set(id, {
          id,
          sessionSlug: slug,
          ...(sessionId === undefined ? {} : { sessionId }),
          path,
          bytes: stat.size,
          chars: typeof meta?.chars === 'number' ? meta.chars : stat.size,
          createdAt: metaString(meta, 'createdAt') ?? new Date(createdAtMs).toISOString(),
          createdAtMs,
          ...(tool === undefined ? {} : { tool }),
          ...(note === undefined ? {} : { note }),
        })
      }
    }
    return out
  }

  /** 找一条记录；索引里没有就重扫一次（可能是另一个进程刚写的）。 */
  private find(id: string): SpillRecord | undefined {
    const index = this.ensureIndex()
    const hit = index.get(id)
    if (hit !== undefined) return hit
    this.index = this.scan()
    return this.index.get(id)
  }

  /**
   * 会话归属核对：这段文本是不是当前调用方的。
   *
   * `_shared`（没有归属）谁都能取；归属了会话的文本只有那个会话能取。
   * 调用方没有会话上下文时，归属会话的文本一律拒——宁可取不到，也不能让
   * 「没有会话」变成一把万能钥匙。
   */
  private assertSession(record: SpillRecord, sessionId: string | undefined): void {
    if (record.sessionSlug === SHARED_DIR) return
    if (sessionId === undefined || sessionId.length === 0) {
      throw new SpillError('FORBIDDEN', '这段溢出文本属于某个会话，当前调用没有会话上下文。')
    }
    if (sessionSlug(sessionId) !== record.sessionSlug) {
      throw new SpillError('FORBIDDEN', '这段溢出文本属于别的会话。')
    }
  }

  /** 写元信息旁挂文件：正文与元信息分开，正文保持原样。 */
  private writeMeta(record: SpillRecord, meta: SpillMeta | undefined): void {
    const payload = {
      id: record.id,
      sessionId: record.sessionId,
      tool: meta?.tool,
      note: meta?.note,
      createdAt: record.createdAt,
      createdAtMs: record.createdAtMs,
      chars: record.chars,
    }
    const metaPath = record.path.replace(/\.txt$/, META_SUFFIX)
    try {
      writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 元信息写不进去不该让这次存储失败：正文已经落盘了，取回靠的是正文。
    }
  }

  /** 删掉一条记录的文件（正文 + 元信息）。 */
  private deleteRecord(record: SpillRecord): void {
    const metaPath = record.path.replace(/\.txt$/, META_SUFFIX)
    rmSync(record.path, { force: true })
    rmSync(metaPath, { force: true })
  }

  /** 索引里所有正文占多少字节。 */
  private usedBytes(index: Map<string, SpillRecord>): number {
    let total = 0
    for (const record of index.values()) total += record.bytes
    return total
  }

  /** 记录 → 定位符。 */
  private toRef(record: SpillRecord): SpillRef {
    const relative = `${SPILLS_DIR}/${record.sessionSlug}/${record.id}${TEXT_SUFFIX}`
    return {
      id: record.id,
      chars: record.chars,
      path: relative,
      retrieval: `调用 ${SPILL_READ_TOOL_NAME}，参数 id="${record.id}"（可分页：offset / limit）。`,
      createdAt: record.createdAt,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.tool === undefined ? {} : { tool: record.tool }),
    }
  }

  /** 记录 → 元信息。 */
  private toMeta(record: SpillRecord): SpillMeta {
    return {
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.tool === undefined ? {} : { tool: record.tool }),
      ...(record.note === undefined ? {} : { note: record.note }),
    }
  }
}

/** 默认定位符：时间前缀方便排序，随机后缀保证猜不到。 */
function defaultId(): string {
  return `sp_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
}

/** 偏移量收窄：负数当 0，超过长度当末尾。 */
function clampOffset(offset: number | undefined, length: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  const value = Math.floor(offset)
  if (value <= 0) return 0
  return value >= length ? length : value
}

/** 取回长度收窄：负数当 0，超过剩余长度就取到末尾。 */
function clampLimit(limit: number | undefined, remaining: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return remaining
  const value = Math.floor(limit)
  if (value <= 0) return 0
  return value >= remaining ? remaining : value
}

/** 异常 → 一句人话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
