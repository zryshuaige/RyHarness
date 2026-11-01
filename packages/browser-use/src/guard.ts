/**
 * 出站地址的安全闸：协议白名单 + 本机/内网判定。
 *
 * **为什么自己写一份，而不从 `@ryharness/web` 拿**：那个包的闸是为「自己抓 HTTP」
 * 设计的——它要把校验放行的 IP 钉在连接上、每跳重定向重来一遍。而这里驱动的是
 * **别人写的浏览器**：连接发生在浏览器进程里，我们既钉不住 IP，也看不见重定向。
 * 能做的只有「动手之前先看一眼这个地址安不安全」——这是一道**前置闸**，不是
 * packages/web 那种连接级闸，两者职责不同、强度也不同，混用会给出「已经防住了」
 * 的错觉。两边的**判定口径保持一致**（同一份私网段位清单、同一套协议白名单），
 * 但实现各写各的：本文件靠 URL 规范化后的字面地址判定，不做 DNS 解析。
 *
 * 口径：
 * - 协议只允许 http/https（file: / ftp: / data: 一律拒）；
 * - 字面地址必须落在公网：环回、10/8、172.16/12、192.168/16、169.254/16、
 *   ::1、:: 与 IPv4-mapped 形式全部挡掉——不然模型能把这条链路变成访问本机
 *   服务的跳板；
 * - 主机名先看字面量（localhost、*.localhost、以及任何解析出来的私网 IP），
 *   拿不准就按「已解析到私网」处理（`isPrivateHost` 的第三个返回值）。
 *
 * 已知边界（README 里也写了）：这是前置判定，不是连接级判定。浏览器自己会做
 * DNS 解析与跳转，中间仍可能发生 DNS rebinding。要彻底防住需要浏览器侧配合
 * （比如让驱动只连已校验的 IP），那属于宿主接驱动时的事。
 * @module @ryharness/browser-use/guard
 */

import { BrowserUseError } from './errors.ts'
import type { HostResolver } from './types.ts'

/**
 * 一段 IPv4 位模式（网络号 + 前缀长度）。
 *
 * 与「起始 IP ~ 结束 IP」的区间写法相比，位模式只要一份地址就够，段位增减不用
 * 改两头。IPv4 一共 32 位，前缀长度写死 0~32。
 */
interface V4Pattern {
  /** 网络号（点分四段折成的 32 位数）。 */
  readonly base: number
  /** 前缀长度（位）。 */
  readonly bits: number
}

/** 点分四段 → 32 位数；不是合法 IPv4 返回 undefined。 */
function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/** 折一段位模式。 */
function v4Pattern(address: string, bits: number): V4Pattern {
  return { base: ipv4ToNumber(address) ?? 0, bits }
}

/**
 * 本机与内网的 IPv4 段位。
 *
 * 与 `packages/web` 的清单一致：0/8（本网络）、10/8、127/8（环回）、
 * 169.254/16（链路本地）、172.16/12、192.168/16。这里只列必须挡的，公网段
 * 一律放行。
 */
const PRIVATE_V4: readonly V4Pattern[] = [
  v4Pattern('0.0.0.0', 8),
  v4Pattern('10.0.0.0', 8),
  v4Pattern('127.0.0.0', 8),
  v4Pattern('169.254.0.0', 16),
  v4Pattern('172.16.0.0', 12),
  v4Pattern('192.168.0.0', 16),
]

/** 取低 bits 位，其余清零。bits=0 时返回 0。 */
function lowBits(value: number, bits: number): number {
  if (bits <= 0) return 0
  const shift = 32 - bits
  return (value >>> shift) << shift
}

/** 这个 32 位数落在某个段位里吗。 */
function matchesV4(value: number, pattern: V4Pattern): boolean {
  return lowBits(value, pattern.bits) === lowBits(pattern.base, pattern.bits)
}

/**
 * 规范化后的 IPv6 → 8 个 16 位组；不是合法 IPv6 返回 undefined。
 *
 * 只吃**已经规范化过**的形式（`URL.hostname` 给的就是这种：零段被压成 `::`，
 * 每组不带前导零）。所以解析比通用解析简单：要么有 `::`，要么正好 8 组。
 *
 * 末尾带点分四段的写法（`::ffff:127.0.0.1`）单独处理：把最后两段折成两个
 * 16 位组。少了这一步，IPv4-mapped 这种最常见的内网伪装形式会被当成普通公网
 * IPv6 放过去。
 */
function parseCanonicalIpv6(host: string): number[] | undefined {
  let text = host
  // 末尾的点分四段 → 两个 16 位组。
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':')
    if (cut < 0) return undefined
    const tail = text.slice(cut + 1)
    const value = ipv4ToNumber(tail)
    if (value === undefined) return undefined
    text = `${text.slice(0, cut + 1)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const toGroups = (part: string): number[] => {
    if (part.length === 0) return []
    const groups: number[] = []
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return []
      groups.push(Number.parseInt(piece, 16))
    }
    return groups
  }
  const head = toGroups(halves[0] ?? '')
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const tail = toGroups(halves[1] ?? '')
  const missing = 8 - head.length - tail.length
  if (missing < 1) return undefined
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

/**
 * 这个 IPv6 是不是本机或内网。
 * @param host - 规范化后的 IPv6 字面量（不带方括号）。
 * @returns 落在本机/内网段位上返回 true。
 */
function isPrivateIpv6(host: string): boolean {
  const groups = parseCanonicalIpv6(host)
  if (groups === undefined) return false
  const first = groups[0] ?? 0
  // 全部为 0：未指定地址（::）。
  if (groups.every((group) => group === 0)) return true
  // 前 7 组为 0、第 8 组为 1：环回（::1）。
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // fc00::/7：唯一本地地址。
  if ((first & 0xfe00) === 0xfc00) return true
  // fe80::/10：链路本地地址。
  if ((first & 0xffc0) === 0xfe80) return true
  // IPv4-mapped（::ffff:a.b.c.d）：后 32 位就是一个 IPv4 地址，按 IPv4 的表判。
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (mapped) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return isPrivateV4Number(((high << 16) >>> 0) + low)
  }
  return false
}

/** 这个 32 位数落在 IPv4 私网段位里吗。 */
function isPrivateV4Number(value: number): boolean {
  return PRIVATE_V4.some((pattern) => matchesV4(value, pattern))
}

/**
 * 这个地址是不是本机或内网（IPv4 / IPv6 字面量）。
 * @param address - IPv4 或 IPv6 字面量。
 * @returns 落在本机/内网段位上返回 true。
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host.length === 0) return false
  const v4 = ipv4ToNumber(host)
  if (v4 !== undefined) return isPrivateV4Number(v4)
  if (!host.includes(':')) return false
  return isPrivateIpv6(host)
}

/** 这个主机名本身就是 IP 字面量吗（IPv4 或 IPv6，带不带方括号都算）。 */
function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '')
  return ipv4ToNumber(bare) !== undefined || bare.includes(':')
}

/** 主机名的判定结论。 */
export type HostVerdict =
  /** 落在公网，可以去。 */
  | 'public'
  /** 本机或内网，不许去。 */
  | 'private'
  /** 解析不出地址（拿不准，按不许处理）。 */
  | 'unknown'

/**
 * 判定一个主机名能不能去。
 *
 * 三种结论而不是两种：解析失败单独一档，是因为「解析不出来」和「解析到内网」
 * 的处理不该一样——前者可能是网络抖动，后者是实打实的内网地址。拿不准时按
 * `private` 处理（宁可不去）。
 * @param host - 主机名（已去掉方括号）。
 * @param resolve - 解析器。
 * @returns 判定结论。
 */
export async function judgeHost(host: string, resolve: HostResolver): Promise<HostVerdict> {
  if (host.length === 0) return 'unknown'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'private'
  if (isPrivateAddress(host)) return 'private'
  // IP 字面量不用查 DNS：它指向哪就是哪。
  if (isIpLiteral(host)) return 'public'
  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch {
    return 'unknown'
  }
  if (addresses.length === 0) return 'unknown'
  for (const address of addresses) {
    if (isPrivateAddress(address)) return 'private'
  }
  return 'public'
}

/**
 * 校验一个地址能不能用。
 *
 * 放行之前先过协议白名单，再过主机判定。两道闸各自给出不同的错误码：协议不对
 * 与「指向内网」要分开，排查时能一眼看出是哪一条拦的。
 * @param raw - 待打开的地址。
 * @param options - 判定用的依赖与开关。
 * @returns 校验通过的 URL。
 * @throws BrowserUseError 协议不被允许（UNSAFE_URL）或指向本机内网（PRIVATE_ADDRESS）。
 */
export async function assertNavigableUrl(
  raw: string,
  options: { readonly allowPrivateNetwork: boolean; readonly resolveHost: HostResolver },
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BrowserUseError('UNSAFE_URL', `地址格式不正确：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserUseError('UNSAFE_URL', `只允许 http/https 地址，不允许 ${url.protocol}`)
  }
  if (options.allowPrivateNetwork) return url
  const host = url.hostname.toLowerCase()
  const verdict = await judgeHost(host, options.resolveHost)
  if (verdict === 'private') {
    throw new BrowserUseError('PRIVATE_ADDRESS', `拒绝访问本机或内网地址：${host}`)
  }
  if (verdict === 'unknown') {
    throw new BrowserUseError('PRIVATE_ADDRESS', `无法确认主机名是否安全，拒绝对 ${host} 的访问`)
  }
  return url
}
