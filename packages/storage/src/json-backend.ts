/**
 * JSON 文件后端：一条记录一个可读文件。
 *
 * 布局是 `<根目录>/<kind>/<id>.json`，文件里是这一条记录的完整 JSON——
 * 人能直接打开看，也方便手工改（改坏了会报「内容损坏」，不会静默丢掉）。
 *
 * 写入是**原子**的：先写同目录下的临时文件，再 rename 盖上去。
 * 这一步不是为了性能，是为了不让读的人看见半条记录——
 * 直接往目标文件写的话，进程在写到一半被杀，读的人拿到的就是一份残缺的 JSON。
 * 临时文件名带进程号与随机数，两个写者不会踩到同一个临时文件。
 *
 * 文件名要能放得下 kind 与 id，所以做了一层可逆编码：
 * 只保留字母数字与 `-`，其余按 UTF-8 字节百分号编码，前面加一个 `_` 前缀
 * （Windows 的 `CON`/`NUL` 这类保留名、以及结尾的点与空格都需要躲开）。
 * @module @ryharness/storage/json-backend
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StorageCorruptError } from './errors.ts'
import type { StorageBackend, StorageRecord } from './types.ts'

/** 后端名。 */
export const JSON_BACKEND_NAME = 'json'

/** JSON 后端的配置。 */
export interface JsonBackendOptions {
  /** 存放记录的根目录。不存在会在第一次写入时创建。 */
  readonly root: string
}

/** 只保留这些字符，其余百分号编码。 */
const SAFE_CHAR = /[A-Za-z0-9_-]/

/**
 * 把一段字符串编码成能当文件名的样子。
 *
 * 可逆：{@link decodeSegment} 能原样还原，所以从目录名反推 kind 不会失真。
 */
export function encodeSegment(value: string): string {
  let out = '_'
  const bytes = Buffer.from(value, 'utf8')
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    if (byte < 0x80 && SAFE_CHAR.test(char)) {
      out += char
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/**
 * 还原 {@link encodeSegment} 编码过的名字。
 * @param encoded - 编码后的名字。
 * @returns 原来的字符串。
 */
export function decodeSegment(encoded: string): string {
  const body = encoded.startsWith('_') ? encoded.slice(1) : encoded
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '%' && i + 2 < body.length) {
      const hex = body.slice(i + 1, i + 3)
      const parsed = Number.parseInt(hex, 16)
      if (Number.isInteger(parsed)) {
        bytes.push(parsed)
        i += 2
        continue
      }
    }
    bytes.push(body.charCodeAt(i))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 记录是不是长得该有的样子。 */
function isStorageRecord(value: unknown): value is StorageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['kind'] === 'string' &&
    typeof record['createdAt'] === 'number' &&
    typeof record['updatedAt'] === 'number' &&
    'data' in record
  )
}

/**
 * JSON 文件后端。
 *
 * 同步接口：文件操作用同步 API，异步只会让调用方多 await 一次，
 * 换不来任何好处（真正的并发安全靠的是原子写，不是异步）。
 */
export class JsonBackend implements StorageBackend {
  /** 后端名。 */
  readonly name = JSON_BACKEND_NAME
  private readonly root: string

  constructor(options: JsonBackendOptions) {
    this.root = options.root
  }

  /**
   * 取一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @returns 记录；文件不在就是 `undefined`。
   */
  get(kind: string, id: string): StorageRecord | undefined {
    const path = this.pathOf(kind, id)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    const record = this.parse(text, path)
    if (record.id !== id || record.kind !== kind) {
      throw new StorageCorruptError(path, `文件里的记录是 ${record.kind}/${record.id}，与路径对不上`)
    }
    return record
  }

  /**
   * 写一条记录（整条覆盖）。
   * @param record - 要写的记录。
   */
  put(record: StorageRecord): void {
    const path = this.pathOf(record.kind, record.id)
    mkdirSync(join(this.root, encodeSegment(record.kind)), { recursive: true })
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    } catch (error) {
      // 临时文件留着只会变成垃圾（下次 list 会把它当坏文件），删掉。
      rmSync(temp, { force: true })
      throw error
    }
  }

  /**
   * 删一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @returns 真的删掉了才为 true。
   */
  remove(kind: string, id: string): boolean {
    const path = this.pathOf(kind, id)
    try {
      rmSync(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * 列出某个 kind 下的全部记录。
   * @param kind - 分组名。
   * @returns 记录列表，按创建时间、再按 id 排。
   */
  list(kind: string): StorageRecord[] {
    const dir = join(this.root, encodeSegment(kind))
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const records: StorageRecord[] = []
    for (const entry of entries) {
      // 临时文件与别的后缀都不是记录：临时文件是写一半的中间态，读它等于读到半条记录。
      if (!entry.endsWith('.json') || entry.includes('.tmp')) continue
      const path = join(dir, entry)
      records.push(this.parse(readFileSync(path, 'utf8'), path))
    }
    return records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * 列出当前存着的全部分组。
   * @returns 分组名列表，按名字排。
   */
  kinds(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.root)
    } catch {
      return []
    }
    const kinds: string[] = []
    for (const entry of entries) {
      const dir = join(this.root, entry)
      const files = this.recordFilesOf(dir)
      if (files.length === 0) continue
      kinds.push(decodeSegment(entry))
    }
    return kinds.sort()
  }

  /** 关闭后端。文件后端没有需要释放的长期资源，这里什么都不做。 */
  close(): void {
    // 文件后端每次操作都开关文件，没有长期句柄。
  }

  /** 某个 kind 下的记录文件。 */
  private recordFilesOf(dir: string): string[] {
    try {
      return readdirSync(dir).filter((entry) => entry.endsWith('.json') && !entry.includes('.tmp'))
    } catch {
      return []
    }
  }

  /** 记录的文件路径。 */
  private pathOf(kind: string, id: string): string {
    return join(this.root, encodeSegment(kind), `${encodeSegment(id)}.json`)
  }

  /** 解析文件内容；读不出来就报「内容损坏」。 */
  private parse(text: string, path: string): StorageRecord {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new StorageCorruptError(path, `不是合法的 JSON（${reason}）`)
    }
    if (!isStorageRecord(parsed)) {
      throw new StorageCorruptError(path, 'JSON 里的内容不像一条记录')
    }
    return parsed
  }
}
