/**
 * RyHarness 存储：跨重启的应用数据中枢。
 *
 * 三块：
 * - **契约**（{@link StorageRecord} / {@link StorageBackend}）：记录长什么样、后端要会什么。
 * - **服务**（{@link StorageService}）：分组、形状校验、变更通知都在这一层。
 * - **后端**（{@link JsonBackend} / {@link SqliteBackend}）：只管存与取，不懂业务。
 *
 * 本包处理的是**非会话数据**（工作区记录、配置片段、用户偏好这类）。
 * 会话数据归 `packages/session`——那套有单写者模型与自己的 schema 迁移，
 * 与这里的通用键值存储不是一回事，混在一起两边都难管。
 *
 * 这一族**不暴露给模型**：不注册工具、不进提示词。它是宿主侧的基础设施，
 * 模型通过工具间接用上它就够了。
 * @module @ryharness/storage
 */

export type { DomainIssue } from './domain.ts'
export { assertShape, checkShape, describeType, isPlainObject, matchesType } from './domain.ts'
export { StorageCorruptError, StorageValidationError } from './errors.ts'
export type { JsonBackendOptions } from './json-backend.ts'
export { decodeSegment, encodeSegment, JSON_BACKEND_NAME, JsonBackend } from './json-backend.ts'
export type { TableRows } from './kv-table.ts'
export { StorageTable } from './kv-table.ts'
export type { StorageChangeListener, StorageServiceOptions } from './service.ts'
export { StorageService } from './service.ts'
export type { SqliteBackendOptions } from './sqlite-backend.ts'
export { SQLITE_BACKEND_NAME, SqliteBackend } from './sqlite-backend.ts'
export { StorageDomain } from './storage-domain.ts'
export type {
  DomainField,
  DomainFieldType,
  DomainShape,
  StorageBackend,
  StorageChangeEvent,
  StorageChangeType,
  StorageRecord,
} from './types.ts'
