/**
 * SQLite 后端：一条记录一个文档行。
 *
 * 与 JSON 后端的取舍正好相反：JSON 后端一条记录一个文件（人能直接打开看，
 * 但文件多了就慢），SQLite 后端把记录存成一行一个 JSON 文档
 * （`data` 列是文档本体，`id`/`kind`/`created_at`/`updated_at` 是索引列）。
 *
 * 用 `node:sqlite`（Node 22.13 起内置且不再需要 flag），不引外部依赖。
 *
 * 并发靠三件事：
 * - **WAL**：读写不互相阻塞——写者写 WAL，读者读快照。这是 SQLite 的并发读法。
 * - **busy_timeout**：写锁被占时等一会儿而不是立刻报错。
 * - **事务**：一次 `put` 是一次事务，写一半被杀的记录不会留在库里。
 * @module @ryharness/storage/sqlite-backend
 */

import { DatabaseSync } from 'node:sqlite'
import { StorageCorruptError } from './errors.ts'
import type { StorageBackend, StorageRecord } from './types.ts'

/** 后端名。 */
export const SQLITE_BACKEND_NAME = 'sqlite'

/** SQLite 后端的配置。 */
export interface SqliteBackendOptions {
  /**
   * 数据库文件路径。
   *
   * 传 `':memory:'` 得到一个内存库：进程结束就没了，适合测试与临时用途。
   */
  readonly file: string
}

/** 表结构：索引列 + 文档列。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS records_kind_created ON records (kind, created_at, id);
`

/**
 * SQLite 后端。
 */
export class SqliteBackend implements StorageBackend {
  /** 后端名。 */
  readonly name = SQLITE_BACKEND_NAME
  private readonly db: DatabaseSync
  private closed = false

  constructor(options: SqliteBackendOptions) {
    this.db = new DatabaseSync(options.file)
    // WAL 让读不阻塞写。内存库不支持 WAL（会静默留在 memory 模式），那就跳过。
    if (options.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    // 拿不到锁时等一会儿再报错，而不是立刻抛 SQLITE_BUSY。
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  /**
   * 取一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @returns 记录；没有就是 `undefined`。
   */
  get(kind: string, id: string): StorageRecord | undefined {
    const row = this.db
      .prepare('SELECT document, created_at, updated_at FROM records WHERE kind = ? AND id = ?')
      .get(kind, id)
    if (row === undefined) return undefined
    const document = row['document']
    const createdAt = row['created_at']
    const updatedAt = row['updated_at']
    if (typeof document !== 'string') {
      throw new StorageCorruptError(`${kind}/${id}`, 'document 列不是文本')
    }
    if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
      throw new StorageCorruptError(`${kind}/${id}`, '时间戳列不是数字')
    }
    return this.parse(document, kind, id, createdAt, updatedAt)
  }

  /**
   * 写一条记录（整条覆盖）。
   * @param record - 要写的记录。
   */
  put(record: StorageRecord): void {
    const document = JSON.stringify(record.data)
    this.db
      .prepare(
        `INSERT INTO records (kind, id, created_at, updated_at, document)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           document = excluded.document`,
      )
      .run(record.kind, record.id, record.createdAt, record.updatedAt, document)
  }

  /**
   * 删一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @returns 真的删掉了才为 true。
   */
  remove(kind: string, id: string): boolean {
    const result = this.db.prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, id)
    return Number(result.changes) > 0
  }

  /**
   * 列出某个 kind 下的全部记录。
   * @param kind - 分组名。
   * @returns 记录列表，按创建时间、再按 id 排。
   */
  list(kind: string): StorageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, document, created_at, updated_at FROM records
         WHERE kind = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(kind)
    return rows.map((row) => {
      const id = row['id']
      const document = row['document']
      const createdAt = row['created_at']
      const updatedAt = row['updated_at']
      if (typeof id !== 'string' || typeof document !== 'string') {
        throw new StorageCorruptError(`${kind}`, '行里的列不是预期的类型')
      }
      if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') {
        throw new StorageCorruptError(`${kind}/${id}`, '时间戳列不是数字')
      }
      return this.parse(document, kind, id, createdAt, updatedAt)
    })
  }

  /**
   * 列出当前存着的全部分组。
   * @returns 分组名列表，按名字排。
   */
  kinds(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT kind FROM records ORDER BY kind ASC').all()
    return rows.map((row) => {
      const kind = row['kind']
      if (typeof kind !== 'string') throw new StorageCorruptError('records', 'kind 列不是文本')
      return kind
    })
  }

  /**
   * 关闭数据库连接。
   *
   * 标志在关闭**成功之后**才置：首次关闭失败时再调 close() 是真的重试，
   * 而不是被标志挡成静默成功（文件锁不放这类故障从此没人看得见）。
   */
  close(): void {
    if (this.closed) return
    this.db.close()
    this.closed = true
  }

  /** 解析文档列；读不出来就报「内容损坏」。 */
  private parse(document: string, kind: string, id: string, createdAt: number, updatedAt: number): StorageRecord {
    let data: unknown
    try {
      data = JSON.parse(document)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new StorageCorruptError(`${kind}/${id}`, `不是合法的 JSON（${reason}）`)
    }
    return { id, kind, data, createdAt, updatedAt }
  }
}
