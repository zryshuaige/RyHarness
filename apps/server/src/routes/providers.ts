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

/** baseUrl 归一：绝对 http(s) URL + 去尾部斜杠。新增与编辑共用，落盘的形态以它为准。 */
function normalizeBaseUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpRequestError(400, 'baseUrl must be an absolute http(s) URL')
  }
  return parsed.toString().replace(/\/+$/, '')
}

/** 两个 baseUrl 是否指向同一家服务（忽略大小写与尾部斜杠）。 */
function sameBaseUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()
}

/** 模型 id 数组的白名单校验：非空、去重、逐项 trim。 */
function parseModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
  }
  const models: string[] = []
  for (const model of value) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
    }
    const id = model.trim()
    if (!models.includes(id)) models.push(id)
  }
  return models
}

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
  const models = parseModelIds(record.models)
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  const presetId =
    typeof record.presetId === 'string' && record.presetId.trim().length > 0 ? record.presetId.trim() : undefined
  return {
    displayName,
    protocol: protocol as ProviderProtocol,
    baseUrl: normalizeBaseUrl(baseUrl),
    models,
    ...(apiKey.length === 0 ? {} : { apiKey }),
    ...(presetId === undefined ? {} : { presetId }),
  }
}

/** PATCH /api/providers/:id 的入参（校验后）。只认这四个字段，其余键一律丢弃。 */
export interface ProviderPatchInput {
  displayName?: string
  protocol?: ProviderProtocol
  baseUrl?: string
  models?: string[]
}

/**
 * PATCH 的白名单校验。
 *
 * 键不存在 = 这一项不改（所以前端可以只发改动的字段）。传了就必须是合法值——
 * 半路而废的编辑（空名字、相对路径 baseUrl、清空模型列表）宁可 400，也不能悄悄
 * 写进 providers.json 让适配器再也起不来。凭据 / custom / presetId 不在白名单里：
 * 前两个是归属标记（改了就等于伪造一条新的），凭据另有 settings 路由管。
 */
function parseProviderPatch(body: unknown): ProviderPatchInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const patch: ProviderPatchInput = {}
  if (record.displayName !== undefined) {
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : ''
    if (displayName.length === 0) throw new HttpRequestError(400, 'displayName must not be empty')
    patch.displayName = displayName
  }
  if (record.protocol !== undefined) {
    const protocol = String(record.protocol).trim().toLowerCase()
    if (!PROVIDER_PROTOCOLS.includes(protocol as ProviderProtocol)) {
      throw new HttpRequestError(400, `protocol must be one of ${PROVIDER_PROTOCOLS.join('|')}`)
    }
    patch.protocol = protocol as ProviderProtocol
  }
  if (record.baseUrl !== undefined) {
    if (typeof record.baseUrl !== 'string') throw new HttpRequestError(400, 'baseUrl must be a string')
    patch.baseUrl = normalizeBaseUrl(record.baseUrl.trim())
  }
  if (record.models !== undefined) patch.models = parseModelIds(record.models)
  return patch
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

/** 指向同一个 baseUrl 的另一条路由（新增与编辑都要挡住重复项）。 */
export interface DuplicateProvider {
  id: string
  displayName: string
}

function providerByBaseUrl(
  providers: Record<string, ProviderConfig>,
  baseUrl: string,
  exceptId?: string,
): DuplicateProvider | undefined {
  for (const [id, provider] of Object.entries(providers)) {
    if (id === exceptId || !sameBaseUrl(provider.baseURL, baseUrl)) continue
    return { id, displayName: provider.displayName ?? id }
  }
  return undefined
}

/** 重复项的中文说法：说清"已经有了"以及下一步该点什么，而不是丢一个 409。 */
function duplicateProviderText(existing: DuplicateProvider): string {
  return `已经添加过指向同一个地址的供应商「${existing.displayName}」，不用重复添加；要改名字、地址或模型，去列表里点「编辑」。`
}

/** 某个被删掉的模型还挂在哪些 agent 上（删模型前据此拦下）。 */
export interface ModelUsage {
  modelId: string
  agents: ProviderUsage[]
}

function modelUsage(
  agents: readonly { id: string; name: string; provider: string; model: string }[],
  providerId: string,
  removedModelIds: readonly string[],
): ModelUsage[] {
  return removedModelIds
    .map((modelId) => {
      return {
        modelId,
        agents: agents
          .filter((agent) => {
            return agent.provider === providerId && agent.model === modelId
          })
          .map((agent) => {
            return { agentId: agent.id, agentName: agent.name }
          }),
      }
    })
    .filter((entry) => {
      return entry.agents.length > 0
    })
}

/**
 * 删模型被 agent 占用时的中文说法：点名到 agent，而不是回一句"conflict"。
 * 用户照着这句话就知道要去通讯录改绑谁。
 */
function modelInUseText(usages: readonly ModelUsage[]): string {
  const parts = usages.map((usage) => {
    const names = usage.agents
      .map((agent) => {
        return agent.agentName
      })
      .join('、')
    return `模型「${usage.modelId}」正被 ${names} 使用`
  })
  return `${parts.join('；')}：先到通讯录把这些 agent 改绑到别的模型，再删这些模型。`
}

/**
 * 探测失败的分类。与 renderer 的 provider-health.ts 是同一套取值——那边拿 code
 * 决定"以服务端的人话为准"，没有 code 的老服务端才回退到自己的模式匹配。
 *
 * 取值刻意只描述用户能理解的现象（凭据被拒 / 服务没起 / 域名解析不了 / 限流…），
 * 不带网络错误码、不带内部路径：code 是给界面做分支的，不是给人看的。
 */
export type ProviderFailureCode =
  | 'ok'
  | 'no-key'
  | 'bad-key'
  | 'rate-limited'
  | 'not-found'
  | 'service-down'
  | 'dns'
  | 'unreachable'
  | 'timeout'
  | 'error'

/** 连通性探测的结论：ok + 诊断分类 + 中文人话 message + 探测耗时。 */
interface VerifyOutcome {
  ok: boolean
  code: ProviderFailureCode
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
 * 域名解析失败 / 限流 / 网络不可达 / 超时），不把网络故障冒泡成 500——设置页要的
 * 是一句能照着做的人话。
 *
 * 两份规矩，别在实现里绕过：
 * 1. 每条 message 都要带下一步（去哪儿点什么），不是复述现象；
 * 2. 不把内部信息写进 message——网络错误码（ECONNREFUSED）、适配器占位环境变量名
 *    （RYAGENT_API_KEY_*）、内部路由路径都不是用户能处理的东西，要归类就归进 code。
 */
async function verifyProvider(provider: ProviderConfig, verifyTimeoutMs: number): Promise<VerifyOutcome> {
  const startedAt = Date.now()
  const keyConfigured = providerKeyConfigured(provider)
  if (provider.protocol !== 'ollama' && !keyConfigured) {
    return {
      ok: false,
      code: 'no-key',
      message: '还没填 API Key：先在这行里粘贴这家服务的 Key，再回来测一次。',
      latencyMs: 0,
    }
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
        code: 'ok',
        latencyMs,
        message: provider.protocol === 'ollama' ? '本地模型服务在跑，可以直接用。' : '连接正常，API Key 有效。',
      }
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'bad-key',
        latencyMs,
        // 403 常常不是"key 错了"而是"这个模型没开/余额没了"：把两种可能都点出来，
        // 用户照着查才不会来回换 key。
        message:
          'API Key 无效或没权限：请到供应商官网确认 Key 状态、可用模型与余额（余额不足也会这样报错），再重新填写。',
      }
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: 'rate-limited',
        latencyMs,
        message: '被限流了：这家供应商暂时不接受这么多请求，等一两分钟再测就行，Key 本身没问题。',
      }
    }
    if (response.status === 404) {
      return {
        ok: false,
        code: 'not-found',
        latencyMs,
        message:
          provider.protocol === 'ollama'
            ? '本地服务在跑，但这个地址不像 Ollama，请检查 baseUrl（通常应为 http://127.0.0.1:11434/v1）。'
            : '服务返回「找不到该地址」，请检查 baseUrl 是否写对（OpenAI 兼容一般以 /v1 结尾）。',
      }
    }
    return {
      ok: false,
      code: 'error',
      latencyMs,
      message: `服务返回了错误（HTTP ${response.status}）：稍后再测一次；一直这样就换个服务商，或找这家客服看看。`,
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const code = networkErrorCode(error)
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return {
        ok: false,
        code: 'timeout',
        latencyMs,
        message: `连接超时（${Math.round(verifyTimeoutMs / 1000)} 秒没响应）：请检查网络，或确认 baseUrl 与端口写对。`,
      }
    }
    if (code === 'ECONNREFUSED') {
      return {
        ok: false,
        code: 'service-down',
        latencyMs,
        message:
          provider.protocol === 'ollama'
            ? '本地模型服务没启动：请先在终端运行 ollama serve。'
            : '连不上这个地址（对方拒绝了连接），请确认服务已启动、baseUrl 端口写对了。',
      }
    }
    // 域名解析不出来 ≠ 路由到了一台机器但连不上：前者是地址/网络写错了（改
    // baseUrl 或换网络），后者是网络或代理把这台挡在外面（改网络或找网管）。
    // 合成一句"网络不可达"会让人两头都改一遍。
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return {
        ok: false,
        code: 'dns',
        latencyMs,
        message: '域名解析不出来：请检查 baseUrl 里的域名有没有拼错、这台机器的网络是否正常（跟 Key 无关）。',
      }
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return {
        ok: false,
        code: 'unreachable',
        latencyMs,
        message: '网络不可达：这台机器连不到那个地址，可能是网络或代理拦住了，换个网络或让网管放行。',
      }
    }
    return {
      ok: false,
      code: 'error',
      latencyMs,
      message: '暂时连不上这家供应商：稍后再测一次；一直不通就检查 baseUrl，或换个服务商。',
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
   *
   * 同一个 baseUrl 只能有一条路由：点一个已经配过的预设若照旧退化成
   * `custom-xxxxxxxx`，用户会得到一条丢品牌图标的重复项，还得分不清哪条才是
   * 生效的。所以这里回 409 并点名已存在的那条，界面据此提示"去编辑它"。
   */
  router.post('/api/providers', async (req, res) => {
    // 白名单校验失败抛 HttpRequestError，由 dispatch 统一回 400。
    const input = parseNewProviderInput(await req.body())
    const preset = input.presetId === undefined ? undefined : providerPreset(input.presetId)
    if (input.presetId !== undefined && preset === undefined) {
      json(res, 400, { error: `unknown preset: ${input.presetId}` })
      return
    }
    const duplicate = providerByBaseUrl(deps.providers.providers, input.baseUrl)
    if (duplicate !== undefined) {
      json(res, 409, { error: duplicateProviderText(duplicate), existingId: duplicate.id })
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
   * 改供应商：只认 displayName / baseUrl / models / protocol 四个字段，缺省的项
   * 原样保留（前端可以只发改动的那些），其余键丢弃。改完同样热注册，不用重启。
   *
   * 两处 409，都是"再点一次会出事"而不是"请求不合法"：
   * - 改成另一条已存在的 baseUrl → 409 + 点名那一条；
   * - 删掉还挂在某个 agent 上的模型 → 409 + 点名是哪些 agent（模型没了那些 agent
   *   会静默变成转不起来的砖，和删供应商被引用时同一回事）。
   *
   * 内置条目也允许改：它们删不掉，模型列表过期时唯一能救的就是这条路由。
   */
  router.patch('/api/providers/:id', async (req, res) => {
    const providerId = req.params.id as string
    const provider = deps.providers.providers[providerId]
    if (provider === undefined) {
      json(res, 404, { error: `provider not found: ${providerId}` })
      return
    }
    // 白名单校验失败抛 HttpRequestError，由 dispatch 统一回 400。
    const patch = parseProviderPatch(await req.body())
    const baseUrl = patch.baseUrl ?? provider.baseURL
    const duplicate = providerByBaseUrl(deps.providers.providers, baseUrl, providerId)
    if (duplicate !== undefined) {
      json(res, 409, { error: duplicateProviderText(duplicate), existingId: duplicate.id })
      return
    }
    const models =
      patch.models ??
      provider.models.map((model) => {
        return model.id
      })
    const removed = provider.models
      .map((model) => {
        return model.id
      })
      .filter((modelId) => {
        return !models.includes(modelId)
      })
    const agents = store.listAgents()
    const inUse = modelUsage(agents, providerId, removed)
    if (inUse.length > 0) {
      json(res, 409, { error: modelInUseText(inUse), models: inUse })
      return
    }
    const previousModels = new Map(
      provider.models.map((model) => {
        return [model.id, model]
      }),
    )
    const next: ProvidersConfigFile = {
      ...deps.providers,
      providers: { ...deps.providers.providers },
    }
    next.providers[providerId] = {
      ...provider,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol }),
      baseURL: baseUrl,
      // 留着的模型沿用旧条目（name / contextWindow 是手写配置的一部分，不能因为
      // 改个顺序就丢）；新加的只有 id。
      models: models.map((modelId) => {
        return previousModels.get(modelId) ?? { id: modelId }
      }),
    }
    writeProvidersConfig(dataDir, next)
    refreshProviders(mergeApiKeys(next, loadApiKeys(dataDir)))
    json(res, 200, {
      provider: providerInfo(
        providerId,
        deps.providers.providers[providerId] as ProviderConfig,
        providerUsage(agents, providerId),
      ),
    })
  })

  /**
   * 连通性探测：拿当前凭据对 baseUrl 打一次最小请求（OpenAI 兼容 → models 列表，
   * Ollama → 本机原生 tags 端点），超时 8s。
   *
   * 永远回 200 + `{ok, code, message, latencyMs}`：探测失败是设置页要展示的诊断信息，
   * 不是服务端故障。code 是机器可读的分类（见 ProviderFailureCode），message 是
   * 给人看的中文下一步——两者都不含网络错误码或内部路径。
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
