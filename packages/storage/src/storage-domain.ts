/**
 * 领域视图：某个 kind 的带类型入口。
 *
 * 它不存东西——存的是 {@link StorageService}，这里的每个方法都转手给它。
 * 视图存在的理由是**类型**：`service.get<WorkspaceData>('workspace', id)` 的
 * 类型参数是调用方自己说的，而视图把这件事固定下来：
 * `domain.get(id)` 回来的 `data` 就是 `TData`，不用每次都重新说一遍。
 *
 * 形状校验不在这里做（在服务那一层），所以绕过视图写进去也照样会被拦。
 * @module @ryharness/storage/storage-domain
 */

import type { StorageService } from './service.ts'
import type { StorageChangeEvent, StorageRecord } from './types.ts'

/**
 * 某个 kind 的带类型视图。
 */
export class StorageDomain<TData = unknown> {
  /**
   * @param service - 底层服务。
   * @param kind - 这个视图管的分组名。
   */
  constructor(
    private readonly service: StorageService,
    readonly kind: string,
  ) {}

  /**
   * 按 id 取一条记录。
   * @param id - 记录 id。
   * @returns 记录；没有就是 `undefined`。
   */
  get(id: string): StorageRecord<TData> | undefined {
    return this.service.get<TData>(this.kind, id)
  }

  /**
   * 写一条记录。
   * @param id - 记录 id。
   * @param data - 业务数据。形状不合会抛 {@link StorageValidationError}。
   * @returns 落盘后的记录。
   */
  put(id: string, data: TData): StorageRecord<TData> {
    return this.service.put<TData>(this.kind, id, data)
  }

  /**
   * 删一条记录。
   * @param id - 记录 id。
   * @returns 真的删掉了才为 true。
   */
  remove(id: string): boolean {
    return this.service.remove(this.kind, id)
  }

  /**
   * 列出这个 kind 下的全部记录。
   * @returns 记录列表。
   */
  list(): StorageRecord<TData>[] {
    return this.service.list<TData>(this.kind)
  }

  /**
   * 订阅这个 kind 的变更。
   * @param listener - 变更回调。
   * @returns 退订函数。
   */
  subscribe(listener: (event: StorageChangeEvent<TData>) => void): () => void {
    return this.service.subscribe((event) => {
      if (event.kind !== this.kind) return
      listener(event as StorageChangeEvent<TData>)
    })
  }
}
