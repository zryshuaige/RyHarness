/**
 * 匿名 id 的生成。
 *
 * id 从**系统随机源**来（`crypto.randomBytes`），不掺任何别的东西：
 * 不取用户名、不取机器名、不取 MAC 地址、不取时间戳、不取路径。
 * 掺进来的每一样都会让「这台机器」的信息跟着 id 跑到外面去。
 *
 * 编码用 base64url：字符集只有 `A-Za-z0-9-_`，可以直接放进 URL、查询串、
 * HTTP 头，不用转义。
 * @module @ryharness/identity/id
 */

import { randomBytes } from 'node:crypto'

/** 随机字节数。24 字节 = 192 位熵，猜不出来。 */
export const ANONYMOUS_ID_BYTES = 24

/** 生成出来的 id 的长度（base64url 编码 24 字节刚好 32 个字符）。 */
export const ANONYMOUS_ID_LENGTH = 32

/** 最短的合法 id 长度。短于这个的不认——那不像是本包生成的。 */
export const ANONYMOUS_ID_MIN_LENGTH = 16

/** 最长的合法 id 长度。 */
export const ANONYMOUS_ID_MAX_LENGTH = 128

/** 随机的来源。测试里换掉它就能得到确定的 id。 */
export type RandomBytes = (byteLength: number) => Uint8Array

/**
 * 合法 id 的形状：URL 安全的字符，且长度在合理区间里。
 *
 * 用「字符集 + 长度」而不是「固定 32 位」来判：万一宿主换了生成器
 * （比如自己加前缀），32 位那个判据会把它判成坏的。
 */
const ANONYMOUS_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ANONYMOUS_ID_MIN_LENGTH},${ANONYMOUS_ID_MAX_LENGTH}}$`)

/**
 * 生成一个匿名 id。
 *
 * 只有随机字节参与：同样的随机源给出同样的 id，换个随机源给出完全不同的 id。
 * @param random - 随机源。默认是 `crypto.randomBytes`。
 * @returns URL 安全的 32 字符 id。
 */
export function generateAnonymousId(random: RandomBytes = randomBytes): string {
  return Buffer.from(random(ANONYMOUS_ID_BYTES)).toString('base64url')
}

/**
 * 这个 id 合不合法。
 * @param value - 待检查的字符串。
 * @returns 合法为 true。
 */
export function isValidAnonymousId(value: string): boolean {
  return ANONYMOUS_ID_PATTERN.test(value)
}
