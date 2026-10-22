/**
 * 模型元数据的唯一真源：把各处拿到的模型条目归一成同一形状，并给出筛选 / 排序 /
 * 分组与「人话」展示。
 *
 * 此前有三份各写各的：`ProviderInfo.models` 的 `{id, name?, contextWindow?}` 被
 * 直接渲染成只显示名字的裸 `<select>`，`contextWindow` 全库无人读（写死在
 * providers.json 里却没人显示）；发现出来的模型又是另一种形状。想让「128K 上下文」
 * 这类用户语言出现在界面上，得先有一个地方把形状与口径定下来——就是这里。
 *
 * 一条硬规矩：**不猜**。OpenAI 兼容的 `/v1/models` 基本只回 id，价格与上下文长度
 * 一概没有；没有就是没有，界面显示「上下文未知」，绝不按模型名推一个数字出来
 * 让用户照着错的长度截断历史。
 *
 * 「按模型名匹配」这条捷径被明确否掉了：`deepseek-chat` 的上下文长度在各家网关、
 * 各版本之间都不一样，`qwen2.5-7b` 后面加不加 `-instruct` 长度也会变。按名字猜出来
 * 的数字看着像知识、实则是编的，用户信了就会照着错的长度截历史——这比老老实实说
 * 「未知」坏得多。缺口只能由人来填（见 {@link ContextWindowEditor}），填的值存进
 * providers.json，服务端据此重注册路由，适配器 resolveModel() 报给内核，内核按它
 * 算请求预算。**界面上显的那个数字就是内核用的那个数字**：中间不再有第二份真值，
 * 也就不存在"界面写着 128K、内核按 64K 算"这种比不给更糟的骗人。
 */
import type { ProviderInfo } from '../api.ts'

/**
 * 这个模型是哪来的。
 *
 * - preset：已经在供应商的模型列表里（预设带的，或用户手写/上次保存的）；
 * - discovered：本次刚从端点发现、还没落盘的候选。
 *
 * 分开的意义在于"能存"与"已存"不是一回事：发现出来的条目在用户勾选并保存之前，
 * 哪个 agent 都不能选它。
 */
export type ModelSource = 'preset' | 'discovered'

/** 价格（每百万 token）。目前没有任何来源会填它——留位而不是编一个 0。 */
export interface ModelPricing {
  inputPerMTokens?: number
  outputPerMTokens?: number
}

/** 能力位（如是否支持图片输入）。同上：端点不报就是未知，不是 false。 */
export interface ModelCapabilities {
  inputModalities?: readonly string[]
}

/** 归一后的一个模型条目：界面各处只认这一种形状。 */
export interface CatalogModel {
  id: string
  name?: string
  /** 上下文长度（token）。端点没报就是 undefined，界面据此说「上下文未知」。 */
  contextWindow?: number
  pricing?: ModelPricing
  capabilities?: ModelCapabilities
  source: ModelSource
}

/** 端点报告的一个模型（服务端 verify / discover 的回执形状）。 */
export interface DiscoveredModel {
  id: string
  name?: string
}

/** 归一前的任意来源条目：ProviderInfo.models 与 DiscoveredModel 的公共形状。 */
export interface ModelLike extends DiscoveredModel {
  contextWindow?: number
}

/**
 * 保存供应商时随模型列表一起发往服务端的条目（POST / PATCH /api/providers 的 models）。
 *
 * 服务端只认这一种形状：裸 id 或带补录上下文长度的对象，服务端按它重写
 * providers.json 里的模型条目，随后这条值一路进到内核的请求预算。
 */
export interface ProviderModelInput {
  id: string
  contextWindow?: number
}

/**
 * 解析用户手填的上下文长度。
 *
 * 只认「人明确敲进来的写法」：整数（131072）、带 k/K（128k）、带 M/m（1m）。
 * 任何其他写法一律回 undefined——宁可显示「上下文未知」，也不能把 `12abc` 猜成 12。
 * 空串与非法值都回 undefined，也就是"清掉这条"。
 */
export function parseContextWindowInput(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const suffix = match[2]?.toLowerCase()
  const value = suffix === 'k' ? amount * 1000 : suffix === 'm' ? amount * 1_000_000 : amount
  // 上下文长度按 token 数取整：带小数的长度没有意义，留着小数只会在展示时炸出来。
  return Math.round(value)
}

/**
 * 编辑表单里各模型输入框的初始值：目录条目 → 用户敲的原文。
 *
 * 只认服务端给的那一份（它就是内核在用的那份）。此前这里读的是本机覆盖层、而表单
 * 重建时又没把覆盖层合回去，于是用户刚填的数字在"重新拉一次模型目录"后凭空消失。
 */
export function contextWindowDrafts(models: readonly CatalogModel[]): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const model of models) {
    drafts[model.id] = model.contextWindow === undefined ? '' : String(model.contextWindow)
  }
  return drafts
}

/**
 * 表单里的输入框原文 + 服务端现有的长度 → 保存时发出去的模型条目。
 *
 * 三种输入框状态各有各的去处：
 * - 写得出来的（`128k`）→ 用它，内核按它算预算；
 * - 空串 → 不带 contextWindow，服务端清掉旧值：用户撤回了这一条，界面与内核都得
 *   跟着回到"未知"；
 * - 看不懂的（`很长`）→ 保持服务端现有的那一份。手滑打出的半个字不该把之前填对的
 *   数字抹掉，用户也还没表达出"不要这条"的意思。
 *
 * 重复 id 取第一次：模型列表是一行一个 id 填出来的，重了就是用户笔误，服务端也
 * 按"同 id 声明两次有歧义"处理。
 */
export function providerModelPayload(
  modelIds: readonly string[],
  drafts: Readonly<Record<string, string>>,
  declared: readonly CatalogModel[] = [],
): ProviderModelInput[] {
  const stored = new Map(
    declared.map((model) => {
      return [model.id, model.contextWindow]
    }),
  )
  const payload: ProviderModelInput[] = []
  for (const id of modelIds) {
    if (
      payload.some((model) => {
        return model.id === id
      })
    )
      continue
    const raw = drafts[id] ?? ''
    const parsed = parseContextWindowInput(raw)
    const contextWindow = raw.trim().length === 0 ? undefined : (parsed ?? stored.get(id))
    payload.push({ id, ...(contextWindow === undefined ? {} : { contextWindow }) })
  }
  return payload
}

/**
 * 把任意来源的模型条目归一成 {@link CatalogModel}。
 *
 * 只搬运端点真给的值：undefined 一律不写进对象，免得下游拿到 `{contextWindow:
 * undefined}` 这种"看着像有值"的空壳。
 */
export function toCatalogModel(raw: ModelLike, source: ModelSource = 'preset'): CatalogModel {
  return {
    id: raw.id,
    ...(raw.name === undefined ? {} : { name: raw.name }),
    ...(raw.contextWindow === undefined ? {} : { contextWindow: raw.contextWindow }),
    source,
  }
}

/** 供应商的模型列表 → 目录条目（ProviderInfo.models 与 DiscoveredModel 同形）。 */
export function catalogFromProvider(provider: ProviderInfo | undefined): CatalogModel[] {
  return (provider?.models ?? []).map((model) => {
    return toCatalogModel(model)
  })
}

/**
 * 端点发现的模型并进目录：已存在的保持原样（连同它已知的名字与上下文长度），
 * 新出现的按端点顺序追加并标成 discovered。
 *
 * 写顺序刻意不动用户的：表单里追加过的模型要留在原位，删到别处再自己调整。
 */
export function mergeDiscovered(
  existing: readonly CatalogModel[],
  discovered: readonly DiscoveredModel[],
): CatalogModel[] {
  const merged: CatalogModel[] = [...existing]
  const seen = new Set(
    existing.map((model) => {
      return model.id
    }),
  )
  for (const model of discovered) {
    if (model.id.length === 0 || seen.has(model.id)) continue
    seen.add(model.id)
    merged.push(toCatalogModel(model, 'discovered'))
  }
  return merged
}

/** 显示名：端点/配置给了就用，否则退回 id（id 本来就是用户要填的东西）。 */
export function modelDisplayName(model: CatalogModel): string {
  return model.name ?? model.id
}

/**
 * 上下文长度的人话：64000 → `64K 上下文`。
 *
 * 不足 1000 的值不做缩写（`512 上下文` 比 `0.5K` 好读）；未知的明确说未知，
 * 不留空也不显示 0。
 */
export function formatContextWindow(contextWindow: number | undefined): string {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return '上下文未知'
  if (contextWindow < 1000) return `${contextWindow} 上下文`
  const thousands = contextWindow / 1000
  const text = Number.isInteger(thousands) ? `${thousands}` : thousands.toFixed(1)
  return `${text}K 上下文`
}

/** 列表里那一行的主标题：名字 + id（两者不同时才都显示）。 */
export function modelTitle(model: CatalogModel): string {
  return model.name === undefined || model.name === model.id ? model.id : `${model.name}（${model.id}）`
}

/** 列表里那一行的副标题：上下文长度 + 是否只是刚发现的候选。 */
export function modelMeta(model: CatalogModel): string {
  const parts = [formatContextWindow(model.contextWindow)]
  if (model.source === 'discovered') parts.push('刚发现')
  return parts.join(' · ')
}

/** 按名字 / id 过滤（设置页与发现面板共用一个搜索框的行为）。 */
export function filterModels(models: readonly CatalogModel[], query: string): CatalogModel[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...models]
  return models.filter((model) => {
    return model.id.toLowerCase().includes(needle) || (model.name ?? '').toLowerCase().includes(needle)
  })
}

/**
 * 排序：上下文大的在前，未知的沉底，最后按 id 稳定排。
 *
 * 未知的沉底而不是按 0 参与比较——"没报"不等于"没有"，把它当成最小值会让用户
 * 以为那几个模型真的只有 0 上下文。
 */
export function sortModels(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => {
    if (a.contextWindow !== b.contextWindow) {
      if (a.contextWindow === undefined) return 1
      if (b.contextWindow === undefined) return -1
      return b.contextWindow - a.contextWindow
    }
    return a.id.localeCompare(b.id)
  })
}

/** 分组的一组：键是厂商前缀（`deepseek-ai/…` 归 deepseek-ai），标题给人看。 */
export interface ModelGroup {
  key: string
  label: string
  models: CatalogModel[]
}

/** 没有 `/` 前缀的那批（`gpt-4o` 这类）的分组键。 */
const UNGROUPED_KEY = ''

/**
 * 按厂商前缀分组：`deepseek-ai/DeepSeek-V3` 与 `deepseek-ai/DeepSeek-R1` 归到
 * 一起，好过一条二十项的长列表。没有前缀的归到「其他」，排在最后。
 */
export function groupModels(models: readonly CatalogModel[]): ModelGroup[] {
  const groups = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const slash = model.id.indexOf('/')
    const key = slash > 0 ? model.id.slice(0, slash) : UNGROUPED_KEY
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [model])
    else bucket.push(model)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === UNGROUPED_KEY) return 1
      if (b === UNGROUPED_KEY) return -1
      return a.localeCompare(b)
    })
    .map(([key, groupModels]) => {
      return { key, label: key === UNGROUPED_KEY ? '其他' : key, models: sortModels(groupModels) }
    })
}
