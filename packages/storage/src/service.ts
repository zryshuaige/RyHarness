/**
 * 存储服务：把「记录长什么样」与「记录存到哪去」分开。
 *
 * 底下是 {@link StorageBackend}——只管存与取，不懂业务：时间戳、形状校验、
 * 变更通知都在这一层做。加一个后端（比如换成远端 KV）不用重写业务代码。
 *
 * 三件事：
 * - **分组**：记录按 `kind` 分组，`list(kind)` 拿一组，`kinds()` 拿全部分组名。
 * - **形状**：声明过形状的 kind，写入时按形状校验，不合就报出是哪个字段不对。
 * - **通知**：写入与删除之后通知订阅者，宿主据此刷新界面。
 *
 * 多后端时按 kind 路由：{@link StorageService.route} 把某个 kind 指给某个后端，
 * 没指过的走第一个注册的后端。
 * @module @ryharness/storage/service
 */

import { assertShape } from './domain.ts'
import { StorageDomain } from './storage-domain.ts'
import type { DomainShape, StorageBackend, StorageChangeEvent, StorageRecord } from './types.ts'

/** 存储服务的配置。 */
export interface StorageServiceOptions {
  /** 后端清单。第一个注册的是缺省后端。 */
  readonly backends?: readonly StorageBackend[]
  /** kind → 后端名。写在 {@link StorageServiceOptions.backends} 之后生效。 */
  readonly routes?: Readonly<Record<string, string>>
  /** 时钟。默认 `Date.now`；测试里换成固定值好断言时间戳。 */
  readonly now?: () => number
}

/** 变更订阅者。返回的函数用来退订。 */
export type StorageChangeListener = (event: StorageChangeEvent) => void

/**
 * 存储服务。
 *
 * 同步接口：后端都是同步的（文件与 SQLite 的同步 API），没必要为了异步而异步。
 */
export class StorageService {
  private readonly backends = new Map<string, StorageBackend>()
  private readonly routes = new Map<string, string>()
  private readonly shapes = new Map<string, DomainShape>()
  private readonly listeners = new Set<StorageChangeListener>()
  private readonly now: () => number

  constructor(options: StorageServiceOptions = {}) {
    this.now = options.now ?? Date.now
    for (const backend of options.backends ?? []) this.register(backend)
    for (const [kind, backendName] of Object.entries(options.routes ?? {})) this.route(kind, backendName)
  }

  /**
   * 注册一个后端。
   * @param backend - 后端。同名的后端不许注册两次——那会让路由指向谁变得说不清。
   */
  register(backend: StorageBackend): void {
    if (this.backends.has(backend.name)) {
      throw new Error(`存储后端名重复：${backend.name}`)
    }
    this.backends.set(backend.name, backend)
  }

  /**
   * 把某个 kind 指给某个后端。
   * @param kind - 分组名。
   * @param backendName - 后端名（注册时用的那个）。
   */
  route(kind: string, backendName: string): void {
    if (!this.backends.has(backendName)) {
      throw new Error(`存储后端不存在：${backendName}`)
    }
    this.routes.set(kind, backendName)
  }

  /**
   * 某个 kind 该落到哪个后端。
   * @param kind - 分组名。
   * @returns 后端。没路由过的走第一个注册的后端。
   */
  backendFor(kind: string): StorageBackend {
    const routed = this.routes.get(kind)
    if (routed !== undefined) {
      const backend = this.backends.get(routed)
      if (backend !== undefined) return backend
    }
    const fallback = this.backends.values().next().value
    if (fallback === undefined) throw new Error('存储服务还没有任何后端')
    return fallback
  }

  /**
   * 按 id 取一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id（同一个 kind 内唯一）。
   * @returns 记录；没有就是 `undefined`。
   */
  get<TData = unknown>(kind: string, id: string): StorageRecord<TData> | undefined {
    const record = this.backendFor(kind).get(kind, id)
    if (record === undefined) return undefined
    return record as StorageRecord<TData>
  }

  /**
   * 写一条记录（不存在就建，存在就覆盖）。
   *
   * `createdAt` 在覆盖时保持不变，`updatedAt` 每次都刷新——
   * 「什么时候建的」与「什么时候改的」是两件事，混成一个就答不上来了。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @param data - 业务数据。声明过形状时会先按形状校验。
   * @returns 落盘后的记录。
   */
  put<TData = unknown>(kind: string, id: string, data: TData): StorageRecord<TData> {
    assertUsable(kind, id)
    const shape = this.shapes.get(kind)
    if (shape !== undefined) assertShape(kind, shape, data)
    const backend = this.backendFor(kind)
    const existing = backend.get(kind, id)
    const at = this.now()
    const record: StorageRecord<TData> = {
      id,
      kind,
      data,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    backend.put(record)
    this.emit({ type: existing === undefined ? 'created' : 'updated', kind, id, record })
    return record
  }

  /**
   * 删一条记录。
   * @param kind - 分组名。
   * @param id - 记录 id。
   * @returns 真的删掉了才为 true（本来就没有也算成功）。
   */
  remove(kind: string, id: string): boolean {
    assertUsable(kind, id)
    const removed = this.backendFor(kind).remove(kind, id)
    if (removed) this.emit({ type: 'deleted', kind, id })
    return removed
  }

  /**
   * 列出某个 kind 下的全部记录。
   * @param kind - 分组名。
   * @returns 记录列表，按创建时间、再按 id 排。
   */
  list<TData = unknown>(kind: string): StorageRecord<TData>[] {
    return this.backendFor(kind)
      .list(kind)
      .map((record) => record as StorageRecord<TData>)
  }

  /**
   * 列出当前存着的全部分组。
   * @returns 分组名列表，按名字排。
   */
  kinds(): string[] {
    const all = new Set<string>()
    for (const backend of this.backends.values()) {
      for (const kind of backend.kinds()) all.add(kind)
    }
    return [...all].sort()
  }

  /**
   * 声明某个 kind 的形状，并拿到它的领域视图。
   *
   * 声明之后，**所有**写向这个 kind 的入口都受形状管着——
   * 校验放在服务这一层而不是视图里，免得绕过视图写进去就没人拦。
   * @param kind - 分组名。
   * @param shape - 这个 kind 的字段形状。
   * @returns 该 kind 的领域视图。
   */
  domain<TData = unknown>(kind: string, shape: DomainShape): StorageDomain<TData> {
    this.shapes.set(kind, shape)
    return new StorageDomain<TData>(this, kind)
  }

  /**
   * 订阅变更。
   * @param listener - 变更回调。
   * @returns 退订函数。
   */
  subscribe(listener: StorageChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 关闭所有后端（关文件、关数据库连接）。 */
  close(): void {
    for (const backend of this.backends.values()) backend.close()
  }

  /** 把变更通知给订阅者。 */
  private emit(event: StorageChangeEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/**
 * kind 与 id 得能用。
 *
 * id 空着会让后端没法给这条记录一个位置（文件后端里会拼出一个怪文件名），
 * kind 空着则连分组都算不上。
 */
function assertUsable(kind: string, id: string): void {
  if (kind.length === 0) throw new Error('存储的 kind 不能是空串')
  if (id.length === 0) throw new Error('存储的 id 不能是空串')
}
