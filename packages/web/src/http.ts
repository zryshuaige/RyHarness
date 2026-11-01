/**
 * 出站取回器：把「校验放行的地址」钉在连接上。
 *
 * 不用全局 fetch 的理由只有一个——它没法把连接固定在某次解析的结果上，校验与建连
 * 必然是两次独立解析，中间就是 DNS rebinding 的窗口。这里把 fetch 的语义换成
 * 「按钉子建连、按原域发 Host 与 SNI、正文按字节上限读回来」。
 *
 * 取回器返回的是自己的响应形状（状态、头、Buffer 正文），不是 Response：正文在
 * 传输层就被字节上限截断了，拿到的是一个 Buffer 而不是流，少一层流类型要伺候，
 * 也不必在两套流 API 之间做类型转换。
 * @module @ryharness/web/http
 */

import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { RequestOptions } from 'node:https'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

/** 出站请求参数。 */
export interface HttpRequestInit {
  /** 请求方法，默认 GET。 */
  method?: string
  /** 请求头。Host 头会被忽略：连接目标钉的是 IP，但服务器看到的必须是原域名。 */
  headers?: Record<string, string>
  /** 请求体（字符串）。 */
  body?: string
  /** 取消信号。 */
  signal?: AbortSignal
}

/** 一次出站请求的响应。 */
export interface HttpResponse {
  /** 状态码。 */
  status: number
  /**
   * 响应头，名字一律小写。
   *
   * 值允许是 undefined：某个头没出现时就是没出现，写成 string 会让「这个头在不在」
   * 变成一个编译器看不出来的判断。
   */
  headers: Record<string, string | undefined>
  /** 正文。 */
  body: Buffer
  /** 正文是否因为超过字节上限而被截断。 */
  truncated: boolean
}

/**
 * 取回器。
 *
 * 第三个参数是「钉子」：校验阶段放行的那个地址。缺钉子直接拒绝——没有钉子就等于
 * 回到「连接层再解析一次」的老路，而第二次解析正是 rebinding 的落脚点。
 */
export type PinnedFetch = (url: string, init?: HttpRequestInit, pin?: string) => Promise<HttpResponse>

/** 出站请求的 User-Agent：让对端知道来路，也便于对方按需放行。 */
export const DEFAULT_USER_AGENT = 'RyHarness/0.3 (+https://github.com/zryshuaige/RyHarness)'

/** 默认响应体上限（字节）。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** 去掉 IPv6 字面量的方括号与末尾的点。 */
function bareHost(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

/**
 * 造一跳「钉在已校验地址上」的请求参数。
 *
 * - 连接目标写字面 IP：net 层对字面地址不做 DNS，连接目标没有第二次解析；
 * - TLS 的 servername 与 Host 头仍是原域名：SNI 与证书校验按域名走，服务器看到的
 *   请求与普通浏览器请求一致（否则虚拟主机与 CDN 会认不出这个请求）；
 * - lookup 再钉一道：万一有哪一层（代理、重试、未来的重构）又拿域名去解析，
 *   交给连接的地址也仍然只有已校验的那一个。
 * @param target - 要请求的 URL。
 * @param ip - 已校验放行的地址。
 * @param init - 方法、请求头与请求体。
 * @returns 交给 node:http / node:https 的请求参数。
 */
export function buildRequestOptions(target: URL, ip: string, init: HttpRequestInit | undefined): RequestOptions {
  const headers: Record<string, string> = {
    host: target.host,
    accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
    'user-agent': DEFAULT_USER_AGENT,
  }
  for (const [name, value] of Object.entries(init?.headers ?? {})) {
    const key = name.toLowerCase()
    // Host 头必须是原域名：钉 IP 只改连接目标，不改服务器看到的域名。
    if (key === 'host') continue
    headers[key] = value
  }
  const options: RequestOptions = {
    protocol: target.protocol,
    hostname: ip,
    path: `${target.pathname}${target.search}`,
    method: init?.method ?? 'GET',
    headers,
    lookup: (_hostname, lookupOptions, callback) => {
      callback(null, ip, lookupOptions.family === 6 ? 6 : 4)
    },
  }
  // 缺省端口不硬编码：交给协议自己决定（http 80、https 443）。
  if (target.port !== '') options.port = Number(target.port)
  const host = bareHost(target.hostname)
  // IP 直连的地址不发 SNI（RFC 6066 不允许），域名才发。
  if (isIP(host) === 0) options.servername = host
  return options
}

/**
 * 把响应读成（状态、头、正文），正文超过上限就截断并停掉这次下载。
 *
 * 截断时直接收尾：继续把几兆的正文读回来只为丢掉后半段，是白花时间与带宽。
 */
function readResponse(incoming: IncomingMessage, maxBytes: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | undefined> = {}
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    }
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (truncated: boolean): void => {
      if (settled) return
      settled = true
      resolve({ status: incoming.statusCode ?? 200, headers, body: Buffer.concat(chunks), truncated })
    }
    incoming.on('data', (chunk: Buffer) => {
      if (settled) return
      const remaining = maxBytes - total
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        total = maxBytes
        incoming.destroy()
        finish(true)
        return
      }
      chunks.push(chunk)
      total += chunk.length
    })
    incoming.on('end', () => {
      finish(false)
    })
    incoming.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * 默认取回器：node:http/https + 钉地址。
 * @param maxBytes - 单次响应体上限（字节）。
 * @returns 取回器。
 */
export function createPinnedFetch(maxBytes: number = DEFAULT_MAX_BYTES): PinnedFetch {
  return (url, init, pin) => {
    if (pin === undefined || pin.length === 0) {
      return Promise.reject(new Error('取回器缺少钉住的地址（pin）'))
    }
    const target = new URL(url)
    const options = buildRequestOptions(target, pin, init)
    return new Promise<HttpResponse>((resolve, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(options, (incoming) => {
        void readResponse(incoming, maxBytes).then(resolve, reject)
      })
      request.on('error', reject)
      if (init?.signal !== undefined) {
        init.signal.addEventListener(
          'abort',
          () => {
            request.destroy()
          },
          { once: true },
        )
      }
      if (init?.body !== undefined) request.write(init.body)
      request.end()
    })
  }
}
