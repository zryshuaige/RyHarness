/**
 * 带契约的路由注册：一份 schema 同时是运行时校验和 TS 类型。
 *
 * ## 为什么有这一层
 *
 * 路由的手写校验已经长出了 13 处同样的 cast 样板、64 处手写 throw，而且渲染层
 * 与 SDK 各自手抄接口——字段一改就漂移（dispatcherAgentId 三处三种口径）。参照
 * kimicode 的 defineRoute（zod → 校验 → handler 入参类型一体）与 dsh 的
 * schemastery 双注解手法（`z<Input, Output>` 把 schema 钉在接口上），把这件事
 * 收成一个注册函数：schema 常量放 `src/contract/`，路由从这里注册，渲染层与
 * SDK `import type` 同一份真源。
 *
 * ## 用法
 *
 * ```ts
 * route(router, 'POST', '/api/conversations', { body: CreateConversationBody }, async (req, res) => {
 *   const input = await req.body() // 已校验、已归一，类型是 schema 的输出
 * })
 * ```
 *
 * 缺 body 的请求按 `{}` 参与校验：全可选字段的 PATCH 语义不变，必填字段缺失
 * 照样 400。没有 body 的路由（GET 类）继续用 `Router.get`，不经过这里。
 *
 * @module @ryharness/server/route
 */

import type { ServerResponse } from 'node:http'
import Schema from '@ryharness/schemastery'
import { type Handler, HttpRequestError, type Request, type Router } from './router.ts'

/** 契约路由的请求：`body()` 返回的是校验归一后的值，类型即 schema 的输出。 */
export interface RoutedRequest<T> extends Omit<Request, 'body'> {
  body: () => Promise<T>
}

/**
 * 给 handler 套上 body 契约，返回普通的 `Handler`（route() 的本体）。
 *
 * 单独导出是因为插件挂的路由也要带契约：`RouteRegistry.register` 只收 handler，
 * 而 questions/todos/voice 这类 handler 工厂在造 handler 时拿不到 Router——
 * 只能在 handler 外面先包上这一层，注册侧保持 `ctx.routes.register(...)` 原样。
 * @param schemas - body 契约（schema 常量来自 `src/contract/`）。
 * @param handler - 处理函数；`req.body()` 已是校验归一后的输出。
 * @returns 可直接交给 Router / RouteRegistry 的 handler。
 */
export function withBody<S extends Schema>(
  schemas: { readonly body: S },
  handler: (req: RoutedRequest<Schemastery.TypeT<S>>, res: ServerResponse) => Promise<void>,
): Handler {
  return async (req: Request, res: ServerResponse) => {
    let value: Schemastery.TypeT<S>
    try {
      value = schemas.body((await req.body()) ?? {})
    } catch (error) {
      // schemastery 的报错自带 `$.field` 路径前缀，直接给人看；机器码沿用
      // 400 的默认 BAD_REQUEST，与手写时代的回包形状一致。
      if (Schema.ValidationError.is(error)) throw new HttpRequestError(400, error.message)
      throw error
    }
    await handler({ ...req, body: () => Promise.resolve(value) }, res)
  }
}

/**
 * 注册一条带 body 契约的路由。
 * @param router - 目标路由表。
 * @param method - HTTP 方法（`Router.add` 的口径，大小写不敏感）。
 * @param pattern - 路径模式（:param 段由 dispatch 解出）。
 * @param schemas - body 契约（schema 常量来自 `src/contract/`）。
 * @param handler - 处理函数；`req.body()` 已是校验归一后的输出。
 * @returns 注销函数（透传 `Router.add` 的）。
 */
export function route<S extends Schema>(
  router: Router,
  method: string,
  pattern: string,
  schemas: { readonly body: S },
  handler: (req: RoutedRequest<Schemastery.TypeT<S>>, res: ServerResponse) => Promise<void>,
): () => void {
  return router.add(method, pattern, withBody(schemas, handler))
}
