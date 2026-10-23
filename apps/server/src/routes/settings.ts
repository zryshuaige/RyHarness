/**
 * 设置路由：应用内 API key 的增删 + 工作区路径。
 * @module @ryharness/server/routes/settings
 */

import type { ProvidersConfigFile } from '../config.ts'
import { deleteApiKey, loadApiKeys, mergeApiKeys, saveApiKey } from '../config.ts'
import type { RetargetedAgent } from '../provider-routing.ts'
import { json, type Router } from '../router.ts'

/** 设置路由的依赖。 */
export interface SettingsRoutes {
  dataDir: string
  /** 进程内的供应商配置对象（原地更新，热注册读同一份）。 */
  providers: ProvidersConfigFile
  /** 换一份供应商配置并热注册适配器。 */
  refreshProviders: (next: ProvidersConfigFile) => void
  /** 工具读写文件的工作区根目录。 */
  workspaceRoot: string
  /**
   * 刚给某家配好凭据之后叫一声（可选）。
   *
   * 内置助理的默认路由要跟着用户挑的那家走：此前写死硅基流动，用户配了别家也
   * 用不了。组合根在这里接上「把还指着没凭据的内置助理切过去」。
   */
  onProviderConfigured?: (providerId: string) => RetargetedAgent[]
}

/** 设置路由：API key 凭据与工作区。 */
export function registerSettingsRoutes(router: Router, deps: SettingsRoutes): void {
  const { dataDir, refreshProviders, workspaceRoot } = deps

  // 工作区：助理读写文件的根目录。「我的」页要展示它、打开它，
  // 欢迎页的「看看工作区里都有什么文件」也要落地到真实路径上。
  router.get('/api/workspace', async (_req, res) => {
    json(res, 200, { path: workspaceRoot })
  })

  /** 应用内配置 API key：写 config/api-keys.json（0600）并热注册适配器。 */
  router.post('/api/settings/api-key', async (req, res) => {
    const body = await req.body()
    const record = body as Record<string, unknown>
    const providerId = typeof record.providerId === 'string' ? record.providerId : ''
    const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
    if (providerId.length === 0 || apiKey.length === 0) {
      json(res, 400, { error: 'providerId and apiKey are required' })
      return
    }
    if (!saveApiKey(dataDir, providerId, apiKey)) {
      json(res, 404, { error: `unknown provider: ${providerId}` })
      return
    }
    // 热更新：把新 key 合并进配置并重新注册适配器，用户不用重启。
    const merged = mergeApiKeys(deps.providers, loadApiKeys(dataDir))
    refreshProviders(merged)
    // 助理的默认路由跟着用户挑的那家走（组合根负责真正改 agents 表）。
    const retargeted = deps.onProviderConfigured?.(providerId) ?? []
    json(res, 200, { providerId, configured: true, retargeted })
  })

  /**
   * 移除应用内配置的 API key：清 api-keys.json（0600）并热更新适配器。
   *
   * 内存配置里的明文 key 是启动时并进来的，mergeApiKeys 只在「没有明文 key」
   * 时才并入——不先把它摘掉，删完 key 适配器仍在用旧 key 跑（删了等于没删）。
   */
  router.delete('/api/settings/api-key/:id', async (req, res) => {
    const providerId = req.params.id as string
    const current = deps.providers.providers[providerId]
    if (current === undefined) {
      json(res, 404, { error: `unknown provider: ${providerId}` })
      return
    }
    deleteApiKey(dataDir, providerId)
    const next: ProvidersConfigFile = {
      ...deps.providers,
      providers: { ...deps.providers.providers },
    }
    const { apiKey: _merged, ...rest } = current
    next.providers[providerId] = rest
    refreshProviders(mergeApiKeys(next, loadApiKeys(dataDir)))
    json(res, 200, { providerId, configured: false })
  })
}
