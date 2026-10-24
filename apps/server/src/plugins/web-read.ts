/**
 * 内置插件：读取网页。
 *
 * `read_url` 把一段 http/https 页面抓成纯文本交给模型。它同时是这台机器上
 * 唯一由模型直接控制出站请求的地方，因此边界要写死：
 * - 协议只允许 http/https（file:/ftp: 等一律拒绝）；
 * - 字面地址与 DNS 结果都必须落在公网：localhost、127/8、::1、10/8、
 *   172.16/12、192.168/16、169.254/16 全部挡掉，避免变成访问本机服务的跳板；
 * - 校验通过的那次解析结果就是连接目标（钉 IP）：默认取回器把已校验 IP 写进
 *   请求参数，连接层不再做第二次 DNS——否则短 TTL 记录可以在「校验通过」与
 *   「真正建连」之间换成 127.0.0.1（DNS rebinding），把内网正文送进模型上下文；
 * - 每一跳重定向都重新校验并重新钉 IP，不能靠「先放行首跳、再看最终 URL」；
 * - 15s 总超时、2MB 响应体、20000 字文本，超出就截断并说明。
 * @module @ryharness/server/plugins/web-read
 */

import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import type { RequestOptions } from 'node:https'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { PluginEntry } from './host.ts'

export const WEB_READ_PLUGIN_ID = 'web-read'

export const READ_URL_TIMEOUT_MS = 15_000
export const READ_URL_MAX_BYTES = 2 * 1024 * 1024
export const READ_URL_MAX_CHARS = 20_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 出站请求的最小接口形状：测试用它注入假响应，生产用钉 IP 的默认取回器。 */
export type FetchLike = (url: string, init?: RequestInit, pin?: UrlPin) => Promise<Response>

/**
 * 本次连接的钉子：`ip` 是校验阶段解析并放行的那个地址。
 *
 * 缺了它就等于回到「fetch 自己再解析一次」的老路——第二次解析正是 rebinding
 * 攻击的落脚点，所以默认取回器收到没有钉子的请求直接拒绝。
 */
export interface UrlPin {
  ip: string
}

/** 连接层的解析入口：生产走 node:dns（只为确定 v4/v6），测试注入「rebinding」脚本。 */
export type ConnectLookup = (
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6' },
) => Promise<{ address: string; family: number }>

/** 解析主机名到地址列表；测试注入固定结果，生产走 node:dns。 */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>

/** 工具返回对象（以 JSON 文本作为工具结果）。 */
export interface ReadUrlResult {
  title?: string
  url: string
  text: string
  truncated: boolean
}

/** `read_url` 可调参数：限额给测试缩小，生产用文件头部的默认值。 */
export interface ReadUrlOptions {
  fetchImpl?: FetchLike
  resolveHost?: ResolveHost
  /** 连接层解析（默认取回器用它确定 v4/v6）；测试注入「第二次返回 127.0.0.1」的脚本。 */
  connectLookup?: ConnectLookup
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
}

const defaultResolveHost: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => {
    return record.address
  })
}

const defaultConnectLookup: ConnectLookup = async (hostname, options) => {
  const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family ?? 0)
  return lookup(hostname, { family, verbatim: true })
}

/**
 * 构造一跳「钉在已校验 IP 上」的请求参数。
 *
 * - `host` 直接用字面 IP：net 层对字面地址不做 DNS，连接目标没有第二次解析；
 * - TLS 的 `servername` 与 Host 头仍是原域名：SNI 与证书校验按域名走，服务器
 *   看到的请求与普通浏览器请求一致（否则虚拟主机与 CDN 会认不出这个请求）；
 * - `lookup` 再钉一道保险：万一有哪一层（代理、重试、未来的重构）又拿域名去
 *   解析，交给连接的地址也仍然只有已校验的那个。DNS 在这里只被允许回答
 *   v4/v6（family），它的地址回答一律丢弃。
 */
export function pinnedRequestOptions(url: URL, ip: string, connectLookup: ConnectLookup): RequestOptions {
  return {
    protocol: url.protocol,
    host: ip,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    servername: normalizeHost(url.hostname),
    headers: { host: url.host },
    lookup: (hostname, options, callback) => {
      connectLookup(hostname, { family: options.family })
        .then((record) => {
          callback(null, ip, record.family)
        })
        .catch((error: unknown) => {
          // 错误分支按 net 的 lookup 回调约定补齐占位参数（err 优先，net 不看后面两个）。
          callback(error instanceof Error ? error : new Error(String(error)), '', 0)
        })
    },
  }
}

/**
 * 默认取回器：node:http/https + 钉 IP。
 *
 * 不用全局 fetch 的原因只有一个——它无法把连接固定在某次解析的结果上，校验与
 * 建连必然是两次独立解析（DNS rebinding 的 TOCTOU）。这里把 fetch 的语义换成
 * 「按 pin 建连、按原域发 Host/SNI、流式拼回标准 Response」，loadPage 的重定向
 * 与限额逻辑不用改。
 */
export function createPinnedFetch(connectLookup: ConnectLookup = defaultConnectLookup): FetchLike {
  return (url, init, pin) => {
    if (pin === undefined) {
      return Promise.reject(new Error('pinned fetch: missing validated IP (pin)'))
    }
    const parsed = new URL(url)
    const options = pinnedRequestOptions(parsed, pin.ip, connectLookup)
    const headers: Record<string, string> = { host: parsed.host }
    // loadPage 传入的 accept/user-agent 等照常带上；host 已钉原域，不被覆盖。
    for (const [name, value] of new Headers(init?.headers)) {
      if (name.toLowerCase() !== 'host') headers[name] = value
    }
    options.headers = headers
    options.signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(options, (incoming) => {
        const headersOut = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) {
            for (const item of value) headersOut.append(name, item)
          } else {
            headersOut.set(name, value)
          }
        }
        const status = incoming.statusCode ?? 200
        // 204/304 按 fetch 语义不允许有响应体；流留着会让 Response 构造直接抛错。
        const bodyless = status === 204 || status === 205 || status === 304
        const stream = bodyless ? null : (Readable.toWeb(incoming) as ReadableStream)
        resolve(new Response(stream, { status, headers: headersOut }))
      })
      request.on('error', reject)
      request.end()
    })
  }
}

/** 去掉 IPv6 字面量的方括号与末尾的点，统一成小写再判断。 */
function normalizeHost(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

/** 点分四段；不是合法 IPv4 返回 undefined（IPv6/域名也走这里返回 undefined）。 */
function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const numbers: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value < 0 || value > 255) return undefined
    numbers.push(value)
  }
  return numbers
}

/**
 * 私网/本机地址判定。
 *
 * 覆盖需求列出的网段，并顺手挡掉 0/8、IPv6 的 ::、fc00::/7、fe80::/10 与
 * IPv4-mapped 形式——它们都是同一类「从外面看起来是个普通地址，实际打回本机/
 * 局域网」的入口。
 */
export function isPrivateAddress(address: string): boolean {
  const host = normalizeHost(address)
  const v4 = ipv4Parts(host)
  if (v4 !== undefined) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (host === '::' || host === '::1') return true
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true
  const mapped = /^::ffff:(.+)$/.exec(host)?.[1] ?? /^(?:0:){5}ffff:(.+)$/.exec(host)?.[1]
  if (mapped !== undefined) {
    const mappedV4 = ipv4Parts(mapped)
    if (mappedV4 !== undefined) return isPrivateAddress(mapped)
    // ::ffff:7f00:1 这类十六进制写法：还原成四段十进制再判。
    const groups = mapped.split(':')
    if (
      groups.length === 2 &&
      /^[0-9a-f]{1,4}$/.test(groups[0] as string) &&
      /^[0-9a-f]{1,4}$/.test(groups[1] as string)
    ) {
      const high = Number.parseInt(groups[0] as string, 16)
      const low = Number.parseInt(groups[1] as string, 16)
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
    }
  }
  return false
}

/** 主机名层面的拒绝：localhost 与各种本地域，不依赖 DNS 结果。 */
function isForbiddenHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return isPrivateAddress(host)
}

/**
 * 校验一个 URL 是否可以抓取，并带回本次连接要钉住的 IP；不通过时抛出带原因的错误。
 *
 * 对域名会先解析再检查每一个地址：只查字面量的话，`http://internal.example`
 * 这种指向 192.168 的域名会直接放行。放行的同时把解析结果交回去——校验用一次
 * 解析、建连用另一次解析，中间就是 DNS rebinding 的窗口；返回 IP 让调用方把
 * 连接钉在上面，窗口不复存在。
 */
async function assertAllowedUrl(raw: string, resolveHost: ResolveHost): Promise<{ url: URL; ip: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('链接格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许 http/https 链接')
  }
  const host = normalizeHost(url.hostname)
  if (isForbiddenHost(host)) {
    throw new Error(`拒绝访问本机或内网地址：${host}`)
  }
  let ip = host
  if (isIP(host) === 0) {
    let addresses: readonly string[]
    try {
      addresses = await resolveHost(host)
    } catch {
      throw new Error(`无法解析主机名：${host}`)
    }
    if (addresses.length === 0) throw new Error(`无法解析主机名：${host}`)
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`拒绝访问本机或内网地址：${host}`)
      }
    }
    ip = addresses[0] as string
  }
  return { url, ip }
}

/** 常用命名实体；不追求完整 HTML5 实体表，覆盖正文里最常见的那些。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
}

/** 基本的 HTML 实体解码（命名 + 十进制 + 十六进制）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * HTML → 标题 + 正文。
 *
 * 不引解析器：输入已被 2MB 上限约束，这里只需要「去掉脚本/样式/导航，按块级
 * 标签断行，解码实体」这一组可预测的动作。正则会误伤属性里带 `>` 的极端写法，
 * 但最坏结果只是少一段文本，不会把标签当正文交给模型。
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(withoutComments)
  const title =
    titleMatch === null
      ? undefined
      : decodeHtmlEntities(titleMatch[1]?.replace(/<[^>]*>/g, '') ?? '')
          .replace(/\s+/g, ' ')
          .trim()
  let body = withoutComments
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|ul|ol|table|thead|tbody|figure)>/gi, '\n')
    .replace(/<(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre|ul|ol|table|thead|tbody|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  body = decodeHtmlEntities(body)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { ...(title === undefined || title.length === 0 ? {} : { title }), text: body }
}

/** 文本上限：超出时截断并在结尾说明，模型才知道自己看到的不是全文。 */
function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n\n[内容超过 ${maxChars} 字，已截断；原文共 ${text.length} 字]`,
    truncated: true,
  }
}

/** 读取响应体，最多 maxBytes；超出时取消流并标记截断。 */
async function readBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = maxBytes - total
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      total = maxBytes
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  const decoded = new TextDecoder('utf-8').decode(Buffer.concat(chunks))
  // PDF 是二进制：解码出来只会是乱码，调用方按 content-type 换成人话。
  return { text: contentType === 'application/pdf' ? '' : decoded, truncated }
}

/**
 * 抓取一个 URL 并转成模型可读文本。
 *
 * 重定向用 `redirect: 'manual'` 自己跟：只有这样才能在**发出下一跳之前**复核
 * 目标，而不是等浏览器/Axios 已经把请求打到 127.0.0.1 之后再检查 response.url。
 */
async function loadPage(
  rawUrl: string,
  signal: AbortSignal | undefined,
  options: Required<Pick<ReadUrlOptions, 'timeoutMs' | 'maxBytes' | 'maxChars'>> & {
    fetchImpl: FetchLike
    resolveHost: ResolveHost
  },
): Promise<ReadUrlResult> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onAbort = (): void => {
    controller.abort()
  }
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  try {
    let current = rawUrl
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 每一跳先校验再建连，校验放行的那个 IP 就是这一跳连接的钉子——
      // 重定向到新域名时对新域名的校验与钉 IP 都重来，顺序不能松。
      const allowed = await assertAllowedUrl(current, options.resolveHost)
      let response: Response
      try {
        response = await options.fetchImpl(
          current,
          {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
              'user-agent': 'RyHarness/0.1 (+https://github.com/ryharness/ryharness)',
            },
          },
          { ip: allowed.ip },
        )
      } catch (error) {
        if (timedOut) throw new Error(`读取超时（${options.timeoutMs} 毫秒）`)
        if (controller.signal.aborted) throw new Error('读取已取消')
        throw new Error(`请求失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location')
        // 重定向响应本身没有用处；不取消流会让连接一直挂在 keep-alive 上。
        await response.body?.cancel()
        if (location === null || location.length === 0) {
          throw new Error(`目标返回 ${response.status} 重定向，但没有 Location`)
        }
        if (hop === MAX_REDIRECTS) throw new Error('重定向次数过多')
        try {
          current = new URL(location, current).toString()
        } catch {
          throw new Error('重定向地址格式不正确')
        }
        continue
      }
      if (!response.ok) throw new Error(`目标返回 HTTP ${response.status}`)
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      let body: { text: string; truncated: boolean }
      try {
        body = await readBody(response, options.maxBytes)
      } catch (error) {
        if (timedOut) throw new Error(`读取超时（${options.timeoutMs} 毫秒）`)
        if (controller.signal.aborted) throw new Error('读取已取消')
        throw new Error(`读取响应失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const looksPdf =
        contentType === 'application/pdf' ||
        body.text.startsWith('%PDF-') ||
        (contentType === '' && new URL(current).pathname.toLowerCase().endsWith('.pdf'))
      if (looksPdf) {
        return { url: current, text: '暂不支持解析 PDF 内容，请下载后查看。', truncated: false }
      }
      const isHtml =
        contentType === 'text/html' ||
        contentType === 'application/xhtml+xml' ||
        (contentType.length === 0 && /<(?:!doctype|html|body|p|div|h[1-6]|article|section)\b/i.test(body.text))
      const parsed = isHtml ? htmlToText(body.text) : { text: body.text }
      const capped = capText(parsed.text, options.maxChars)
      // 响应体触顶时正文可能被切在一句话中间；给模型留一句说明，避免它把
      // 截断处当成页面结尾。
      const bodyNote = body.truncated ? `\n\n[响应体超过 ${options.maxBytes} 字节上限，已截断]` : ''
      return {
        ...('title' in parsed ? { title: parsed.title } : {}),
        url: current,
        text: `${capped.text}${bodyNote}`,
        truncated: body.truncated || capped.truncated,
      }
    }
    throw new Error('重定向次数过多')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 工具参数 → 对象；非对象按空参数处理。 */
function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/** 造出 `read_url` 工具；限额可注入，生产用默认值。 */
export function createReadUrlTool(options: ReadUrlOptions = {}): Tool {
  // 默认取回器钉 IP：fetchImpl 与 connectLookup 都留给测试注入。
  const fetchImpl = options.fetchImpl ?? createPinnedFetch(options.connectLookup ?? defaultConnectLookup)
  const resolveHost = options.resolveHost ?? defaultResolveHost
  const timeoutMs = options.timeoutMs ?? READ_URL_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? READ_URL_MAX_BYTES
  const maxChars = options.maxChars ?? READ_URL_MAX_CHARS
  return {
    name: 'read_url',
    description:
      '读取一个网页并返回正文文本（自动去掉脚本、样式与导航）。只支持 http/https，拒绝本机与内网地址；内容过长会截断。用户给你一个链接、或需要查网页上的信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的完整 http/https 链接。' },
      },
      required: ['url'],
    },
    execute: async (args, context: ToolContext): Promise<ToolResult> => {
      const raw = argsOf(args).url
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { content: 'url 是必填的，且必须是 http/https 链接。', isError: true }
      }
      try {
        const result = await loadPage(raw.trim(), context.signal, {
          fetchImpl,
          resolveHost,
          timeoutMs,
          maxBytes,
          maxChars,
        })
        return { content: JSON.stringify(result) }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** 网页读取插件入口：只注册一个工具，路由面为零。 */
export function webReadPlugin(): PluginEntry {
  return {
    id: WEB_READ_PLUGIN_ID,
    name: '网页读取',
    description: '让助理打开你给的 http/https 链接并读正文；本机与内网地址会被拒绝。',
    group: 'tool',
    capabilities: { tools: ['read_url'] },
    impact: '关闭后助理无法读取网页链接，只能依赖你粘贴的内容。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      ctx.tools.register(createReadUrlTool())
    },
  }
}
