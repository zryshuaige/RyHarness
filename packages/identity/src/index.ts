/**
 * RyHarness 匿名身份：一次安装一个 id。
 *
 * 这个 id 只干一件事：让「从同一个安装发出去的东西」能被认出是同一份。
 * 遥测、反馈、请求头都可以挂它。
 *
 * **不含任何个人信息**：不取用户名、不取机器名、不取 MAC 地址。id 只来自
 * 系统随机源。
 *
 * ```ts
 * import { IdentityStore, defaultDataDir } from '@ryharness/identity'
 *
 * const store = new IdentityStore({ dataDir: defaultDataDir() })
 * const { id, createdAt } = store.ensure()
 * // id 同一个安装一直是同一个；createdAt 是它生成的时间
 * ```
 *
 * 本包**不暴露给模型**：不注册工具、不进提示词、不发任何网络请求。
 * @module @ryharness/identity
 */

export { APP_DIR_NAME, defaultDataDir } from './data-dir.ts'
export type { RandomBytes } from './id.ts'
export {
  ANONYMOUS_ID_BYTES,
  ANONYMOUS_ID_LENGTH,
  ANONYMOUS_ID_MAX_LENGTH,
  ANONYMOUS_ID_MIN_LENGTH,
  generateAnonymousId,
  isValidAnonymousId,
} from './id.ts'
export { IDENTITY_FILE_NAME, IDENTITY_FILE_VERSION, IdentityStore } from './store.ts'
export type { IdentityStoreOptions, InstallationIdentity } from './types.ts'
