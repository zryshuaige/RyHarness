/**
 * 渲染层里"绕过 ApiClient 的直连"唯一的出口。
 *
 * 为什么需要它：ApiClient.request 是渲染层唯一注入 token 的地方（生产环境主进程会给
 * 每次启动生成 256 位 token，服务端对每个 HTTP 请求都比对一次，缺 token 一律 401）。
 * 于是任何在组件里直接 `fetch(api.base + …)` 的调用都**必然** 401——搜索定位会弹出
 * "检查一下本地服务是否在运行"这种把用户引向错误方向的提示，附件上传则会把英文的
 * `missing or invalid API token` 原文贴到卡片上。
 *
 * 两条取路由的口径与 ApiClient.request 完全一致：Bearer 头，token 现读（窗口可能先于
 * 后端起来，早于 token 到达就构造的客户端也必须带上后到的那个），本次启动未启用鉴权
 * 时（浏览器直连开发）一个头都不加。
 */
import { currentApiToken } from '../api.ts'

/** 一次直连需要的全部参数（刻意不用 RequestInit：那会把 HeadersInit 的联合类型带进来）。 */
export interface AuthedFetchOptions {
  method?: string
  body?: string
  /** 额外头；同名项覆盖默认的 content-type / authorization。 */
  headers?: Record<string, string>
}

/** 带 token 的 fetch：`base` 与 `path` 与 ApiClient 里各方法的拼法一致。 */
export function authedFetch(base: string, path: string, options: AuthedFetchOptions = {}): Promise<Response> {
  const token = currentApiToken()
  return fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: {
      'content-type': 'application/json',
      ...(token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })
}
