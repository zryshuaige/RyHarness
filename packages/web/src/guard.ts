/**
 * 出站地址的安全闸：私网判定 + 校验放行的地址钉住。
 *
 * 模型能直接影响到的出站请求都从这里过，所以口径写死：
 * - 协议只允许 http/https（file:/ftp: 一律拒）；
 * - 字面地址与 DNS 解析结果都必须落在公网：环回、10/8、172.16/12、192.168/16、
 *   169.254/16、::1、:: 与 IPv4-mapped 形式全部挡掉——不然模型能把这条链路变成
 *   访问本机服务的跳板；
 * - 校验放行的那次解析结果就是连接目标（钉 IP）：连接层不再做第二次 DNS。否则
 *   一条短 TTL 记录可以在「校验通过」与「真正建连」之间换成 127.0.0.1，
 *   也就是 DNS rebinding，内网正文会顺着这条链路进模型上下文；
 * - 每一跳重定向都要重来一遍（见 fetch.ts），不能「先放行首跳、再看最终 URL」。
 *
 * 为什么自己写一份，而不用 apps/server 的 web-read 插件：那个文件是服务端插件，
 * import 它会让这个包反过来依赖 apps/server（依赖方向反了），而且它的判定会跟着
 * 服务端插件一起改——这里要的是一份能被单独测试、单独复用的判定。两边口径一致，
 * 但实现形状不同：本文件把地址先折成数字再比区间，web-read 用的是逐条 if 判断。
 * @module @ryharness/web/guard
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebError } from './types.ts'

/** 解析主机名到地址列表。生产走 node:dns，测试注入固定结果。 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>

/** 一次校验的结论。 */
export interface SafeTarget {
  /** 校验通过的那个 URL。 */
  url: URL
  /**
   * 校验放行的地址：连接必须钉在它上面。
   *
   * 少了它就等于回到「连接层再解析一次」的老路，而第二次解析正是 rebinding 的
   * 落脚点，所以取回器收到没有钉子的请求要直接拒绝。
   */
  ip: string
}

/** IPv4 的闭区间：段位折成数字后比较，规则一眼看得完。 */
interface V4Range {
  from: number
  to: number
}

/** 点分四段 → 32 位数；不是合法 IPv4 返回 undefined（域名与 IPv6 走别的分支）。 */
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

/** 折一段区间；参数写错时退化成空区间（from > to），不会误放行。 */
function v4Range(from: string, to: string): V4Range {
  const start = ipv4ToNumber(from)
  const end = ipv4ToNumber(to)
  return { from: start ?? 0, to: end ?? -1 }
}

/**
 * 私网段位：与 apps/server 的 web-read 同一份清单。
 *
 * 0/8（本网络）、10/8、127/8（环回）、169.254/16（链路本地）、172.16/12、
 * 192.168/16。这里只列必须挡的，公网段一律放行。
 */
const PRIVATE_V4: readonly V4Range[] = [
  v4Range('0.0.0.0', '0.255.255.255'),
  v4Range('10.0.0.0', '10.255.255.255'),
  v4Range('127.0.0.0', '127.255.255.255'),
  v4Range('169.254.0.0', '169.254.255.255'),
  v4Range('172.16.0.0', '172.31.255.255'),
  v4Range('192.168.0.0', '192.168.255.255'),
]

/** 32 位数落在私网区间里吗。 */
function isPrivateV4Number(value: number): boolean {
  return PRIVATE_V4.some((entry) => value >= entry.from && value <= entry.to)
}

/**
 * 一段文本 → 若干个 16 位组。
 *
 * 末尾的点分四段写法（::ffff:127.0.0.1）在这里折成两组，于是 IPv4-mapped 形式
 * 和普通 IPv6 走同一条判定路径。
 */
function splitGroups(text: string): number[] | undefined {
  if (text.length === 0) return []
  const groups: number[] = []
  for (const piece of text.split(':')) {
    if (piece.includes('.')) {
      const value = ipv4ToNumber(piece)
      if (value === undefined) return undefined
      groups.push((value >>> 16) & 0xffff, value & 0xffff)
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
    groups.push(Number.parseInt(piece, 16))
  }
  return groups
}

/**
 * IPv6 → 8 个 16 位组；解析不了返回 undefined。
 *
 * 自己展开 `::` 压缩写法，是因为 IPv4-mapped（::ffff:127.0.0.1）藏在压缩写法里，
 * 按正则拆组拆不准，展开成 8 组之后「前 5 组为 0、第 6 组是 ffff」一眼可辨。
 */
function parseIpv6(address: string): number[] | undefined {
  let text = address
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  const compression = text.indexOf('::')
  let groups: number[]
  if (compression >= 0) {
    const head = splitGroups(text.slice(0, compression))
    const tail = splitGroups(text.slice(compression + 2))
    if (head === undefined || tail === undefined) return undefined
    const missing = 8 - head.length - tail.length
    if (missing < 1) return undefined
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail]
  } else {
    const all = splitGroups(text)
    if (all === undefined || all.length !== 8) return undefined
    groups = all
  }
  return groups.length === 8 ? groups : undefined
}

/** IPv6 的私网判定。 */
function isPrivateIpv6(groups: number[]): boolean {
  const first = groups[0] ?? 0
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // fc00::/7（唯一本地）与 fe80::/10（链路本地）。
  if (first >= 0xfc00 && first <= 0xfdff) return true
  if (first >= 0xfe80 && first <= 0xfebf) return true
  // 宽松口径：首组写成 fc/fd/fe8..feb 开头的都当私网。
  // apps/server 的 web-read 用前缀正则判，这边按首组的十六进制判——两边的答案要一样，
  // 不然同一台机器上「read_url 放行、web_fetch 拒绝」这种事没法排查。
  const head = first.toString(16)
  if (head.startsWith('fc') || head.startsWith('fd')) return true
  if (head.startsWith('fe8') || head.startsWith('fe9')) return true
  if (head.startsWith('fea') || head.startsWith('feb')) return true
  // IPv4-mapped / IPv4-compatible：前 5 组为 0、第 6 组是 ffff（或 0），
  // 后 32 位就是一个 IPv4 地址，按 IPv4 的表判。
  const mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)
  if (mapped) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return isPrivateV4Number(((high << 16) >>> 0) + low)
  }
  return false
}

/** 去掉 IPv6 字面量的方括号与末尾的点，统一成小写。 */
export function normalizeHost(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

/**
 * 这个地址是不是本机或内网。
 *
 * 字面量与域名都走这里：域名要等解析出地址才知道落在哪一段，只看域名是看不出来的。
 * @param address - IPv4、IPv6 或任意主机名。
 * @returns 落在本机/内网段位上返回 true。
 */
export function isPrivateAddress(address: string): boolean {
  const host = normalizeHost(address)
  if (host.length === 0) return false
  const v4 = ipv4ToNumber(host)
  if (v4 !== undefined) return isPrivateV4Number(v4)
  const v6 = parseIpv6(host)
  if (v6 !== undefined) return isPrivateIpv6(v6)
  return false
}

/**
 * 校验一个 URL 能不能抓，并带回本次连接要钉住的地址。
 *
 * 对域名会先解析再逐个检查：只查字面量的话，指向 192.168 的域名会被直接放行。
 * 解析结果里只要有一个落在内网，整条都拒——多 A 记录里混一个内网地址，
 * 交给 DNS 挑就等于把选择权交给了攻击者。
 * @param raw - 待抓取的 URL。
 * @param resolve - 主机名解析器。
 * @returns 校验通过的目标与钉子。
 * @throws WebError 之外的 Error，消息为中文（协议不对、私网、解析失败）。
 */
export async function resolveSafeTarget(raw: string, resolve: HostResolver): Promise<SafeTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebError('链接格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError('只允许 http/https 链接')
  }
  const host = normalizeHost(url.hostname)
  if (host.length === 0) throw new WebError('链接缺少主机名')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new WebError(`拒绝访问本机或内网地址：${host}`)
  }
  if (isPrivateAddress(host)) {
    throw new WebError(`拒绝访问本机或内网地址：${host}`)
  }
  // 字面 IP 不查 DNS：钉子就是它自己。
  if (isIP(host) !== 0) return { url, ip: host }
  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new WebError(`无法解析主机名：${host}`)
  }
  if (addresses.length === 0) throw new WebError(`无法解析主机名：${host}`)
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new WebError(`拒绝访问本机或内网地址：${host}`)
    }
  }
  const first = addresses[0]
  if (first === undefined) throw new WebError(`无法解析主机名：${host}`)
  return { url, ip: first }
}

/**
 * 默认解析器：node:dns 的全部 A/AAAA 记录。
 *
 * 用 all: true 一次拿全，是为了让「某个记录落在内网」这件事在同一次校验里就能发现；
 * 只取第一条等于让 DNS 决定我们连哪个地址。
 */
export const defaultResolveHost: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}
