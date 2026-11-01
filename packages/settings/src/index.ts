/**
 * 插件配置表单：把每个插件自己的配置 schema 变成能填的表单。
 *
 * 三件事：
 * - **描述符**：从一份极小的 schema 推出「这个设置项长什么样」（键路径、控件类型、
 *   中文名、默认值、候选值）。嵌套的配置摊平成点号键路径。
 * - **服务**：登记插件、按 schema 校验改动、版本化、防静默覆盖、落盘。
 * - **热生效**：改完调宿主给的 `apply` 回调把新值应用到活着的插件上；回调抛错就回滚，
 *   不让界面显示新值而插件还跑着旧值。
 *
 * 本包**不碰插件宿主**（怎么把 schema 交给它、怎么把界面接上，由宿主决定），
 * 也**不碰密钥**（插件配置里的密钥归宿主那个加密存储管）。
 * @module @ryharness/settings
 */

export type { SettingsErrorCode } from './errors.ts'
export { describeError, SettingsError } from './errors.ts'
export type { SettingsPropertySchema, SettingsSchema } from './schema.ts'
export { defaultValues, describeSchema } from './schema.ts'
export { SettingsService, type SettingsServiceOptions } from './service.ts'
export type { FileSettingsStoreOptions, SettingsSnapshot, SettingsStore } from './store.ts'
export { FileSettingsStore, MemorySettingsStore } from './store.ts'
export type {
  SettingsDescriptor,
  SettingsFieldType,
  SettingsPluginView,
  SettingsUpdate,
  SettingsValue,
  SettingsValues,
} from './types.ts'
export type { SettingsValidationIssue } from './validate.ts'
export { acceptsValue, validateValues } from './validate.ts'
