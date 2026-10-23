/**
 * 供应商路由：清单 / 预设 / 新增 / 连通性探测 / 删除。
 *
 * 热注册（refreshProviders）由组合根持有：适配器句柄在服务端实例上，这里只管
 * 路由与落盘。
 * @module @ryharness/server/routes/providers
 */

import type { SessionStore } from '@ryharness/session'
import type { ProviderConfig, ProviderModelInput, ProviderProtocol, ProvidersConfigFile } from '../config.ts'
import {
  applyDeclaredModels,
  deleteApiKey,
  loadApiKeys,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  mergeApiKeys,
  PROVIDER_PRESETS,
  parseContextWindowTokens,
  providerKeyConfigured,
  providerPreset,
  saveApiKey,
  writeProvidersConfig,
} from '../config.ts'
import type { RetargetedAgent } from '../provider-routing.ts'
import { HttpRequestError, json, type Router } from '../router.ts'

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
  /**
   * 刚给某家配好凭据之后叫一声（可选）。
   *
   * 内置助理的默认路由要跟着用户挑的那家走：此前写死硅基流动，用户配了别家也
   * 用不了。组合根在这里接上「把还指着没凭据的内置助理切过去」，并把切了谁回给
   * 界面——静默改掉用户助理的模型，用户是看不见的。
   */
  onProviderConfigured?: (providerId: string) => RetargetedAgent[]
}

/** POST /api/providers 的入参（校验后）。 */
interface NewProviderInput {
  displayName: string
  protocol: ProviderProtocol
  baseUrl: string
  models: ProviderModelInput[]
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

/**
 * 模型列表的白名单校验：非空、去重、逐项 trim。
 *
 * 每项可以是裸 id（`"gpt-4o"`），也可以是带补录上下文长度的对象（`{ id, contextWindow }`）：
 * OpenAI 兼容端点根本不报这个数字，而用户在设置页照厂商文档填了——那份值要一路进到内核的
 * 请求预算里去（见 {@link ProviderModelInput}），所以这里必须给它一条通路。裸 id 与对象
 * 可以混在一份数组里，多余的键一律丢弃。
 */
function parseModels(value: unknown): ProviderModelInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
  }
  const models: ProviderModelInput[] = []
  for (const entry of value) {
    let id: unknown
    let declaredWindow: unknown
    if (typeof entry === 'string') {
      id = entry
    } else if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>
      id = record.id
      declaredWindow = record.contextWindow
    }
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HttpRequestError(400, 'models must be a non-empty array of model ids')
    }
    // 给了却不能用（0、小数、超出上下限）一律 400：宁可让用户当场看见自己敲错，也不能把一个
    // 内核会照着算预算的假数字写进 providers.json。
    if (declaredWindow !== undefined && parseContextWindowTokens(declaredWindow) === undefined) {
      throw new HttpRequestError(
        400,
        `contextWindow must be an integer between ${MIN_CONTEXT_WINDOW_TOKENS} and ${MAX_CONTEXT_WINDOW_TOKENS}`,
      )
    }
    const trimmed = id.trim()
    const contextWindow = parseContextWindowTokens(declaredWindow)
    // 去重保留第一次出现的那份：同一个 id 声明两次是有歧义的，界面的模型列表不会这样发。
    if (
      models.some((model) => {
        return model.id === trimmed
      })
    )
      continue
    models.push({ id: trimmed, ...(contextWindow === undefined ? {} : { contextWindow }) })
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
  const models = parseModels(record.models)
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
  /** 声明即覆盖：带 contextWindow 的按它写，没带的清掉旧值（见 applyDeclaredModels）。 */
  models?: ProviderModelInput[]
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
  if (record.models !== undefined) patch.models = parseModels(record.models)
  return patch
}

/** POST /api/providers/discover 的入参（校验后）：一份还没保存的供应商草稿。 */
interface DiscoverInput {
  baseUrl: string
  protocol: ProviderProtocol
  /** 一次性凭据：不落盘、不回显。 */
  apiKey?: string
}

/**
 * 草稿的白名单校验，与新增/编辑共用同一套协议表与 baseUrl 归一。
 *
 * 不校验"这家供应商是不是已经有了"：发现只是替用户问一句话，问错了用户自己会
 * 看到返回的地址与诊断，不必在这里拦住。
 */
function parseDiscoverInput(body: unknown): DiscoverInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const protocol = record.protocol === undefined ? 'openai' : String(record.protocol).trim().toLowerCase()
  if (!PROVIDER_PROTOCOLS.includes(protocol as ProviderProtocol)) {
    throw new HttpRequestError(400, `protocol must be one of ${PROVIDER_PROTOCOLS.join('|')}`)
  }
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : ''
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    protocol: protocol as ProviderProtocol,
    ...(apiKey.length === 0 ? {} : { apiKey }),
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
    // 思考档位随路由一起告诉前端：UI 据此决定给不给选择器。
    // 目录在 OpenAiAdapter 里（各家接受值的交集），路由没声明就不给。
    ...(provider.reasoningControl === undefined || provider.reasoningControl === 'none'
      ? {}
      : { reasoningEfforts: ['low', 'medium', 'high'] }),
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
 * 端点自己报告的一个模型。
 *
 * **只有端点真报出来的字段**：OpenAI 兼容的 `/v1/models` 基本只回 id（连名字都
 * 常常没有），contextWindow / 价格更是没有——那就空着，界面显示「上下文未知」，
而不是按模型名猜一个数字（猜错了用户会按错的长度截断历史）。
 */
export interface DiscoveredModel {
  /** 发到线上的 model 值。 */
  id: string
  /** 端点另外给了显示名才有。 */
  name?: string
}

/** 发现结果的条数上限：只为防住畸形响应把渲染层一次灌爆，不是产品上的限制。 */
const DISCOVERY_LIMIT = 300

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

/** 模型列表端点的条目数组：认 OpenAI 兼容的 `data`，也认 Ollama 原生的 `models`。 */
function modelCatalogEntries(payload: unknown, protocol: ProviderProtocol): unknown[] {
  if (Array.isArray(payload)) return payload
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as Record<string, unknown>
  // Ollama 原生面只有 models；OpenAI 兼容面是 data，但也有网关只回 models。
  const list = protocol === 'ollama' ? record.models : (record.data ?? record.models)
  return Array.isArray(list) ? list : []
}

/** 单个条目 → 模型。id 缺失的条目直接丢掉：没有 id 的模型建不出路由。 */
function toDiscoveredModel(entry: unknown): DiscoveredModel | undefined {
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id.length === 0 ? undefined : { id }
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const id = [record.id, record.name, record.model].find((value) => {
    return typeof value === 'string' && value.trim().length > 0
  })
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  // 名字只在端点另外给了、且与 id 不同时才带：Ollama 的 name 就是 id，回一份
  // 等于 id 的 name 只会在界面上多显示一遍同样的字。
  const name = record.name
  return typeof name === 'string' && name.trim().length > 0 && name.trim() !== trimmed
    ? { id: trimmed, name: name.trim() }
    : { id: trimmed }
}

/**
 * 从模型列表端点的响应体里认出模型条目（按端点顺序，去重）。
 *
 * 认两种形状：OpenAI 兼容的 `{ data: [{ id }] }`（云端与网关的绝大多数）与 Ollama
 * 原生的 `{ models: [{ name }] }`。其余字段一概不补——宁可让界面显示「上下文未知」，
 * 也不能拿一个猜的 contextWindow / 价格去承诺用户做不到的事。
 */
export function parseDiscoveredModels(payload: unknown, protocol: ProviderProtocol): DiscoveredModel[] {
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of modelCatalogEntries(payload, protocol)) {
    const model = toDiscoveredModel(entry)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
    if (models.length >= DISCOVERY_LIMIT) break
  }
  return models
}

/**
 * 读出探测响应里的模型目录。
 *
 * 拿不到就当空：探测已经过了（连接与凭据都是通的），因为正文不是 JSON 而把整次
 * 探测判成失败，是拿一个可有可无的附加信息去推翻已经成立的结论。
 */
async function readDiscoveredModels(response: Response, protocol: ProviderProtocol): Promise<DiscoveredModel[]> {
  try {
    return parseDiscoveredModels(await response.json(), protocol)
  } catch {
    return []
  }
}

/** 一次探测的完整结果：连通性结论 + 端点自己报告的模型目录。 */
interface ProviderProbe {
  outcome: VerifyOutcome
  /** 探测成功时来自模型列表端点；失败或端点没报就是空数组。 */
  discovered: DiscoveredModel[]
}

/**
 * 拿当前凭据对 baseUrl 打一次最小探测：OpenAI 兼容看模型列表端点，Ollama 看
 * 本机原生 tags 端点。**永远回 200 + 中文结论**（凭据无效 / 服务没启动 /
 * 域名解析失败 / 限流 / 网络不可达 / 超时），不把网络故障冒泡成 500——设置页要的
 * 是一句能照着做的人话。
 *
 * 顺带把那次模型列表的响应体解析成模型目录一并带出去：请求早就发了，正文也早就
 * 在手上，此前却在 ok 分支里直接丢掉——于是「这家有哪些模型」只能靠用户手打精确
 * 的 model id。模型发现因此搭在探测这条已经存在的链路上，而不是另加一次请求。
 *
 * 两份规矩，别在实现里绕过：
 * 1. 每条 message 都要带下一步（去哪儿点什么），不是复述现象；
 * 2. 不把内部信息写进 message——网络错误码（ECONNREFUSED）、适配器占位环境变量名
 *    （RYHARNESS_API_KEY_*）、内部路由路径都不是用户能处理的东西，要归类就归进 code。
 */
async function probeProvider(provider: ProviderConfig, verifyTimeoutMs: number): Promise<ProviderProbe> {
  const startedAt = Date.now()
  const keyConfigured = providerKeyConfigured(provider)
  if (provider.protocol !== 'ollama' && !keyConfigured) {
    return {
      outcome: {
        ok: false,
        code: 'no-key',
        message: '还没填 API Key：先在这行里粘贴这家服务的 Key，再回来测一次。',
        latencyMs: 0,
      },
      discovered: [],
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
        outcome: {
          ok: true,
          code: 'ok',
          latencyMs,
          message: provider.protocol === 'ollama' ? '本地模型服务在跑，可以直接用。' : '连接正常，API Key 有效。',
        },
        discovered: await readDiscoveredModels(response, provider.protocol ?? 'openai'),
      }
    }
    if (response.status === 401 || response.status === 403) {
      return {
        outcome: {
          ok: false,
          code: 'bad-key',
          latencyMs,
          // 403 常常不是"key 错了"而是"这个模型没开/余额没了"：把两种可能都点出来，
          // 用户照着查才不会来回换 key。
          message:
            'API Key 无效或没权限：请到供应商官网确认 Key 状态、可用模型与余额（余额不足也会这样报错），再重新填写。',
        },
        discovered: [],
      }
    }
    if (response.status === 429) {
      return {
        outcome: {
          ok: false,
          code: 'rate-limited',
          latencyMs,
          message: '被限流了：这家供应商暂时不接受这么多请求，等一两分钟再测就行，Key 本身没问题。',
        },
        discovered: [],
      }
    }
    if (response.status === 404) {
      return {
        outcome: {
          ok: false,
          code: 'not-found',
          latencyMs,
          message:
            provider.protocol === 'ollama'
              ? '本地服务在跑，但这个地址不像 Ollama，请检查 baseUrl（通常应为 http://127.0.0.1:11434/v1）。'
              : '服务返回「找不到该地址」，请检查 baseUrl 是否写对（OpenAI 兼容一般以 /v1 结尾）。',
        },
        discovered: [],
      }
    }
    return {
      outcome: {
        ok: false,
        code: 'error',
        latencyMs,
        message: `服务返回了错误（HTTP ${response.status}）：稍后再测一次；一直这样就换个服务商，或找这家客服看看。`,
      },
      discovered: [],
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const code = networkErrorCode(error)
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return {
        outcome: {
          ok: false,
          code: 'timeout',
          latencyMs,
          message: `连接超时（${Math.round(verifyTimeoutMs / 1000)} 秒没响应）：请检查网络，或确认 baseUrl 与端口写对。`,
        },
        discovered: [],
      }
    }
    if (code === 'ECONNREFUSED') {
      return {
        outcome: {
          ok: false,
          code: 'service-down',
          latencyMs,
          message:
            provider.protocol === 'ollama'
              ? '本地模型服务没启动：请先在终端运行 ollama serve。'
              : '连不上这个地址（对方拒绝了连接），请确认服务已启动、baseUrl 端口写对了。',
        },
        discovered: [],
      }
    }
    // 域名解析不出来 ≠ 路由到了一台机器但连不上：前者是地址/网络写错了（改
    // baseUrl 或换网络），后者是网络或代理把这台挡在外面（改网络或找网管）。
    // 合成一句"网络不可达"会让人两头都改一遍。
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return {
        outcome: {
          ok: false,
          code: 'dns',
          latencyMs,
          message: '域名解析不出来：请检查 baseUrl 里的域名有没有拼错、这台机器的网络是否正常（跟 Key 无关）。',
        },
        discovered: [],
      }
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return {
        outcome: {
          ok: false,
          code: 'unreachable',
          latencyMs,
          message: '网络不可达：这台机器连不到那个地址，可能是网络或代理拦住了，换个网络或让网管放行。',
        },
        discovered: [],
      }
    }
    return {
      outcome: {
        ok: false,
        code: 'error',
        latencyMs,
        message: '暂时连不上这家供应商：稍后再测一次；一直不通就检查 baseUrl，或换个服务商。',
      },
      discovered: [],
    }
  }
}

/** 供应商清单、预设、新增、探测与删除的路由。 */
export function registerProviderRoutes(router: Router, deps: ProviderRoutes): void {
  const { store, dataDir, refreshProviders, verifyTimeoutMs } = deps

  /**
   * 换掉整份供应商配置：落盘 → 热注册，**热注册失败则把落盘一起退回**。
   *
   * 热注册底下的 `replace()` 是原子的——候选集先整体校验，撞名 / 名称非法 / 注册已
   * 释放都抛，内存里的路由原封不动。但 providers.json 是先写完的：只抛不退回，磁盘
   * 就留下一份**从未验证过能否注册**的路由集合，而界面上这次编辑明明"没生效"。那份
   * 配置会在下一次启动才炸，且炸在用户什么都没做的那一次启动上。
   *
   * 落盘顺序不能调换：新增供应商的 `saveApiKey` 只肯给 providers.json 里已存在的
   * 供应商写 key（config.ts 的 saveApiKey），所以两步落盘必须由调用方按顺序塞进
   * persist，而不是各写各的。
   */
  const applyProviderConfig = (options: {
    /** 热注册失败时退回的那份配置。 */
    previous: ProvidersConfigFile
    /** 要落盘并注册的新配置。 */
    next: ProvidersConfigFile
    /** 落盘。默认只写 providers.json。 */
    persist?: () => void
    /** 热注册失败时把落盘也退回（新增供应商要把刚写的凭据摘掉，不留孤儿 key）。 */
    rollbackPersist?: () => void
  }): void => {
    const { previous, next } = options
    const persist =
      options.persist ??
      ((): void => {
        writeProvidersConfig(dataDir, next)
      })
    // 落盘抛了就是磁盘与内存都没动，天然一致，直接往上抛。
    persist()
    try {
      refreshProviders(mergeApiKeys(next, loadApiKeys(dataDir)))
    } catch (cause) {
      // 退回不吞异常：热注册已经失败过一次，真退不回去也要让用户知道磁盘没能还原，
      // 而不是把一次"配置没改成"报成成功。
      options.rollbackPersist?.()
      writeProvidersConfig(dataDir, previous)
      refreshProviders(mergeApiKeys(previous, loadApiKeys(dataDir)))
      throw cause
    }
  }
  /** 落盘/注册失败时要退回的那份配置：providers 映射必须浅拷，deps.providers 是活对象。 */
  const snapshot = (): ProvidersConfigFile => {
    return { ...deps.providers, providers: { ...deps.providers.providers } }
  }

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
      models: input.models.map((model) => {
        return { id: model.id, ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) }
      }),
      custom: true,
      ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
      // 思考强度支持随预设一起落库：用户按向导建好路由后，思考档位选择器就该亮起来，
      // 而不必再手改 providers.json。自定义路由没有预设可依据，保持不声明。
      ...(preset?.reasoningControl === undefined ? {} : { reasoningControl: preset.reasoningControl }),
    }
    next.providers[providerId] = provider
    // 路由先落盘（saveApiKey 只肯给 providers.json 里已有的供应商写 key），再写凭据，
    // 最后热注册——热注册读的就是合并后的内存配置。
    applyProviderConfig({
      previous: snapshot(),
      next,
      persist: () => {
        writeProvidersConfig(dataDir, next)
        if (input.apiKey !== undefined) saveApiKey(dataDir, providerId, input.apiKey)
      },
      rollbackPersist: () => {
        if (input.apiKey !== undefined) deleteApiKey(dataDir, providerId)
      },
    })
    // 助理的默认路由跟着用户挑的那家走（组合根负责真正改 agents 表）。
    // 切了谁一并回给界面：静默改掉用户助理的模型，用户是看不见的。
    const retargeted = deps.onProviderConfigured?.(providerId) ?? []
    json(res, 201, {
      provider: providerInfo(providerId, deps.providers.providers[providerId] as ProviderConfig, []),
      retargeted,
    })
  })

  /**
   * 改供应商：只认 displayName / baseUrl / models / protocol 四个字段，缺省的项
   * 原样保留（前端可以只发改动的那些），其余键丢弃。改完同样热注册，不用重启。
   *
   * models 传的是**声明**而不是"增删补丁"：带 contextWindow 的按它写，没带的清掉旧值
   * （设置页里清空输入框 = 撤掉这一条）。这样"界面上显的那个数字"与 providers.json 里
   * 的那一份永远是同一个值，而内核的请求预算就是按后者算的。
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
    const keptIds = (patch.models ?? provider.models).map((model) => {
      return model.id
    })
    const removed = provider.models
      .map((model) => {
        return model.id
      })
      .filter((modelId) => {
        return !keptIds.includes(modelId)
      })
    const agents = store.listAgents()
    const inUse = modelUsage(agents, providerId, removed)
    if (inUse.length > 0) {
      json(res, 409, { error: modelInUseText(inUse), models: inUse })
      return
    }
    const next: ProvidersConfigFile = {
      ...deps.providers,
      providers: { ...deps.providers.providers },
    }
    next.providers[providerId] = {
      ...provider,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol }),
      baseURL: baseUrl,
      // 声明了模型列表就按它重建：留着的那几条沿用旧条目（name / description 是手写配置的
      // 一部分，不能因为改个顺序就丢），contextWindow 则听这次声明的——用户清空输入框就是
      // 要撤掉这条，界面上已经回到「未知」，配置里也得跟着撤（否则内核还照着旧窗口留历史）。
      models: patch.models === undefined ? provider.models : applyDeclaredModels(provider.models, patch.models),
    }
    applyProviderConfig({ previous: snapshot(), next })
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
   * 永远回 200 + `{ok, code, message, latencyMs, discovered}`：探测失败是设置页
   * 要展示的诊断信息，不是服务端故障。code 是机器可读的分类（见
   * ProviderFailureCode），message 是给人看的中文下一步——两者都不含网络错误码
   * 或内部路径。
   *
   * `discovered` 是这次请求顺手带回的模型目录（模型列表端点的响应体，见
   * parseDiscoveredModels）。设置页的「从供应商拉取模型」直接用它，用户不必再
   * 手打精确的 model id；探测失败时是空数组——连通性结论仍然由 ok/code 说了算。
   */
  router.post('/api/providers/:id/verify', async (req, res) => {
    const providerId = req.params.id as string
    const provider = deps.providers.providers[providerId]
    if (provider === undefined) {
      json(res, 404, { error: `provider not found: ${providerId}` })
      return
    }
    const probe = await probeProvider(provider, verifyTimeoutMs)
    json(res, 200, { ...probe.outcome, discovered: probe.discovered })
  })

  /**
   * 尚未保存的供应商草稿也能拉模型目录（POST /api/providers/discover）。
   *
   * 添加向导里用户正在填的那一条还没有路由 id，没法走 verify；而"必须先存一条空
   * 模型列表的路由再发现模型"会让保存直接 400（模型列表不能为空），也谈不上
   * 体验。这里直接对草稿打一次模型列表端点，**一次性**使用请求里的 Key：不落盘、
   * 不回显、不进适配器配置，与 LlmModelDiscoveryRequest 的约定一致。
   *
   * 与 verify 一样永远回 200 + 中文结论；合法性和 baseUrl 归一走同一套白名单，
   * 出错由 dispatch 回 400。
   */
  router.post('/api/providers/discover', async (req, res) => {
    const input = parseDiscoverInput(await req.body())
    const probe = await probeProvider(
      {
        baseURL: input.baseUrl,
        protocol: input.protocol,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        // 草稿不注册进适配器，models 只是 ProviderConfig 类型上要求的字段；
        // 这里给的空数组永远不会被谁读到。
        models: [],
      },
      verifyTimeoutMs,
    )
    json(res, 200, { ...probe.outcome, models: probe.discovered })
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
    // 凭据先清（不留孤儿 key 在 0600 文件里），再落盘路由。
    deleteApiKey(dataDir, providerId)
    applyProviderConfig({ previous: snapshot(), next })
    json(res, 200, { deleted: providerId })
  })
}
