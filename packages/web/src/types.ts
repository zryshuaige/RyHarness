/**
 * web 家族的公共类型：配置（宿主写）与结果（模型读）。
 *
 * 配置与结果分开放，是因为两头的使用者不同：配置进 JSON 配置文件，由人写；
 * 结果进模型上下文，由工具返回。中间不留可执行的东西，配置就只是数据——
 * 于是「宿主传进来什么」与「模型看到什么」能各自独立地测。
 * @module @ryharness/web/types
 */

/** 搜索后端：`api` 走可配置的 JSON 接口，`html` 匿名抓一个搜索结果页。 */
export type SearchBackend = 'api' | 'html'

/**
 * 可配置的搜索接口。
 *
 * 通用 JSON 接口千奇百怪，所以这里只约定三件事：地址从哪来、结果数组在回包的哪个
 * 路径下、一条结果里标题、链接、摘要分别叫什么字段。剩下的（请求体长什么样、
 * 要带什么认证头）交给 bodyTemplate 与 headers。
 */
export interface ApiSearchConfig {
  /** 搜索接口地址。写 `{{query}}` 占位则替换成搜索词，不写则按 queryParam 追加。 */
  endpoint: string
  /** 额外请求头（Authorization、api-key 等）。 */
  headers?: Record<string, string>
  /**
   * 请求体模板（POST 时用）。字符串里的 `{{query}}` 会被替换成搜索词；
   * 没有模板时默认发 `{ [queryParam]: query }`。
   */
  bodyTemplate?: Record<string, unknown>
  /**
   * 结果数组在回包的哪个路径下，用点号分隔（如 `data.results`）。
   * 不填就按常见形状依次找：`data`、`results`、`items` 等。
   */
  resultPath?: string
  /** 查询词放哪个参数名（GET 时用，POST 默认请求体时也用它）。默认 `q`。 */
  queryParam?: string
  /** 请求方法。给了 bodyTemplate 却没写方法时按 POST 走。 */
  method?: 'GET' | 'POST'
}

/** 匿名抓搜索结果页的取法。 */
export interface HtmlSearchConfig {
  /** 搜索结果页地址。`{{query}}` 占位会被替换成搜索词。 */
  endpoint: string
}

/** 搜索配置。 */
export interface SearchConfig {
  /** 选哪个后端。 */
  backend: SearchBackend
  /** backend = 'api' 时必填。 */
  api?: ApiSearchConfig
  /** backend = 'html' 时必填。 */
  html?: HtmlSearchConfig
  /** 单次搜索的超时（毫秒）。默认 10000。 */
  timeoutMs?: number
  /** 最多返回几条结果。默认 5。 */
  maxResults?: number
}

/** 抓取配置。 */
export interface FetchConfig {
  /** 单次抓取的超时（毫秒）。默认 10000。 */
  timeoutMs?: number
  /** 响应体字节上限。默认 2MB。 */
  maxBytes?: number
  /** 正文字符上限。默认 20000。 */
  maxChars?: number
}

/** web 家族的总配置。纯数据，宿主从配置文件读进来直接用。 */
export interface WebConfig {
  search?: SearchConfig
  fetch?: FetchConfig
}

/** 一条搜索结果。 */
export interface SearchResult {
  /** 标题：接口没给就用链接顶上，不给模型一条空标题的结果。 */
  title: string
  /** 链接。只收 http/https。 */
  url: string
  /** 摘要：没有就是没有，不编。 */
  snippet?: string
}

/** 抓回来的一个页面。 */
export interface FetchedPage {
  /** 最终 URL（跟着重定向走完之后的那个）。 */
  url: string
  /** 页面标题（HTML 的 title）。 */
  title?: string
  /** 正文文本。 */
  text: string
  /** 正文或响应体是否被上限截断过。 */
  truncated: boolean
}

/** 工具返回给模型的结果。 */
export interface WebToolResult {
  /** 文本内容。 */
  content: string
  /** 出错时为 true，AgentLoop 据此把它当错误消息回给模型。 */
  isError?: boolean
}

/**
 * 本包自己产生的错误。
 *
 * 单独一个类，是为了让「我们写的错误」与「底层冒出来的意外错误」能被分开：
 * 前者的消息就是给模型看的（中文），后者只回一句中文摘要，原始异常留在 cause 里
 * 供宿主记日志——模型不需要看到 socket hang up 这种东西。
 */
export class WebError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebError'
  }
}
