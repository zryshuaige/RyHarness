/**
 * 主机名校验与目标串拼装。
 *
 * **为什么主机名要校验**：ssh 的命令行是 `ssh [选项] 目标 [命令]`。目标串如果以 `-` 开头，
 * ssh 会把它当选项——`ssh -oProxyCommand=... 主机` 就是这么变成任意命令执行的。
 * 所以凡是能进 argv 的外部字符串，都要先过这一道。
 *
 * 判据（一条不过就报 `INVALID_HOST`）：
 * - 非空、不超过 255 字符；
 * - 不以 `-` 开头（会被当成选项）；
 * - 只允许字母、数字与 `. - _ @ : [ ] %`（**不含 `=`**：`=` 是选项注入的标志）；
 * - `@` 至多一个（`user@host`）。
 * @module @ryharness/ssh/host
 */

import { SshError } from './errors.ts'

/** 主机名允许的字符集：不含 `=`、空白与控制字符。 */
const HOST_PATTERN = /^[A-Za-z0-9._:@[\]%-]+$/

/** 用户名允许的字符集。 */
const USER_PATTERN = /^[A-Za-z0-9._-]+$/

/** 主机名最长多少字符（DNS 名上限 253，留一点余量给 `user@`）。 */
const MAX_HOST_LENGTH = 255

/** 一个校验通过的目标。 */
export interface SshTarget {
  /** 交给 ssh 的目标串（`user@host` 或 `host`）。 */
  readonly destination: string
  /** 主机名部分（不含 `user@`）。 */
  readonly host: string
  /** 用户名部分（没有就是 undefined）。 */
  readonly user?: string
}

/**
 * 校验一个主机名，非法就抛错。
 * @param host - 待校验的主机名（可以带 `user@`）。
 * @returns 校验通过的主机名（原样返回，方便链式使用）。
 */
export function validateSshHost(host: string): string {
  if (host.length === 0) {
    throw new SshError('INVALID_HOST', '主机名不能为空。')
  }
  if (host.length > MAX_HOST_LENGTH) {
    throw new SshError('INVALID_HOST', `主机名太长了（${host.length} 字符，上限 ${MAX_HOST_LENGTH}）。`)
  }
  if (host.startsWith('-')) {
    throw new SshError('INVALID_HOST', `主机名不能以 "-" 开头（会被 ssh 当成选项）：${host}`)
  }
  if (!HOST_PATTERN.test(host)) {
    throw new SshError('INVALID_HOST', `主机名含有不允许的字符（只允许字母、数字与 . - _ @ : [ ] %）：${host}`)
  }
  const atCount = host.split('@').length - 1
  if (atCount > 1) {
    throw new SshError('INVALID_HOST', `主机名里最多只能有一个 "@"：${host}`)
  }
  return host
}

/**
 * 拆出主机名里的用户名（`user@host` → `user`）。
 * @param host - 主机名。
 * @returns 用户名；没有就是 undefined。
 */
export function userFromHost(host: string): string | undefined {
  const index = host.indexOf('@')
  if (index < 0) return undefined
  return host.slice(0, index)
}

/**
 * 拼出交给 ssh 的目标串。
 *
 * 用户名可以写在 `host` 里（`user@host`），也可以单独给 `user`；两处都有而且不一致就报错
 * （静默取一个会让「连错账号」这种事很难查）。
 * @param options - 主机名与可选用户名。
 * @returns 目标信息。
 */
export function buildSshTarget(options: { readonly host: string; readonly user?: string }): SshTarget {
  const host = validateSshHost(options.host)
  const hostUser = userFromHost(host)
  const bareHost = hostUser === undefined ? host : host.slice(host.indexOf('@') + 1)
  if (bareHost.length === 0) {
    throw new SshError('INVALID_HOST', `主机名里没有主机部分：${options.host}`)
  }
  const user = options.user ?? hostUser
  if (user !== undefined && !USER_PATTERN.test(user)) {
    throw new SshError('INVALID_HOST', `用户名含有不允许的字符：${user}`)
  }
  if (options.user !== undefined && hostUser !== undefined && options.user !== hostUser) {
    throw new SshError('INVALID_HOST', `用户名给了两处而且不一样：host 里是 ${hostUser}，另外给的是 ${options.user}。`)
  }
  return {
    destination: user === undefined ? bareHost : `${user}@${bareHost}`,
    host: bareHost,
    ...(user === undefined ? {} : { user }),
  }
}
