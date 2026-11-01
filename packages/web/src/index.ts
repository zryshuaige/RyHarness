/**
 * RyHarness 的 web 能力：搜索与抓网页。
 *
 * 两件事：
 * - `web_search`：模型能「查一下」。后端可插拔——可配置的 JSON 接口，或匿名抓一个
 *   搜索结果页；两条路给模型的形状一样。
 * - `web_fetch`：抓一个 URL 转成可读文字。边界与 apps/server 的 `read_url` 插件
 *   同一口径：只允许 http/https、拦本机与内网、逐跳重定向重新校验、连接钉在已校验
 *   的地址上、响应体与正文都有上限、默认 10 秒超时。
 *
 * 这一包是纯函数 + 配置：它不注册工具、不认识 cordis。宿主拿 `createWebSearchTool`
 * 与 `createWebFetchTool` 造出工具，注册到自己的工具表里即可。
 * @module @ryharness/web
 */

export type { WebFetchOptions } from './fetch.ts'
export {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_FETCH_TIMEOUT_MS,
  webFetch,
} from './fetch.ts'
export type { HostResolver, SafeTarget } from './guard.ts'
export { defaultResolveHost, isPrivateAddress, resolveSafeTarget } from './guard.ts'
export { collapseText, decodeEntities, htmlToText, stripTags } from './html.ts'
export type { HttpRequestInit, HttpResponse, PinnedFetch } from './http.ts'
export { buildRequestOptions, createPinnedFetch, DEFAULT_MAX_BYTES } from './http.ts'
export { isRecord } from './parse.ts'
export type { WebSearchOptions } from './search.ts'
export {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  extractSearchResults,
  parseSearchHtml,
  webSearch,
} from './search.ts'
export type { WebDeps, WebTool, WebToolContext } from './tools.ts'
export { createWebFetchTool, createWebSearchTool } from './tools.ts'
export type {
  ApiSearchConfig,
  FetchConfig,
  FetchedPage,
  HtmlSearchConfig,
  SearchBackend,
  SearchConfig,
  SearchResult,
  WebConfig,
  WebToolResult,
} from './types.ts'
export { WebError } from './types.ts'
