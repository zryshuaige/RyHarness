/**
 * 极简路由器：method + 路径模式（:param 段），零依赖。
 * @module @ryagent/server/router
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

/** 客户端请求错误（非法 JSON body 等）：dispatch 捕获后回对应 4xx，不再冒泡成 500。 */
export class HttpRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpRequestError'
  }
}

interface Route {
  method: string
  segments: string[]
  handler: Handler
}

/** 路由表。 */
export class Router {
  private readonly routes: Route[] = []

  private add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split('/').filter((s) => { return s.length > 0 }), handler })
  }

  get(pattern: string, handler: Handler): void { this.add('GET', pattern, handler) }
  post(pattern: string, handler: Handler): void { this.add('POST', pattern, handler) }
  patch(pattern: string, handler: Handler): void { this.add('PATCH', pattern, handler) }
  delete(pattern: string, handler: Handler): void { this.add('DELETE', pattern, handler) }

  /** 分发一个请求；无匹配返回 false（调用方回 404）。 */
  async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const url = new URL(pathname, 'http://localhost')
    const segments = url.pathname.split('/').filter((s) => { return s.length > 0 })
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
            json(res, 400, { error: 'malformed URL encoding' })
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
        for await (const chunk of req) chunks.push(chunk as Buffer)
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
          json(res, error.status, { error: error.message })
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
