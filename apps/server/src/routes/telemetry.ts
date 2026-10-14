/**
 * 运行时可观测性路由（GET /api/telemetry）。
 * @module @ryagent/server/routes/telemetry
 */

import { json, type Router } from '../router.ts'
import type { Telemetry } from '../telemetry.ts'

/** 遥测路由的依赖。 */
export interface TelemetryRoutes {
  telemetry: Telemetry
}

/**
 * 最近的请求计时与轮次耗时。
 *
 * 只含方法/路径/状态码与各类耗时数字，**不含消息正文与凭据**。
 */
export function registerTelemetryRoutes(router: Router, deps: TelemetryRoutes): void {
  const { telemetry } = deps
  router.get('/api/telemetry', async (req, res) => {
    const raw = Number(req.query.get('limit') ?? '')
    const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined
    json(res, 200, telemetry.getSnapshot(limit))
  })
}
