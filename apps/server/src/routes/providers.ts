/**
 * 供应商路由：清单 / 预设 / 新增 / 连通性探测 / 删除。
 *
 * 热注册（refreshProviders）由组合根持有：适配器句柄在服务端实例上，这里只管
 * 路由与落盘。
 * @module @ryagent/server/routes/providers
 */

import type { SessionStore } from '@ryagent/session'
import type { ProviderConfig, ProviderProtocol, ProvidersConfigFile } from '../config.ts'
import {
  deleteApiKey,
  loadApiKeys,
  mergeApiKeys,
  PROVIDER_PRESETS,
  providerKeyConfigured,
  providerPreset,
  saveApiKey,
  writeProvidersConfig,
} from '../config.ts'
import { HttpRequestError, json, type Router, strField } from '../router.ts'

/** 供应商路由的依赖。 */
export interface ProviderRoutes {
  store: SessionStore
  dataDir: string
  /** 进程内的供应商配置对象（原地更新，热注册读同一份）。 */
  providers: ProvidersConfigFile
  /** 换一份供应商配置并热注册适配器。 */
  refreshProviders: (next: ProvidersConfigFile) => void
  /** 连通性探测超时毫秒。 */
  verifyTimeoutMs: number
}

/** POST /api/providers 的入参（校验后）。 */
interface NewProviderInput {
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  models: string[]
  /** 免 key 协议（Ollama）允许不填；其余也允许留空——用户可以稍后在设置里补。 */
  apiKey?: string
  /** 从哪个预设建起（图标/文档链接回溯）。 */
  presetId?: string
}

/** 接入协议白名单：目前适配器只有 OpenAI 兼容一路，Ollama 走同一套协议只是免 key。 */
const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ['openai', 'ollama']

/** POST /api/providers 的白名单校验：类型/取值不合法抛错（调用方回 400）。 */
function parseNewProviderInput(body: unknown): NewProviderInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
  if (displayName.length === 0) throw new HttpRequestError(400, 'displayName is required')
  const protocol = record.protocol === undefined ? 'openai' : String(record.protocol).trim().toLowerCase()
  if (!PROVIDER_PROTOCOLS.includes(protocol as ProviderProtocol)) {
    throw new HttpRequestError(400, `protocol must be one of ${PROVIDER_PROTOCOLS.join('|')}`)
  }
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  if (!Array.isArray(record.models) || record.models.length === 0) {
    throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
  }
  const models: string[] = []
  for (const model of record.models) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
    }
    const id = model.trim()
    if (!models.includes(id)) models.push(id)
  }
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const presetId =
    typeof record.presetId === 'string' && record.presetId.trim().length > 0 ? record.presetId.trim() : undefined
  return {
    displayName,
    protocol: protocol as ProviderProtocol,
    baseUrl: parsedUrl.toString().replace(/\/+$/, ''),
    models,
    ...(apiKey.length === 0 ? {} : { apiKey }),
    ...(presetId === undefined ? {} : { presetId }),
  }
}

/** 引用某个供应商的 agent（ProviderInfo.usedBy / 删除供应商的 409 载荷）。 */
export interface ProviderUsage {
  agentId: string
  agentName: string
}

/**
 * GET /api/providers 的对外形状。
 *
 * protocol/baseUrl/custom 是 UI 分组与徽标（内置 / 自定义 / 免 key）与展开后
 * 显示端点的依据；凭据只回答"配没配"，绝不回显值。usedBy 回答"谁在用这条
 * 路由"——删除前据此拦下（否则被引用的 agent 会静默变砖）。
 */
export function providerInfo(
  id: string,
  provider: ProviderConfig,
  usedBy: ProviderUsage[],
): {
  id: string
  displayName: string
  protocol: string
  baseUrl: string
  custom: boolean
  apiKeyConfigured: boolean
  models: { id: string; name?: string; contextWindow?: number }[]
  usedBy: ProviderUsage[]
} {
  return {
    id,
    displayName: provider.displayName ?? id,
    protocol: provider.protocol ?? 'openai',
    baseUrl: provider.baseURL,
    custom: provider.custom === true,
    apiKeyConfigured: providerKeyConfigured(provider),
    models: provider.models.map((model) => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    })),
    usedBy,
  }
}

/** 取出引用了该供应商 id 的 agent（agent 定义里 provider 字段即路由 id）。 */
function providerUsage(
  agents: readonly { id: string; name: string; provider: string }[],
  providerId: string,
): ProviderUsage[] {
  return agents
    .filter((agent) => {
      return agent.provider === providerId
    })
    .map((agent) => {
      return { agentId: agent.id, agentName: agent.name }
    })
}

/** 连通性探测的结论：ok + 中文人话 message + 探测耗时。 */
interface VerifyOutcome {
  ok: boolean
  message: string
  latencyMs: number
}

/**
 * 探测 URL：OpenAI 兼容走模型列表端点，Ollama 走本机原生 tags 端点。
 *
 * Ollama 的 OpenAI 兼容面（<base>/v1/models）要求它已经挂上 OpenAI 兼容层，
 * 而裸装的 ollama serve 只有原生面——按协议分流才能给出"服务没启动"这种
 * 用户看得懂的诊断。
 */
function verifyProbeUrl(provider: ProviderConfig): string {
  const baseURL = provider.baseURL.replace(/\/+$/, '')
  if (provider.protocol !== 'ollama') return `${baseURL}/models`
  const root = baseURL.replace(/\/v\d+$/, '')
  return `${root}/api/tags`
}

/** fetch 失败的原因分类（网络错误码藏在 cause 里）。 */
function networkErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : undefined
}

/**
 * 拿当前凭据对 baseUrl 打一次最小探测：OpenAI 兼容看模型列表端点，Ollama 看
 * 本机原生 tags 端点。**永远回 200 + 中文结论**（凭据无效 / 服务没启动 /
 * 网络不可达 / 超时），不把网络故障冒泡成 500——设置页要的是一句人话。
 */
async function verifyProvider(provider: ProviderConfig, verifyTimeoutMs: number): Promise<VerifyOutcome> {
  const startedAt = Date.now()
  const keyConfigured = providerKeyConfigured(provider)
  if (provider.protocol !== 'ollama' && !keyConfigured) {
    return { ok: false, message: '还没填 API Key，先去「供应商」里配置再验证。', latencyMs: 0 }
  }
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv])
  try {
    const response = await fetch(verifyProbeUrl(provider), {
      method: 'GET',
      ...(apiKey === undefined || provider.protocol === 'ollama'
        ? {}
        : { headers: { authorization: `Bearer ${apiKey}` } }),
      signal: AbortSignal.timeout(verifyTimeoutMs),
    })
    const latencyMs = Date.now() - startedAt
    if (response.ok) {
      return {
        ok: true,
        latencyMs,
        message: provider.protocol === 'ollama' ? '本地模型服务在跑，可以直接用。' : '连接正常，API Key 有效。',
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, latencyMs, message: 'API Key 无效或已过期，请重新填写。' }
    }
    if (response.status === 404) {
      return {
        ok: false,
        latencyMs,
        message:
          provider.protocol === 'ollama'
            ? '本地服务在跑，但这个地址不像 Ollama，请检查 baseUrl（通常应为 http://127.0.0.1:11434/v1）。'
            : '服务返回「找不到该地址」，请检查 baseUrl 是否写对（OpenAI 兼容一般以 /v1 结尾）。',
      }
    }
    return { ok: false, latencyMs, message: `服务返回了错误（HTTP ${response.status}），稍后再试或换个服务商。` }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const code = networkErrorCode(error)
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return {
        ok: false,
        latencyMs,
        message: `连接超时（${Math.round(verifyTimeoutMs / 1000)} 秒没响应），请检查网络或服务地址。`,
      }
    }
    if (code === 'ECONNREFUSED') {
      return {
        ok: false,
        latencyMs,
        message:
          provider.protocol === 'ollama'
            ? '本地模型服务没启动：请先在终端运行 ollama serve。'
            : '连不上这个地址（对方拒绝了连接），请确认服务已启动、baseUrl 端口写对了。',
      }
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return { ok: false, latencyMs, message: '网络不可达：域名解析不出来，请检查 baseUrl 与网络连接。' }
    }
    return {
      ok: false,
      latencyMs,
      message: `网络不可达，暂时连不上这个服务${code === undefined ? '' : `（${code}）`}。`,
    }
  }
}

/** 供应商清单、预设、新增、探测与删除的路由。 */
export function registerProviderRoutes(router: Router, deps: ProviderRoutes): void {
  const { store, dataDir, refreshProviders, verifyTimeoutMs } = deps

  router.get('/api/providers', async (_req, res) => {
    const agents = store.listAgents()
    json(res, 200, {
      providers: Object.entries(deps.providers.providers).map(([id, provider]) => {
        return providerInfo(id, provider, providerUsage(agents, id))
      }),
    })
  })

  /** 添加供应商向导的预设目录（协议 / baseURL / 推荐模型 / 文档链接）。 */
  router.get('/api/provider-presets', async (_req, res) => {
    json(res, 200, { presets: PROVIDER_PRESETS })
  })

  /**
   * 新增供应商：写 providers.json（路由）+ api-keys.json（明文 key，0600），
   * 再热注册适配器——加完立刻能选，不重启。
   */
  router.post('/api/providers', async (req, res) => {
    // 白名单校验失败抛 HttpRequestError，由 dispatch 统一回 400。
    const input = parseNewProviderInput(await req.body())
    const preset = input.presetId === undefined ? undefined : providerPreset(input.presetId)
    if (input.presetId !== undefined && preset === undefined) {
      json(res, 400, { error: `unknown preset: ${input.presetId}` })
      return
    }
    const next: ProvidersConfigFile = {
      ...deps.providers,
      providers: { ...deps.providers.providers },
    }
    // 预设 id 优先（图标/文档链接能对上品牌），已占用则退化成随机 id。
    const preferredId = input.presetId ?? `custom-${crypto.randomUUID().slice(0, 8)}`
    const providerId =
      next.providers[preferredId] === undefined ? preferredId : `custom-${crypto.randomUUID().slice(0, 8)}`
    const provider: ProviderConfig = {
      // baseUrl 已在校验里归一（绝对 URL + 去尾部斜杠）。
      baseURL: input.baseUrl,
      protocol: input.protocol,
      displayName: input.displayName,
      models: input.models.map((modelId) => {
        return { id: modelId }
      }),
      custom: true,
      ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
    }
    next.providers[providerId] = provider
    writeProvidersConfig(dataDir, next)
    // key 先落盘再热注册：热注册读的是合并后的内存配置。
    if (input.apiKey !== undefined) saveApiKey(dataDir, providerId, input.apiKey)
    refreshProviders(mergeApiKeys(next, loadApiKeys(dataDir)))
    json(res, 201, { provider: providerInfo(providerId, deps.providers.providers[providerId] as ProviderConfig, []) })
  })

  /**
   * 连通性探测：拿当前凭据对 baseUrl 打一次最小请求（OpenAI 兼容 → models 列表，
   * Ollama → 本机原生 tags 端点），超时 8s。
   *
   * 永远回 200 + `{ok, message, latencyMs}`：探测失败是设置页要展示的诊断信息，
   * 不是服务端故障。message 区分「没配 Key / Key 无效 / 服务没启动 / 网络不可达 /
   * 超时」，让用户知道下一步该点什么。
   */
  router.post('/api/providers/:id/verify', async (req, res) => {
    const providerId = req.params.id as string
    const provider = deps.providers.providers[providerId]
    if (provider === undefined) {
      json(res, 404, { error: `provider not found: ${providerId}` })
      return
    }
    json(res, 200, await verifyProvider(provider, verifyTimeoutMs))
  })

  /**
   * 删除供应商：仅限用户自己加的（内置条目是应用的一部分，删了没法恢复），
   * 且**不能有 agent 正在用它**——删掉之后那些 agent 会静默变成"转不起来的砖"，
   * 所以回 409 并把引用者一并带回去给 UI 提示。
   */
  router.delete('/api/providers/:id', async (req, res) => {
    const providerId = req.params.id as string
    const provider = deps.providers.providers[providerId]
    if (provider === undefined) {
      json(res, 404, { error: `provider not found: ${providerId}` })
      return
    }
    if (provider.custom !== true) {
      json(res, 409, { error: `builtin provider "${providerId}" cannot be deleted` })
      return
    }
    const usedBy = providerUsage(store.listAgents(), providerId)
    if (usedBy.length > 0) {
      json(res, 409, { error: `provider "${providerId}" is used by ${usedBy.length} agent(s)`, usedBy })
      return
    }
    const next: ProvidersConfigFile = {
      ...deps.providers,
      providers: { ...deps.providers.providers },
    }
    delete next.providers[providerId]
    // key 先清（不留孤儿 key 在 0600 文件里），再落盘路由。
    deleteApiKey(dataDir, providerId)
    writeProvidersConfig(dataDir, next)
    refreshProviders(mergeApiKeys(next, loadApiKeys(dataDir)))
    json(res, 200, { deleted: providerId })
  })
}
