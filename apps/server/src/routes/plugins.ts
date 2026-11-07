/**
 * 插件路由：清单与开关。
 *
 * 开关不是只改配置：{@link PluginHost.setEnabled} 会真实 dispose/重新 apply
 * 对应插件，注册表与模型路由在同一请求内生效。core 插件对外只读——它们承载
 * 工具底座与登录/供应商，关掉之后应用没有可用形态。
 * @module @ryharness/server/routes/plugins
 */

import { PluginPatchBody } from '../contract/plugins.ts'
import { PluginError, type PluginHost } from '../plugins/host.ts'
import { route } from '../route.ts'
import { HttpRequestError, json, type Router } from '../router.ts'

/** 插件路由的依赖。 */
export interface PluginRoutes {
  plugins: PluginHost
}

/** 插件清单 / 开关。 */
export function registerPluginRoutes(router: Router, deps: PluginRoutes): void {
  router.get('/api/plugins', async (_req, res) => {
    json(res, 200, { plugins: deps.plugins.list() })
  })

  route(router, 'PATCH', '/api/plugins/:id', { body: PluginPatchBody }, async (req, res) => {
    // enabled 的类型（含缺省即 400）由契约 schema 兜住，这里只剩插件本身的业务错误。
    const body = await req.body()
    try {
      const plugin = await deps.plugins.setEnabled(req.params.id as string, body.enabled)
      // 与 GET 同形：调用方拿这一行直接替换列表项，不必整表重拉。
      json(res, 200, { plugin })
    } catch (error) {
      if (!(error instanceof PluginError)) throw error
      throw new HttpRequestError(error.code === 'CORE_PLUGIN' ? 403 : 404, error.message, error.code)
    }
  })
}
