/**
 * 存储的契约：记录长什么样、后端要会什么、领域形状怎么声明。
 *
 * 这个文件只放类型（不放任何运行时代码）：形状声明、记录、后端契约三件事
 * 互相引用，谁先谁后无所谓，但放在一起读最省事。
 *
 * 术语：
 * - **记录（record）**：一条落盘的数据，形如 `{ id, kind, data, createdAt, updatedAt }`。
 *   `kind` 是分组名（工作区记录、配置片段、用户偏好各占一个 kind），
 *   `id` 在同一个 kind 内唯一。
 * - **后端（backend）**：记录实际存哪儿的地方。JSON 后端一条记录一个文件，
 *   SQLite 后端一条记录一行。
 * - **领域（domain）**：给某个 kind 套上形状校验与变更通知的视图。
 * @module @ryharness/storage/types
 */

/**
 * 一条存储记录。
 *
 * `createdAt` / `updatedAt` 是毫秒时间戳（同本仓其它包的写法）。
 */
export interface StorageRecord<TData = unknown> {
  /** 同一个 kind 内唯一的 id。 */
  readonly id: string
  /** 分组名。写进去就分好组了，取出来时按它筛。 */
  readonly kind: string
  /** 真正的业务数据。必须能 JSON 序列化。 */
  readonly data: TData
  /** 写入时间（毫秒）。 */
  readonly createdAt: number
  /** 最后一次修改时间（毫秒）。 */
  readonly updatedAt: number
}

/**
 * 存储后端契约。
 *
 * 后端只管存与取，不懂业务：时间戳、校验、通知都在上面的服务与领域层做。
 * 这样加一个后端（比如换成本地 KV 服务）不用重写业务代码。
 */
export interface StorageBackend {
  /** 后端名（如 `json` / `sqlite`）。同一份服务里不重名。 */
  readonly name: string
  /** 取一条；没有就是 `undefined`。 */
  get(kind: string, id: string): StorageRecord | undefined
  /** 写一条（整条覆盖，时间戳由调用方给好）。 */
  put(record: StorageRecord): void
  /** 删一条；本来就没有也算成功（幂等）。 */
  remove(kind: string, id: string): boolean
  /** 列出某个 kind 下的全部记录，按创建时间、再按 id 排。 */
  list(kind: string): StorageRecord[]
  /** 列出当前存着的全部 kind，按名字排。 */
  kinds(): string[]
  /** 释放后端占的资源（关文件、关连接）。 */
  close(): void
}

/** 领域形状里字段的类型。 */
export type DomainFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

/** 一个字段该长什么样。 */
export interface DomainField {
  /** 这个字段要是什么类型。 */
  readonly type: DomainFieldType
  /**
   * 是否必填。
   *
   * 缺省是**必填**：声明了形状就是承诺这份数据长这样，缺字段是写错了。
   * 真的可选就写 `required: false`。
   */
  readonly required?: boolean
}

/**
 * 某个 kind 的形状声明。
 *
 * 字段名 → 字段要求。**没声明的字段也会被拒**：形状是白名单而不是黑名单，
 * 否则拼错的字段名会悄悄存进去，几个月后没人知道它为什么不对。
 */
export interface DomainShape {
  readonly fields: Readonly<Record<string, DomainField>>
}

/** 变更的类型。 */
export type StorageChangeType = 'created' | 'updated' | 'deleted'

/** 一次变更。宿主据此刷新界面。 */
export interface StorageChangeEvent<TData = unknown> {
  /** 这次是新增、修改还是删除。 */
  readonly type: StorageChangeType
  /** 变更发生在哪个 kind。 */
  readonly kind: string
  /** 变更的是哪条记录。 */
  readonly id: string
  /** 变更后的记录（删除时没有）。 */
  readonly record?: StorageRecord<TData>
}
