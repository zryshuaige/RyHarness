/**
 * 运行时可观测性路由（GET /api/telemetry）。
 * @module @ryagent/server/routes/telemetry
 */

import type { ProactiveSnapshot } from '../proactive.ts'
import { json, type Router } from '../router.ts'
import type { Telemetry } from '../telemetry.ts'

/** 遥测路由的依赖。 */
export interface TelemetryRoutes {
  telemetry: Telemetry
  /**
   * 主动消息的观测面（可选）：它每天自己写一条消息，没有「上次什么时候发的」这一栏时，
   * 界面上无法回答「今天它到底说没说话」。
   */
  proactive?: () => ProactiveSnapshot
}

/**
 * 最近的请求计时与轮次耗时，外加主动消息的上次发送时间。
 *
 * 只含方法/路径/状态码与各类耗时数字，**不含消息正文与凭据**。
 */
export function registerTelemetryRoutes(router: Router, deps: TelemetryRoutes): void {
  const { telemetry } = deps
  router.get('/api/telemetry', async (req, res) => {
    const raw = Number(req.query.get('limit') ?? '')
    const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined
    const snapshot = telemetry.getSnapshot(limit)
    json(res, 200, deps.proactive === undefined ? snapshot : { ...snapshot, proactive: deps.proactive() })
  })
}
