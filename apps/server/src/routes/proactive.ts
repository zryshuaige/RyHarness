/**
 * 主动消息（每日回顾）路由：开关与观测面。
 *
 * 单独一个域而不是塞进设置路由：这条消息由服务端自己发起，用户的开关与「今天发过
 * 没有」是同一件事的两面，放在一起才不会各自记一份状态。
 * @module @ryharness/server/routes/proactive
 */

import { ProactiveSettingsBody } from '../contract/proactive.ts'
import type { ProactiveDigest, ProactiveSnapshot } from '../proactive.ts'
import { route } from '../route.ts'
import { HttpRequestError, json, type Router } from '../router.ts'

/** 主动消息路由的依赖（调度器持有定时器与判重状态，路由只读与改设置）。 */
export interface ProactiveRoutes {
  proactive: ProactiveDigest
}

/** 主动消息的路由。 */
export function registerProactiveRoutes(router: Router, deps: ProactiveRoutes): void {
  const { proactive } = deps

  /**
   * 开启/关闭与「上次发过没有」。
   *
   * 状态与 /api/telemetry.proactive 同源（同一份快照），避免两处口径各自漂移：
   * 前者回答「现在能不能发」，后者回答「上一次是什么时候发的」。
   */
  router.get('/api/proactive', async (_req, res) => {
    json(res, 200, proactive.snapshot())
  })

  /**
   * 改设置：`{ enabled?: boolean, hour?: number }`，回包是改完之后的完整快照。
   *
   * 非法字段一律 400 而不是被默默忽略后回一份「看起来对」的值——用户要的是关掉
   * 主动消息，回了一份 enabled:true 等于没关。未知键与 hour 的范围校验留在
   * handler：schema 的 object 会透传未知键，而范围错是业务约束（文案保持原样）。
   */
  route(router, 'PATCH', '/api/proactive', { body: ProactiveSettingsBody }, async (req, res) => {
    const body = await req.body()
    // 契约 schema 会透传未知键，敲错的键在这里拦下，而不是被默默忽略。
    for (const key of Object.keys(body)) {
      if (key !== 'enabled' && key !== 'hour') throw new HttpRequestError(400, `unknown field "${key}"`)
    }
    // null 会从 schema 的可缺省通道里透传（缺省语义优先于类型），按非布尔挡下。
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new HttpRequestError(400, 'field "enabled" must be a boolean')
    }
    if (body.hour !== undefined) {
      const hour = body.hour
      if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new HttpRequestError(400, 'field "hour" must be an integer between 0 and 23')
      }
    }
    const settings = proactive.updateSettings({
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.hour === undefined ? {} : { hour: body.hour }),
    })
    json(res, 200, { ...proactive.snapshot(), settings })
  })
}

/** GET /api/proactive 的返回体（供客户端声明用）。 */
export type ProactiveStatus = ProactiveSnapshot
