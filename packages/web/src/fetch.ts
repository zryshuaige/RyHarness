/**
 * 抓一个 URL，转成模型可读的文字。
 *
 * 这一份是「可复用的纯函数版」：不注册工具、不依赖服务端插件，宿主拿一个 URL 就能
 * 拿到标题与正文。要接进 agent 的话用 tools.ts 里的两个工厂。
 *
 * 边界与 apps/server 的 web-read 插件同一口径（协议白名单、私网拒绝、逐跳重定向
 * 复核、钉 IP、响应体上限、总超时），但代码各写各的：那边是服务端插件，import 它
 * 会让这个包反过来依赖 apps/server。两边的规则要一样，实现不必一样。
 * @module @ryharness/web/fetch
 */

import { defaultResolveHost, type HostResolver, resolveSafeTarget } from './guard.ts'
import { htmlToText } from './html.ts'
import { createPinnedFetch, type HttpResponse, type PinnedFetch } from './http.ts'
import { createTimeoutGate } from './timeout.ts'
import { type FetchedPage, WebError } from './types.ts'

/** 默认总超时（毫秒）。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000
/** 默认响应体上限（字节）。 */
export const DEFAULT_FETCH_MAX_BYTES = 2 * 1024 * 1024
/** 默认正文字符上限。 */
export const DEFAULT_FETCH_MAX_CHARS = 20_000
/** 最多跟几跳重定向。 */
const MAX_REDIRECTS = 5
/** 算重定向的状态码。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 抓取的可调参数：限额与取回器都可注入（测试用替身，生产用默认值）。 */
export interface WebFetchOptions {
  /** 总超时（毫秒）。默认 10000。 */
  timeoutMs?: number
  /** 响应体字节上限。默认 2MB。 */
  maxBytes?: number
  /** 正文字符上限。默认 20000。 */
  maxChars?: number
  /** 取回器：测试注入假响应，生产走钉地址的默认取回器。 */
  fetchImpl?: PinnedFetch
  /** 主机名解析器：测试注入固定地址。 */
  resolveHost?: HostResolver
  /** 调用方的取消信号。 */
  signal?: AbortSignal
}

/** 文本上限：超出时截断并在结尾说明，模型才知道自己看到的不是全文。 */
function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n\n[内容超过 ${maxChars} 字，已截断；原文共 ${text.length} 字]`,
    truncated: true,
  }
}

/** 从响应里拼出页面：判断类型、抽正文、套上限。 */
function buildPage(url: string, response: HttpResponse, maxBytes: number, maxChars: number): FetchedPage {
  const contentType = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  // 字节上限在这里也做一遍：传输层那一份是「别把几兆读回来」，这一份是「就算
  // 有人换了个取回器，超出的部分也不许进正文」。
  const overBytes = response.body.length > maxBytes
  const raw = overBytes ? response.body.subarray(0, maxBytes).toString('utf8') : response.body.toString('utf8')
  const body = raw
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  const looksPdf =
    contentType === 'application/pdf' || body.startsWith('%PDF-') || (contentType === '' && path.endsWith('.pdf'))
  if (looksPdf) {
    return { url, text: '暂不支持解析 PDF 内容，请下载后查看。', truncated: false }
  }
  const isHtml =
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml' ||
    (contentType === '' && /<(?:!doctype|html|body|p|div|h[1-6]|article|section)\b/i.test(body))
  const parsed = isHtml ? htmlToText(body) : { text: body }
  const capped = capText(parsed.text, maxChars)
  // 响应体触顶时正文可能被切在一句话中间；给模型留一句说明，免得它把截断处当成页面结尾。
  const truncated = response.truncated || overBytes
  const note = truncated ? `\n\n[响应体超过 ${maxBytes} 字节上限，已截断]` : ''
  return {
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    url,
    text: `${capped.text}${note}`,
    truncated: truncated || capped.truncated,
  }
}

/**
 * 抓一个 URL 并转成可读文字。
 *
 * 重定向自己跟，不用 `redirect: 'follow'`：只有自己跟才能在**发出下一跳之前**复核
 * 目标，而不是等请求已经打到 127.0.0.1 之后再回头看最终 URL。每一跳都重新校验、
 * 重新钉地址，顺序不能松。
 * @param rawUrl - 要抓的 http/https 链接。
 * @param options - 限额、取回器与取消信号。
 * @returns 页面标题与正文。
 * @throws WebError 消息为中文：协议不对、地址是内网、超时、状态码不对等。
 */
export async function webFetch(rawUrl: string, options: WebFetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES
  const maxChars = options.maxChars ?? DEFAULT_FETCH_MAX_CHARS
  const resolveHost = options.resolveHost ?? defaultResolveHost
  const fetchImpl = options.fetchImpl ?? createPinnedFetch(maxBytes)
  const controller = new AbortController()
  const gate = createTimeoutGate(timeoutMs, controller, '读取超时')
  const onAbort = (): void => {
    controller.abort()
  }
  if (options.signal?.aborted === true) controller.abort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let current = rawUrl.trim()
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // 每一跳先校验再建连，校验放行的那个地址就是这一跳的钉子。
      // 重定向到新域名时，校验与钉地址都重来一遍。
      const target = await resolveSafeTarget(current, resolveHost)
      const response = await Promise.race([
        fetchImpl(
          current,
          {
            method: 'GET',
            headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8' },
            signal: controller.signal,
          },
          target.ip,
        ),
        gate.gate,
      ])
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.location
        if (location === undefined || location.length === 0) {
          throw new WebError(`目标返回 ${response.status} 重定向，但没有 Location`)
        }
        if (hop === MAX_REDIRECTS) throw new WebError('重定向次数过多')
        let next: string
        try {
          next = new URL(location, current).toString()
        } catch {
          throw new WebError('重定向地址格式不正确')
        }
        current = next
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new WebError(`目标返回 HTTP ${response.status}`)
      }
      return buildPage(current, response, maxBytes, maxChars)
    }
    throw new WebError('重定向次数过多')
  } catch (error) {
    if (gate.expired()) throw new WebError(`读取超时（${timeoutMs} 毫秒）`)
    if (controller.signal.aborted) throw new WebError('读取已取消')
    if (error instanceof WebError) throw error
    throw new WebError('请求失败：网络异常或连接被拒绝', { cause: error })
  } finally {
    gate.cancel()
    options.signal?.removeEventListener('abort', onAbort)
  }
}
