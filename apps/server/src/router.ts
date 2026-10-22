/**
 * 极简路由器：method + 路径模式（:param 段），零依赖。
 * @module @ryharness/server/router
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 解析后的请求。 */
export interface Request {
  method: string
  /** 路径参数（:id 等）。 */
  params: Record<string, string>
  /** URL 查询参数。 */
  query: URLSearchParams
  /** 解析后的 JSON body（无 body 时为 undefined）。 */
  body: () => Promise<unknown>
  raw: IncomingMessage
}

export type Handler = (req: Request, res: ServerResponse) => Promise<void>

/**
 * 客户端请求错误（非法 JSON body 等）：dispatch 捕获后回对应 4xx，不再冒泡成 500。
 *
 * 带机器码 `code`：错误响应恒为 `{error, code}`，调用方按 `code` 分支，不去解析
 * `message` 文本。没显式给码时按状态码回落到标准名，因此已有的抛出点
 * （`new HttpRequestError(400, '…')`）自动就有码可读，不用逐个改写。
 */
export class HttpRequestError extends Error {
  readonly code: string

  constructor(
    readonly status: number,
    message: string,
    code: string = DEFAULT_ERROR_CODES[status] ?? 'REQUEST_FAILED',
  ) {
    super(message)
    this.name = 'HttpRequestError'
    this.code = code
  }
}

/** 状态码 → 默认机器码。够用的那一组，不做完整 HTTP 状态码表。 */
const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMIT',
}

interface Route {
  method: string
  pattern: string
  segments: string[]
  handler: Handler
}

/**
 * 请求体上限（字节）。
 *
 * 32MB：附件上传走 base64 的 JSON，20MB 原始字节编码后约 26.7MB，正好留得下；
 * 再大的请求体没有正当用途，不给它留内存的口子。
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 归一化后的路由身份：方法一律大写，模式按非空段重建，`/a/` 与 `/a` 是同一处。 */
export interface RouteTarget {
  method: string
  pattern: string
  segments: string[]
  key: string
}

/** 把 method + pattern 规范成可比较的路由身份。 */
export function routeTarget(method: string, pattern: string): RouteTarget {
  const normalizedMethod = method.toUpperCase()
  const segments = pattern.split('/').filter((s) => {
    return s.length > 0
  })
  return {
    method: normalizedMethod,
    pattern: `/${segments.join('/')}`,
    segments,
    key: `${normalizedMethod} ${segments.join('/')}`,
  }
}

/** 同 method + pattern 的重复注册：静默覆盖会让先注册的一方永远收不到请求。 */
export function duplicateRouteError(method: string, pattern: string): Error {
  return new Error(`@ryharness/server: route "${routeTarget(method, pattern).key}" is already registered`)
}

/** 路由表。 */
export class Router {
  private readonly routes: Route[] = []
  /** 已占用方法 + 模式；每次增删同步维护，重复注册因此是 O(1) 的显式错误。 */
  private readonly keys = new Set<string>()

  /**
   * 注册一条路由，返回精确注销函数。
   *
   * 注销函数是插件卸载时「路由一起消失」的执行体：只删自己那一条，且重复调用幂等。
   * @param method - HTTP 方法（大小写不敏感，统一存大写）。
   * @param pattern - 路径模式（:param 段由 dispatch 解出）。
   * @param handler - 处理函数。
   * @returns 注销这一次注册的函数。
   */
  add(method: string, pattern: string, handler: Handler): () => void {
    const target = routeTarget(method, pattern)
    if (this.keys.has(target.key)) throw duplicateRouteError(target.method, target.pattern)
    const route: Route = { method: target.method, pattern: target.pattern, segments: target.segments, handler }
    this.routes.push(route)
    this.keys.add(target.key)
    return () => {
      if (!this.keys.delete(target.key)) return
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  /** 这个 method + pattern 是否已被占用（RouteRegistry 挂载时据此判冲突）。 */
  has(method: string, pattern: string): boolean {
    return this.keys.has(routeTarget(method, pattern).key)
  }

  get(pattern: string, handler: Handler): void {
    void this.add('GET', pattern, handler)
  }
  post(pattern: string, handler: Handler): void {
    void this.add('POST', pattern, handler)
  }
  patch(pattern: string, handler: Handler): void {
    void this.add('PATCH', pattern, handler)
  }
  delete(pattern: string, handler: Handler): void {
    void this.add('DELETE', pattern, handler)
  }

  /** 分发一个请求；无匹配返回 false（调用方回 404）。 */
  async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const url = new URL(pathname, 'http://localhost')
    const segments = url.pathname.split('/').filter((s) => {
      return s.length > 0
    })
    for (const route of this.routes) {
      if (route.method !== req.method || route.segments.length !== segments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < segments.length; i++) {
        const pattern = route.segments[i] as string
        const actual = segments[i] as string
        if (pattern.startsWith(':')) {
          try {
            params[pattern.slice(1)] = decodeURIComponent(actual)
          } catch {
            json(res, 400, { error: 'malformed URL encoding', code: 'BAD_REQUEST' })
            return true
          }
        } else if (pattern !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue
      const body = async (): Promise<unknown> => {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = chunk as Buffer
          size += buffer.length
          /**
           * 请求体有上限。
           *
           * 不卡的话，一个 Content-Length 写着 1GB 的请求会把整个 body 读进内存
           * ——本机 API 只监听回环，但"本机任何进程都能驱动 shellExec"这件事本身
           * 就意味着不该给内存留一个无底洞。上限取 32MB：附件上传是 base64 走 JSON，
           * 20MB 的原始字节编码后约 26.7MB，正好留得下。
           */
          if (size > MAX_BODY_BYTES) {
            throw new HttpRequestError(413, `request body is larger than ${MAX_BODY_BYTES} bytes`)
          }
          chunks.push(buffer)
        }
        if (chunks.length === 0) return undefined
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length === 0) return undefined
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new HttpRequestError(400, 'invalid JSON body')
        }
      }
      try {
        await route.handler({ method: req.method ?? 'GET', params, query: url.searchParams, body, raw: req }, res)
      } catch (error) {
        if (error instanceof HttpRequestError) {
          json(res, error.status, { error: error.message, code: error.code })
          return true
        }
        throw error
      }
      return true
    }
    return false
  }
}

/** 回 JSON 响应。 */
export function json(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 从 body 取字符串字段。 */
export function strField(body: unknown, key: string): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
