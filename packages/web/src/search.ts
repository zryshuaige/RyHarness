/**
 * 搜索：可配置的 JSON 接口，或匿名抓一个搜索结果页。
 *
 * 两个后端换来换去，是因为可用性这件事不由我们决定：自建搜索接口要花钱、要维护，
 * 匿名抓结果页不要钱但随时可能改版。所以接口是配置项，宿主按自己的条件选一个，
 * 模型看到的形状不变。
 *
 * 接口那一侧刻意做得很薄：地址、结果数组在回包里的路径、一条结果里标题/链接/摘要
 * 分别叫什么字段——三件事定下来，别的形状都能套进来。抓页面那一侧只取标题与链接：
 * 各家结果页的排版没有共同约定，摘要取不到就空着，不猜。
 * @module @ryharness/web/search
 */

import { defaultResolveHost, type HostResolver, resolveSafeTarget } from './guard.ts'
import { collapseText, decodeEntities, stripTags } from './html.ts'
import { createPinnedFetch, type HttpRequestInit, type HttpResponse, type PinnedFetch } from './http.ts'
import { isRecord } from './parse.ts'
import { createTimeoutGate } from './timeout.ts'
import { type ApiSearchConfig, type HtmlSearchConfig, type SearchConfig, type SearchResult, WebError } from './types.ts'

/** 默认最多返回几条结果。 */
export const DEFAULT_MAX_RESULTS = 5
/** 默认超时（毫秒）。 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000
/** 结果数组在回包里的常见位置：按顺序找，找到就停。 */
const RESULT_PATHS = ['data', 'results', 'items', 'webPages', 'organic_results', 'value', 'hits']
/** 一条结果里标题可能叫什么。 */
const TITLE_KEYS = ['title', 'name', 'heading', 'label']
/** 一条结果里链接可能叫什么。 */
const URL_KEYS = ['url', 'link', 'href', 'source_url', 'displayUrl']
/** 一条结果里摘要可能叫什么。 */
const SNIPPET_KEYS = ['snippet', 'description', 'content', 'summary', 'abstract', 'text', 'body', 'passage']
/** 摘要最多保留多少字：太长会把模型的上下文吃掉。 */
const MAX_SNIPPET_CHARS = 500
/** 回包正文上限（字节）：一个异常大的响应不该把内存吃光。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** 回包正文：超过上限就只取前面一段。 */
function bodyText(response: HttpResponse): string {
  return response.body.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')
}

/** 默认取回器：钉在已校验的地址上。整个模块共用一个。 */
const fallbackFetch: PinnedFetch = createPinnedFetch()

/** 搜索的可调参数。 */
export interface WebSearchOptions {
  /** 取回器：测试注入假响应，生产走钉地址的默认取回器。 */
  fetchImpl?: PinnedFetch
  /** 主机名解析器：测试注入固定地址。 */
  resolveHost?: HostResolver
  /** 总超时（毫秒）。默认 10000。 */
  timeoutMs?: number
  /** 最多返回几条结果。 */
  maxResults?: number
  /** 调用方的取消信号。 */
  signal?: AbortSignal
}

/** 读一个点号路径：`data.results` 这种。 */
function readPath(payload: unknown, path: string): unknown {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/** 从回包里挑出结果数组：指定了路径就用它，否则按常见形状依次找。 */
function pickResultList(payload: unknown, resultPath: string | undefined): unknown[] {
  if (resultPath !== undefined && resultPath.length > 0) {
    const value = readPath(payload, resultPath)
    return Array.isArray(value) ? value : []
  }
  if (Array.isArray(payload)) return payload
  for (const path of RESULT_PATHS) {
    const value = readPath(payload, path)
    if (Array.isArray(value)) return value
  }
  return []
}

/** 取第一个非空的字符串字段。 */
function firstText(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/**
 * 取第一个像链接的字段。
 *
 * 链接字段有两种形状：直接一个字符串，或者一个对象（`{ href, title }` 这种）。
 * 两种都要认，否则一半的接口会返回空结果。
 */
function firstUrl(item: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
      continue
    }
    if (isRecord(value)) {
      const nested = firstUrl(value, ['href', 'url', 'link'])
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** 一条原始条目 → 一条结果。 */
function toSearchResult(item: unknown): SearchResult | undefined {
  if (!isRecord(item)) return undefined
  const url = firstUrl(item, URL_KEYS)
  if (url === undefined) return undefined
  // 接口没给标题就用链接顶上：给模型一条空标题的结果没有意义。
  const title = firstText(item, TITLE_KEYS) ?? url
  const snippet = firstText(item, SNIPPET_KEYS)
  return snippet === undefined ? { title, url } : { title, url, snippet: snippet.slice(0, MAX_SNIPPET_CHARS) }
}

/**
 * 从回包里取出搜索结果。
 * @param payload - 回包（已解析的 JSON）。
 * @param resultPath - 结果数组的路径；不填则按常见形状找。
 * @returns 结果列表（已去掉重复与不合格的条目）。
 */
export function extractSearchResults(payload: unknown, resultPath?: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of pickResultList(payload, resultPath)) {
    const result = toSearchResult(item)
    if (result === undefined) continue
    if (seen.has(result.url)) continue
    seen.add(result.url)
    results.push(result)
  }
  return results
}

/** 读一个属性值。 */
function readAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(attributes)
  if (match === null) return undefined
  const value = match[2] ?? match[3] ?? match[4]
  if (value === undefined) return undefined
  // 属性值里的实体（`&amp;` 之类）要解掉，否则链接会带上多余的转义符。
  const decoded = decodeEntities(value).trim()
  return decoded.length === 0 ? undefined : decoded
}

/**
 * 展开搜索页的跳转链接。
 *
 * 一些搜索结果页把真实链接包在自己的跳转地址里（DuckDuckGo 的 html 端点就是
 * `//duckduckgo.com/l/?uddg=<编码后的真实地址>`）。不解开的话，模型拿到的是一堆
 * 跳转链接，点开才到地方。
 */
function unwrapRedirect(url: URL): string {
  const host = url.hostname.toLowerCase()
  if (host !== 'duckduckgo.com' && !host.endsWith('.duckduckgo.com')) return url.toString()
  const target = url.searchParams.get('uddg')
  if (target === null) return url.toString()
  try {
    const decoded = new URL(target)
    if (decoded.protocol === 'http:' || decoded.protocol === 'https:') return decoded.toString()
  } catch {
    return url.toString()
  }
  return url.toString()
}

/** 把 href 变成一个能用的绝对链接；不是 http/https 就不要。 */
function normalizeResultUrl(href: string, baseUrl: string): string | undefined {
  const raw = href.trim()
  if (raw.length === 0) return undefined
  // 协议相对地址（//host/path）按 https 补全。
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  let parsed: URL
  try {
    parsed = new URL(absolute, baseUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return unwrapRedirect(parsed)
}

/**
 * 从搜索结果页里挑出链接与标题。
 *
 * 只认 `<a href>`：结果页的排版没有共同约定，但「结果是个链接」这件事是共同的。
 * 摘要取不到就空着——各家把摘要放在标题旁边的、放在下一段的、放在 data 属性里的
 * 都有，猜错一种就会把导航链接也当成结果。
 * @param document - 搜索结果页的 HTML。
 * @param baseUrl - 结果页地址（用来补全相对链接）。
 * @returns 结果列表。
 */
export function parseSearchHtml(document: string, baseUrl: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match = pattern.exec(document)
  while (match !== null) {
    const attributes = match[1] ?? ''
    const href = readAttribute(attributes, 'href')
    const url = href === undefined ? undefined : normalizeResultUrl(href, baseUrl)
    if (url !== undefined && !seen.has(url)) {
      const title = collapseText(stripTags(match[2] ?? ''))
      if (title.length >= 2) {
        seen.add(url)
        const snippet = readAttribute(attributes, 'title')
        results.push(snippet === undefined ? { title, url } : { title, url, snippet })
      }
    }
    match = pattern.exec(document)
  }
  return results
}

/** 请求体模板里的 `{{query}}` 替换成搜索词（JSON 里的搜索词不转义）。 */
function applyTemplate(value: unknown, query: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{query}}', query)
  if (Array.isArray(value)) return value.map((item) => applyTemplate(item, query))
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = applyTemplate(item, query)
    return result
  }
  return value
}

/** 地址里的 `{{query}}` 替换成转义后的搜索词。 */
function fillUrl(template: string, query: string): string {
  return template.replaceAll('{{query}}', encodeURIComponent(query))
}

/** GET 时的地址：有占位就用占位，没有就把搜索词放进 query 参数。 */
function buildSearchUrl(api: ApiSearchConfig, query: string): string {
  if (api.endpoint.includes('{{query}}')) return fillUrl(api.endpoint, query)
  let url: URL
  try {
    url = new URL(api.endpoint)
  } catch {
    throw new WebError('搜索接口地址不合法')
  }
  url.searchParams.set(api.queryParam ?? 'q', query)
  return url.toString()
}

/** POST 时的请求体：没有模板就发 `{ [queryParam]: query }`。 */
function buildSearchBody(api: ApiSearchConfig, query: string): Record<string, unknown> {
  if (api.bodyTemplate === undefined) return { [api.queryParam ?? 'q']: query }
  const applied = applyTemplate(api.bodyTemplate, query)
  return isRecord(applied) ? applied : {}
}

/** 把配置里的请求头名字统一成小写，免得 content-type 这类判断落空。 */
function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) result[name.toLowerCase()] = value
  return result
}

/** 走可配置的 JSON 接口。 */
async function searchViaApi(
  api: ApiSearchConfig,
  query: string,
  config: SearchConfig,
  options: WebSearchOptions,
): Promise<SearchResult[]> {
  const method = api.method ?? (api.bodyTemplate === undefined ? 'GET' : 'POST')
  const endpoint = method === 'GET' ? buildSearchUrl(api, query) : fillUrl(api.endpoint, query)
  const resolveHost = options.resolveHost ?? defaultResolveHost
  const target = await resolveSafeTarget(endpoint, resolveHost)
  const headers: Record<string, string> = { accept: 'application/json', ...lowerHeaders(api.headers) }
  if (method === 'POST' && headers['content-type'] === undefined) headers['content-type'] = 'application/json'
  const init: HttpRequestInit = { method, headers }
  if (method === 'POST') init.body = JSON.stringify(buildSearchBody(api, query))
  const controller = new AbortController()
  const gate = createTimeoutGate(
    config.timeoutMs ?? options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    controller,
    '搜索超时',
  )
  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fallbackFetch)(target.url.toString(), init, target.ip),
      gate.gate,
    ])
    if (response.status < 200 || response.status >= 300) {
      throw new WebError(`搜索接口返回 HTTP ${response.status}`)
    }
    const text = bodyText(response)
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new WebError('搜索接口返回的不是合法 JSON', { cause: error })
    }
    const results = extractSearchResults(payload, api.resultPath)
    return results.slice(0, config.maxResults ?? options.maxResults ?? DEFAULT_MAX_RESULTS)
  } catch (error) {
    if (gate.expired()) throw new WebError('搜索超时')
    if (error instanceof WebError) throw error
    throw new WebError('搜索失败：网络异常或连接被拒绝', { cause: error })
  } finally {
    gate.cancel()
  }
}

/** 匿名抓搜索结果页。 */
async function searchViaHtml(
  html: HtmlSearchConfig,
  query: string,
  config: SearchConfig,
  options: WebSearchOptions,
): Promise<SearchResult[]> {
  const resolveHost = options.resolveHost ?? defaultResolveHost
  let endpoint = fillUrl(html.endpoint, query)
  if (!html.endpoint.includes('{{query}}')) {
    try {
      const url = new URL(endpoint)
      url.searchParams.set('q', query)
      endpoint = url.toString()
    } catch {
      throw new WebError('搜索页面地址不合法')
    }
  }
  const target = await resolveSafeTarget(endpoint, resolveHost)
  const controller = new AbortController()
  const gate = createTimeoutGate(
    config.timeoutMs ?? options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    controller,
    '搜索超时',
  )
  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fallbackFetch)(
        target.url.toString(),
        { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' }, signal: controller.signal },
        target.ip,
      ),
      gate.gate,
    ])
    if (response.status < 200 || response.status >= 300) {
      throw new WebError(`搜索页面返回 HTTP ${response.status}`)
    }
    const results = parseSearchHtml(bodyText(response), target.url.toString())
    return results.slice(0, config.maxResults ?? options.maxResults ?? DEFAULT_MAX_RESULTS)
  } catch (error) {
    if (gate.expired()) throw new WebError('搜索超时')
    if (error instanceof WebError) throw error
    throw new WebError('搜索失败：网络异常或连接被拒绝', { cause: error })
  } finally {
    gate.cancel()
  }
}

/**
 * 搜索。
 *
 * @param config - 搜索配置：选哪个后端、地址从哪来。
 * @param query - 搜索词。
 * @param options - 取回器、超时与条数上限。
 * @returns 结果列表。
 * @throws WebError 消息为中文：配置不对、超时、接口出错等。
 */
export async function webSearch(
  config: SearchConfig,
  query: string,
  options: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) throw new WebError('搜索词不能为空')
  if (config.backend === 'api') {
    if (config.api === undefined) throw new WebError('搜索后端是 api，但没有配置 api 段')
    return searchViaApi(config.api, trimmed, config, options)
  }
  if (config.html === undefined) throw new WebError('搜索后端是 html，但没有配置 html 段')
  return searchViaHtml(config.html, trimmed, config, options)
}
