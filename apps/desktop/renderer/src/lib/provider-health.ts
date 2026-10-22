/**
 * 供应商「能不能用」的唯一判定处。
 *
 * 此前有三份各自为政的判断：ProviderSettings 的 `isKeylessProtocol`、WelcomeHome
 * 的一句 `!p.apiKeyConfigured`、ContactsPage 下拉里的 `p.apiKeyConfigured ? '' :
 * '（未配置 key）'`。三份对「Ollama 算不算已配置」的答案并不一致——欢迎页会把
 * 「先填一个 API Key」推到本地用户脸上，而 Ollama 压根没有 key 可填。
 *
 * 这里定下三态（外加免 key 的本地服务单独一态）：
 * - unconfigured：没有凭据，聊天一定失败；
 * - ready：凭据已备但没验过——key 存下来了，不等于这家供应商认；
 * - verified：测过连接且通过；
 * - local：免 key 的本地服务（Ollama 这类），能不能用取决于探活。
 *
 * 「测过没有」不留在设置页的组件 state 里：模块级的 {@link providerHealth} 缓存
 * 才是真源，这样设置页之外的供应商下拉（新建 agent 的表单）也能按"这家刚测过没有"
 * 排序，而那些页面从没打开过设置页。
 */
import type { ProviderInfo, ProviderVerifyResult } from '../api.ts'
import { humanError } from './error-text.ts'
import type { DiscoveredModel } from './model-catalog.ts'

export type { DiscoveredModel }

/** 供应商的使用者（GET /api/providers 每项的 usedBy）。 */
export interface ProviderUsage {
  agentId: string
  agentName: string
}

export type ProviderStatus = 'unconfigured' | 'ready' | 'verified' | 'local'

/** 免 key 的协议：跑在本机的模型服务，填 key 反而是错的。 */
export function isKeylessProtocol(protocol: string | undefined): boolean {
  return protocol === 'ollama'
}

/** 免 key 的供应商即本地服务：不需要凭据，通不通靠探活。 */
export function isLocalService(provider: ProviderInfo): boolean {
  return isKeylessProtocol(provider.protocol)
}

/** 供应商的三态（verified 由调用方给出：测过连接才算）。 */
export function providerStatus(provider: ProviderInfo, verified: boolean): ProviderStatus {
  if (isLocalService(provider)) return 'local'
  if (!provider.apiKeyConfigured) return 'unconfigured'
  return verified ? 'verified' : 'ready'
}

const STATUS_TEXT: Record<ProviderStatus, string> = {
  unconfigured: '未配置凭据',
  ready: '凭据已备（未验证）',
  verified: '已验证',
  local: '本地服务',
}

/** 状态的中文说法；界面上只此一份，别处不要另写。 */
export function providerStatusText(status: ProviderStatus): string {
  return STATUS_TEXT[status]
}

/** 探不通时的说法：别让用户以为「没配 key」，本地服务是没有 key 这回事的。 */
export const LOCAL_SERVICE_DOWN = '未检测到本地服务'

/** 凭据已备（有没有 key 的那件事）；免 key 的本地服务视为天然可用。 */
export function isProviderUsable(provider: ProviderInfo): boolean {
  return provider.apiKeyConfigured || isLocalService(provider)
}

/** 没有任何可用的供应商时，聊天必然失败（欢迎页据此先要 key）。 */
export function hasUsableProvider(providers: ProviderInfo[]): boolean {
  return providers.some(isProviderUsable)
}

/** 该提醒补 key 的供应商：跳过免 key 的本地服务，它没有 key 可填。 */
export function firstProviderMissingKey(providers: ProviderInfo[]): ProviderInfo | undefined {
  return missingKeyProviders(providers)[0]
}

/** 新建 agent 时的默认供应商：第一个配好凭据或免 key 的。 */
export function firstUsableProviderId(providers: ProviderInfo[]): string | undefined {
  return providers.find(isProviderUsable)?.id
}

/**
 * 一次探测记下的健康结论。
 *
 * 存在模块级而不是组件 state 里：设置页之外的下拉（新建 agent 的供应商选择）也
 * 要按"这家刚测过没有"排序，而那些页面根本没打开过设置页。
 */
export interface ProviderHealth {
  /** 与服务端同一套取值（见 {@link ProviderFailureCode}）。 */
  code: ProviderFailureCode
  latencyMs: number
  /** 记下这条结论的时刻（Date.now）。 */
  at: number
}

/**
 * 结论的有效期。取十分钟：换 key / 改地址会立刻作废（见 forgetProviderHealth），
 * 剩下的失效只可能来自"供应商那边变了"，十分钟足够旧，绿点也不会每分钟闪一次。
 */
const PROVIDER_HEALTH_TTL_MS = 10 * 60_000

/** 免 key 的本地服务重新探活的间隔：Ollama 常常是用户启动之后才起来的。 */
export const PROVIDER_HEALTH_POLL_MS = 60_000

const healthCache = new Map<string, ProviderHealth>()

/**
 * 记下一次探测结论（verify / 探活都往这里写）。
 *
 * 只记**有 code 的**结论：老服务端可能只回 ok + 中文话，那种结果照样按 ok 记，
 * 但不猜它的失败分类——排序靠的是分类，不是中文原文里的关键词。
 */
export function rememberProviderHealth(
  providerId: string,
  result: { ok: boolean; code?: ProviderFailureCode; latencyMs?: number },
): void {
  healthCache.set(providerId, {
    code: result.ok ? 'ok' : (result.code ?? 'error'),
    latencyMs: result.latencyMs ?? 0,
    at: Date.now(),
  })
}

/** 这家刚测过没有（超期的结论当作没测过：宁可不显示，也不显示一个过期的绿点）。 */
export function providerHealth(providerId: string): ProviderHealth | undefined {
  const health = healthCache.get(providerId)
  if (health === undefined) return undefined
  return Date.now() - health.at <= PROVIDER_HEALTH_TTL_MS ? health : undefined
}

/** 结论作废：换了 key、改了地址、删了供应商之后，上一次的绿点说的已经不是现在这家。 */
export function forgetProviderHealth(providerId: string): void {
  healthCache.delete(providerId)
}

/** 清空全部结论（测试之间隔离用；正常运行没人调）。 */
export function clearProviderHealth(): void {
  healthCache.clear()
}

/**
 * 下拉里的排序权重：刚验过的最前，能用的其次，此刻被限流的降权（等一分钟就好，
 * 不该挡在别家前面），没凭据的垫底但仍然可选。
 */
function readinessRank(provider: ProviderInfo): number {
  const health = providerHealth(provider.id)
  if (health?.code === 'rate-limited') return 0
  if (health?.code === 'ok') return 3
  return isProviderUsable(provider) ? 2 : -1
}

/**
 * 下拉里的排序：可用的在前，没配 key 的降权到后面但仍然可选。
 * 「降权」是排序 + 标注，不是禁用——用户有时就是想先建好 agent 再去补 key。
 *
 * 同权重内保持传入顺序（稳定排序）：清单顺序本身就是内置优先的手工编排，不该被
 * 排序偷偷打乱。
 */
export function providersByReadiness(providers: ProviderInfo[]): ProviderInfo[] {
  return [...providers].sort((a, b) => {
    return readinessRank(b) - readinessRank(a)
  })
}

/** 还没配凭据的云端供应商（免 key 的本地服务不算：它没有 key 可填）。 */
export function missingKeyProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((provider) => {
    return !isLocalService(provider) && !provider.apiKeyConfigured
  })
}

/**
 * 「一个能用的模型来源都没有」时的话：把可选的几条路一次说清。
 *
 * 此前只点名缺 key 的第一家，于是本地用户（已经装了 Ollama、压根没有 key 可填）
 * 也被推去申请云端 key。补 key、装本地服务、换一家云端是三条并列的路，文案就该
 * 三条都给——只给一条，用户会以为那条是唯一的路。
 */
export function missingProviderHint(providers: ProviderInfo[]): string | undefined {
  if (hasUsableProvider(providers)) return undefined
  const names = missingKeyProviders(providers).map((provider) => {
    return provider.displayName
  })
  const routes = [
    names.length > 0 ? `给「${names.join('、')}」填一个 API Key` : '添加一家云端服务商并填 API Key',
    '添加 Ollama（本地）这样的免 key 服务',
    '换一个云端服务商',
  ]
  return `还没有能用的模型来源，任选一条路：${routes.join('；')}。不必三条都做。`
}

/** 正在使用这家供应商的 agent（缺省 = 没人用，后端未下发 usedBy 时不编）。 */
export function providerUsage(provider: ProviderInfo): ProviderUsage[] {
  return provider.usedBy ?? []
}

/** 供应商的模型 id 列表（配置表单断言 model ∈ models 用）。 */
export function providerModelIds(provider: ProviderInfo | undefined): string[] {
  return (provider?.models ?? []).map((model) => {
    return model.id
  })
}

/**
 * 校验结果错了的原因（中文、可照着做）。
 * `false` 表示可以存。
 */
export function explainModelMismatch(providerName: string, validModels: readonly string[]): string {
  if (validModels.length === 0) return `「${providerName}」还没有可选模型，先在「我的 → 模型供应商」里补上模型列表。`
  return `当前模型不属于「${providerName}」，请重新选择它提供的模型（不能留着别的供应商的模型）。`
}

/**
 * 测连接失败的分类，与服务端 `ProviderFailureCode`（apps/server/src/routes/providers.ts）
 * 同一套取值。两边能对上，界面就能靠 code 分支，而不是拿中文原文做关键词匹配。
 *
 * 取值只描述用户看得懂的现象：没有网络错误码、没有内部路径——那些是排查看的。
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

/** verify 的回执：与 api.ts 的 ProviderVerifyResult 同形，多一个服务端给的分类。 */
export interface ProviderVerifyResponse extends ProviderVerifyResult {
  code?: ProviderFailureCode
  /**
   * 探测顺带回的模型目录（服务端解析 `/v1/models` / Ollama tags 得到）。
   *
   * 老服务端没有这个字段，所以是可选的：有就填模型列表，没有就退回手输。
   */
  discovered?: DiscoveredModel[]
}

/** POST /api/providers/discover 的回执：对一份还没保存的供应商草稿问出来的目录。 */
export interface ProviderDiscoveryResponse {
  ok: boolean
  code?: ProviderFailureCode
  /** 失败时是服务端给的中文下一步（同 verify）。 */
  message?: string
  latencyMs?: number
  /** 端点自己报告的模型；只含它真报出来的字段。 */
  models?: DiscoveredModel[]
}

/** 分类 → 一句能照着做的话（服务端没回话时的兜底；两端口径一致）。 */
export const FAILURE_TEXT: Record<ProviderFailureCode, string> = {
  ok: '连接正常。',
  'no-key': '还没填 API Key：先在这行里粘贴 Key，再回来测一次。',
  'bad-key': '凭据被供应商拒绝（Key 填错、已过期或没开权限），请更换 Key 后再试。',
  'rate-limited': '被限流了：等一两分钟再测就行，Key 本身没问题。',
  'not-found': '接口不存在：这版服务端还没有「测试连接」，换个版本或直接发消息看能不能通。',
  'service-down': '服务没启动或端口没开：确认服务正在运行、Base URL 里的端口写对了。',
  dns: '域名解析不出来：检查 Base URL 里的域名拼写与本机网络（与 Key 无关）。',
  unreachable: '网络不可达：这台机器连不到那个地址，可能是网络或代理拦住了。',
  timeout: '连接超时：请检查网络，或确认 Base URL 与端口写对。',
  error: '暂时连不上这家供应商：稍后再试一次；一直不通就换个服务商。',
}

/**
 * 测连接失败时的人话版本。
 *
 * 服务端 verify 回的 message 有时是英文的 `401 Unauthorized`，直接弹给用户等于
 * 把内部协议摆上台面；但反过来，**有 code 时不要改写服务端的话**——它已经按
 * 「现象 → 下一步」写好了，拿原文再按关键词猜一遍只会把它改错（「还没填 API Key」
 * 里有 "API Key"，会被 401 那条规则改写成「凭据被供应商拒绝」）。
 *
 * 所以：认得 code 就以服务端的话为准（只为它空着时兜底），不认得 code（老服务端）
 * 才走模式匹配，并且永远不把内部路由路径、网络错误码原样弹给用户。
 *
 * 走到最后一条（什么都没匹配上）时也不递原文，交给 lib/error-text.ts：认得出的
 * 服务端字面量在那里有中文，认不出的给一句兜底。原话由调用点折进「详情」。
 */
export function explainVerifyFailure(raw: string | undefined, code?: string): string {
  const text = (raw ?? '').trim()
  const known = code === undefined ? undefined : FAILURE_TEXT[code as ProviderFailureCode]
  if (known !== undefined) return text.length > 0 ? text : known
  if (text.length === 0) return '连接失败：供应商没给出原因，可以稍后再试一次。'
  const lower = text.toLowerCase()
  if (/^not found: |^http 404$/.test(lower)) {
    return FAILURE_TEXT['not-found']
  }
  if (/enotfound|eai_again|dns|no such host/.test(lower)) {
    return FAILURE_TEXT.dns
  }
  if (/econnrefused|connection refused/.test(lower)) {
    return '服务没启动或端口没开：确认服务正在运行、Base URL 里的端口与协议写对了。'
  }
  if (/429|rate.?limit|too many/.test(lower)) {
    return FAILURE_TEXT['rate-limited']
  }
  if (/401|403|unauthor|forbidden|invalid[_ -]?api[_ -]?key|api[_ -]?key/.test(lower)) {
    return '凭据被供应商拒绝（Key 填错、已过期或没开权限），请更换 Key 后再试。'
  }
  if (/econnreset|econnaborted|etimedout|timeout|timed out|fetch failed|network|unreachable/.test(lower)) {
    return '连不上这家供应商：请先看网络，再核对 Base URL 填得对不对（服务商地址通常以 /v1 结尾）。'
  }
  if (/not found|404/.test(lower)) {
    return FAILURE_TEXT['not-found']
  }
  return `连接失败：${humanError(text, '供应商没给出原因，可以稍后再试一次。')}`
}

/** 两个 Base URL 是否指向同一家服务（忽略大小写与尾部斜杠；与服务端同款判重）。 */
export function sameBaseUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()
}

/**
 * 已经指向这个地址的那条供应商。
 *
 * 添加向导靠它把「点过一次的预设」标成已添加：同一个 baseUrl 只能有一条路由，
 * 再点一次要么被服务端 409 挡下，要么退化成一条丢品牌图标的重复项——两种都算
 * 没提示到位，所以界面先自己认出来。
 */
export function providerByBaseUrl(providers: readonly ProviderInfo[], baseUrl: string): ProviderInfo | undefined {
  return providers.find((provider) => {
    return provider.baseUrl !== undefined && sameBaseUrl(provider.baseUrl, baseUrl)
  })
}

/** 编辑表单里被删掉的模型 id（旧列表里有、新列表里没有）。 */
export function removedModelIds(previous: readonly string[], next: readonly string[]): string[] {
  return previous.filter((modelId) => {
    return !next.includes(modelId)
  })
}

/**
 * 删掉模型 id 之前的提醒。
 *
 * 删模型和删供应商是同一类事故：引用它的 agent 会静默变成转不起来的砖。服务端
 * 拿得到「哪个 agent 用的是哪个模型」，界面上只有这家供应商的 usedBy，所以这里
 * 给出的是提醒 + 保存后的权威拦截（服务端 409 会点名到 agent）。
 */
export function modelRemovalHint(
  providerName: string,
  removed: readonly string[],
  usedBy: readonly ProviderUsage[],
): string | undefined {
  if (removed.length === 0) return undefined
  const names = usedBy
    .map((item) => {
      return item.agentName
    })
    .join('、')
  const target = usedBy.length > 0 ? `正在用「${providerName}」的 ${names}` : '任何用它的 agent'
  return `删掉 ${removed.join('、')} 后，${target} 可能转不起来：先到通讯录把它们改绑到别的模型再保存。`
}
