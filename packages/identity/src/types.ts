/**
 * 匿名安装标识：一次安装一个 id，认得出「同一台安装」，认不出「是谁」。
 *
 * 用途很窄：遥测、反馈、请求头上挂一个 id，让「从同一个安装发出去的东西」
 * 能被认出是同一份。不为别的。
 *
 * **不含任何个人信息**：不取用户名、不取机器名、不取 MAC 地址。
 * id 只来自系统随机源（`crypto.randomBytes`），机器上换个用户、换张网卡、
 * 改个主机名，它都一样。
 *
 * 生命周期：
 * - 第一次用的时候生成，落进应用数据目录；
 * - 同一个安装反复读都是同一个 id；
 * - 把那个文件删掉，就重新生成一个（新的安装视角）。
 * @module @ryharness/identity
 */

/**
 * 一次安装的身份。
 *
 * `createdAt` 是这个 id **生成**的时间（毫秒），不是最后一次读的时间——
 * 反复读不会让它变。
 */
export interface InstallationIdentity {
  /** 这次安装的匿名 id。 */
  readonly id: string
  /** id 生成的时间（毫秒）。 */
  readonly createdAt: number
}

/** 身份存储的配置。 */
export interface IdentityStoreOptions {
  /** 应用数据目录。id 文件落在这里。 */
  readonly dataDir: string
  /** id 文件名。默认 `installation-id.json`。 */
  readonly fileName?: string
  /** id 的生成器。默认用系统随机源；测试里换成固定值好断言。 */
  readonly newId?: () => string
  /** 时钟。默认 `Date.now`。 */
  readonly now?: () => number
}
