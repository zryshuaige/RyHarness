/**
 * 键值表后端：在 storage 的记录模型上放「一张表」。
 *
 * ## 为什么要有它
 *
 * `StorageService` 的模型是「一条记录 = 一个 id + 一份 data」。有些数据天生是
 * **一张表**：插件配置（每个插件一条，但整体要一次读出）、工作区列表、文档转换
 * 产物索引。它们不该各自再写一套文件后端——那样每种数据一套落盘格式，出问题时
 * 也无从统一排查。
 *
 * 这一层把「表」摊在存储记录上：**每个 kind 一条记录**，记录里的 `data` 是
 * 「行 id → 行内容」。于是：
 * - 一张表 = 一条记录 = 一个文件（JSON 后端）或一行（SQLite 后端）；
 * - 表的内容仍然是普通 JSON，能被别的工具读懂；
 * - 写入仍然是原子的（后端负责）。
 *
 * ## 与普通记录的差别
 *
 * 普通记录是「一个 id 一份 data」，改一份要写一条；这里的表是「一次读出整张表、
 * 一次写回整张表」。**不要拿它存大量行**——行数一大，整表读写就变成了每次
 * 都要重写全量。表的定位是「几十条以内的小表」。
 *
 * @module @ryharness/storage/kv-table
 */

import { StorageService } from './service.ts'
import type { StorageRecord } from './types.ts'

/** 一张表：行 id → 行内容。 */
export type TableRows<TData = unknown> = Record<string, TData>

/** 一张表在存储里存的那条记录的内容。 */
interface TablePayload<TData = unknown> {
  readonly rows: TableRows<TData>
}

/**
 * 一张表。
 *
 * 用法：`service.table('plugin-settings')` 拿到一张表，`table.all()` 读出全部，
 * `table.set(id, value)` 写一行，`table.remove(id)` 删一行。
 */
export class StorageTable<TData = unknown> {
  /** 底层服务。 */
  readonly #service: StorageService
  /** 分组名。 */
  readonly kind: string
  /** 表自身的记录 id（一张表一条记录）。 */
  readonly #recordId: string

  constructor(service: StorageService, kind: string, recordId = '__table__') {
    this.#service = service
    this.kind = kind
    this.#recordId = recordId
  }

  /** 读出整张表（没有这张表时是空表）。 */
  all(): TableRows<TData> {
    const record = this.#service.get<TablePayload<TData>>(this.kind, this.#recordId)
    const rows = record?.data?.rows
    if (rows === undefined || rows === null || typeof rows !== 'object') return {}
    return { ...rows }
  }

  /** 读一行。 */
  get(id: string): TData | undefined {
    return this.all()[id]
  }

  /**
   * 写一行。
   *
   * **整表写回**：所以这张表不该有大量行（见文件头的说明）。
   * @param id - 行 id。
   * @param value - 行内容。
   */
  set(id: string, value: TData): void {
    if (id.length === 0) throw new Error('存储表的行 id 不能是空串')
    const rows = this.all()
    rows[id] = value
    this.#write(rows)
  }

  /**
   * 写多行（一次写回）。
   * @param entries - 行 id → 行内容。
   */
  setMany(entries: TableRows<TData>): void {
    const rows = this.all()
    for (const [id, value] of Object.entries(entries)) {
      if (id.length === 0) throw new Error('存储表的行 id 不能是空串')
      rows[id] = value
    }
    this.#write(rows)
  }

  /**
   * 删一行。
   *
   * 行本来就没有也算成功（幂等）。
   * @param id - 行 id。
   * @returns 真的删掉了才为 true。
   */
  remove(id: string): boolean {
    const rows = this.all()
    if (!Object.hasOwn(rows, id)) return false
    delete rows[id]
    this.#write(rows)
    return true
  }

  /** 表里现在有几行。 */
  size(): number {
    return Object.keys(this.all()).length
  }

  /** 把整张表写回去。 */
  #write(rows: TableRows<TData>): void {
    this.#service.put<TablePayload<TData>>(this.kind, this.#recordId, { rows })
  }
}

/**
 * 给服务加一个「表」视图。
 *
 * 声明在 `StorageService` 的原型上（模块增强），这样 `service.table('x')` 就能用。
 */
declare module './service.ts' {
  interface StorageService {
    /**
     * 取一张表。
     * @param kind - 分组名。
     * @param recordId - 表自身的记录 id（默认一张表一条）。
     * @returns 表视图。
     */
    table<TData = unknown>(kind: string, recordId?: string): StorageTable<TData>
  }
}

/**
 * 给服务装上 `table()` 方法。
 *
 * **模块加载时执行一次**：用原型上的方法而不是每次 new 一个包装器，实例状态
 * 不落在服务上，包装器也没有可变的部分。
 */
StorageService.prototype.table = function table<TData = unknown>(
  this: StorageService,
  kind: string,
  recordId = '__table__',
): StorageTable<TData> {
  return new StorageTable<TData>(this, kind, recordId)
}

/** 表里那条记录的形状（导出给想直接读后端的场合）。 */
export type { StorageRecord }
