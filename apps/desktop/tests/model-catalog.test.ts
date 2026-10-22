/**
 * 模型目录与供应商健康缓存的渲染层常驻测试。
 *
 * 这两块此前靠临时探针验证过，探针跑完就删了——于是一份「不猜」的目录真源和一个
 * 带 TTL 的健康缓存都没有回归网：改坏一次（拿模型名推一个 contextWindow、把过期
 * 的绿点继续显示出来）没人会发现。
 *
 * 一条贯穿的规矩：**端点没报的就是没有**。上下文长度、价格、能力位一律不猜，界面
 * 说「上下文未知」；健康结论超过有效期就当没测过，宁可不显示也不显示一个过期的绿点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderInfo } from '../renderer/src/api.ts'
import {
  catalogFromProvider,
  filterModels,
  formatContextWindow,
  groupModels,
  mergeDiscovered,
  modelDisplayName,
  modelMeta,
  modelTitle,
  sortModels,
  toCatalogModel,
} from '../renderer/src/lib/model-catalog.ts'
import {
  clearProviderHealth,
  forgetProviderHealth,
  providerHealth,
  providersByReadiness,
  rememberProviderHealth,
} from '../renderer/src/lib/provider-health.ts'

function providerInfo(overrides: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return { displayName: overrides.id, apiKeyConfigured: false, models: [], ...overrides }
}

describe('目录归一', () => {
  it('只搬运端点真给的字段：没有的键干脆不写（不是写成 undefined 的空壳）', () => {
    const bare = toCatalogModel({ id: 'gpt-4o' })
    expect(bare).toEqual({ id: 'gpt-4o', source: 'preset' })
    expect('contextWindow' in bare).toBe(false)
    expect('name' in bare).toBe(false)
    const full = toCatalogModel(
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 64_000 },
      'discovered',
    )
    expect(full).toEqual({
      id: 'deepseek-ai/DeepSeek-V3',
      name: 'DeepSeek V3',
      contextWindow: 64_000,
      source: 'discovered',
    })
  })

  it('供应商的模型列表逐条归一；这家没有列表或压根没这家时都回空数组', () => {
    const provider = providerInfo({
      id: 'siliconflow',
      models: [{ id: 'a' }, { id: 'b', contextWindow: 128_000 }],
    })
    expect(catalogFromProvider(provider)).toEqual([
      { id: 'a', source: 'preset' },
      { id: 'b', contextWindow: 128_000, source: 'preset' },
    ])
    expect(catalogFromProvider(providerInfo({ id: 'empty', models: [] }))).toEqual([])
    expect(catalogFromProvider(undefined)).toEqual([])
  })
})

describe('发现结果并入目录（去重）', () => {
  it('已存在的保持原样：连同它已知的名字与上下文长度，重复项不覆盖', () => {
    const existing = [toCatalogModel({ id: 'a', name: '用户改过的名字', contextWindow: 8_000 })]
    expect(mergeDiscovered(existing, [{ id: 'a', name: '端点报的名字' }, { id: 'b' }, { id: 'c', name: 'C' }])).toEqual(
      [
        { id: 'a', name: '用户改过的名字', contextWindow: 8_000, source: 'preset' },
        { id: 'b', source: 'discovered' },
        { id: 'c', name: 'C', source: 'discovered' },
      ],
    )
  })

  it('发现结果自身重复只留第一条；空 id 直接丢掉（没有 id 建不出路由）', () => {
    expect(mergeDiscovered([], [{ id: 'dup' }, { id: 'dup', name: '后来的' }, { id: '' }])).toEqual([
      { id: 'dup', source: 'discovered' },
    ])
  })

  it('不改动用户书写的顺序：已存在的留在原位，新发现的追加在后面', () => {
    const existing = [toCatalogModel({ id: 'z' }), toCatalogModel({ id: 'a' })]
    expect(mergeDiscovered(existing, [{ id: 'm' }]).map((model) => model.id)).toEqual(['z', 'a', 'm'])
  })
})

describe('上下文长度：没有就是没有，不猜', () => {
  it('缺失或非法一律显示「上下文未知」，界面上不会出现猜的数字', () => {
    expect(formatContextWindow(undefined)).toBe('上下文未知')
    expect(formatContextWindow(Number.NaN)).toBe('上下文未知')
    expect(formatContextWindow(Number.POSITIVE_INFINITY)).toBe('上下文未知')
    expect(formatContextWindow(0)).toBe('上下文未知')
    expect(formatContextWindow(-8_000)).toBe('上下文未知')
  })

  it('有值才缩写：不足千不缩写（`512 上下文` 比 `0.5K` 好读），带小数不四舍五入掉', () => {
    expect(formatContextWindow(128_000)).toBe('128K 上下文')
    expect(formatContextWindow(64_000)).toBe('64K 上下文')
    expect(formatContextWindow(32_500)).toBe('32.5K 上下文')
    expect(formatContextWindow(512)).toBe('512 上下文')
  })

  it('那一行把未知与「刚发现」并排说清，不留空位', () => {
    expect(modelMeta(toCatalogModel({ id: 'x' }))).toBe('上下文未知')
    expect(modelMeta(toCatalogModel({ id: 'x' }, 'discovered'))).toBe('上下文未知 · 刚发现')
    expect(modelMeta(toCatalogModel({ id: 'x', contextWindow: 8_000 }))).toBe('8K 上下文')
  })

  it('显示名退回 id（id 本来就是用户要填的东西）；名字与 id 相同则不重复显示', () => {
    expect(modelDisplayName(toCatalogModel({ id: 'qwen3' }))).toBe('qwen3')
    expect(modelTitle(toCatalogModel({ id: 'qwen3', name: 'Qwen3' }))).toBe('Qwen3（qwen3）')
    expect(modelTitle(toCatalogModel({ id: 'qwen3', name: 'qwen3' }))).toBe('qwen3')
  })
})

describe('排序与分组', () => {
  it('上下文大的在前，未知的沉底，同档按 id 稳定排；入参顺序不动', () => {
    const models = [
      toCatalogModel({ id: 'small', contextWindow: 4_000 }),
      toCatalogModel({ id: 'unknown-b' }),
      toCatalogModel({ id: 'big', contextWindow: 128_000 }),
      toCatalogModel({ id: 'unknown-a' }),
      toCatalogModel({ id: 'mid', contextWindow: 64_000 }),
    ]
    expect(sortModels(models).map((model) => model.id)).toEqual(['big', 'mid', 'small', 'unknown-a', 'unknown-b'])
    expect(models.map((model) => model.id)).toEqual(['small', 'unknown-b', 'big', 'unknown-a', 'mid'])
  })

  it('未知不按 0 参与比较——那会让界面暗示「这几个模型只有 0 上下文」', () => {
    const sorted = sortModels([toCatalogModel({ id: 'u' }), toCatalogModel({ id: 'z', contextWindow: 1 })])
    expect(sorted.map((model) => model.id)).toEqual(['z', 'u'])
  })

  it('按厂商前缀分组；无前缀的归「其他」排最后，组内仍按上下文排序', () => {
    const groups = groupModels([
      toCatalogModel({ id: 'gpt-4o' }),
      toCatalogModel({ id: 'deepseek-ai/DeepSeek-R1' }),
      toCatalogModel({ id: 'meta/llama-3', contextWindow: 8_000 }),
      toCatalogModel({ id: 'deepseek-ai/DeepSeek-V3', contextWindow: 64_000 }),
    ])
    expect(groups.map((group) => group.key)).toEqual(['deepseek-ai', 'meta', ''])
    expect(groups[0]?.models.map((model) => model.id)).toEqual(['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'])
    expect(groups[2]?.label).toBe('其他')
  })
})

describe('过滤', () => {
  const models = [
    toCatalogModel({ id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' }),
    toCatalogModel({ id: 'gpt-4o' }),
  ]

  it('空查询原样返回全部（不是空列表）', () => {
    expect(filterModels(models, '   ')).toEqual(models)
  })

  it('按 id 或名字匹配，忽略大小写；匹配不到就是空数组', () => {
    expect(filterModels(models, 'deepseek').map((model) => model.id)).toEqual(['deepseek-ai/DeepSeek-V3'])
    expect(filterModels(models, 'GPT').map((model) => model.id)).toEqual(['gpt-4o'])
    expect(filterModels(models, '  v3  ').map((model) => model.id)).toEqual(['deepseek-ai/DeepSeek-V3'])
    expect(filterModels(models, '不存在的模型')).toEqual([])
  })
})

describe('健康缓存的 TTL 与作废', () => {
  beforeEach(() => {
    clearProviderHealth()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    clearProviderHealth()
  })

  it('结论留十分钟：到点后当没测过（宁可不显示，也不显示一个过期的绿点）', () => {
    rememberProviderHealth('p', { ok: true, latencyMs: 120 })
    expect(providerHealth('p')).toMatchObject({ code: 'ok', latencyMs: 120 })
    vi.setSystemTime(new Date('2026-10-16T00:09:59Z'))
    expect(providerHealth('p')?.code).toBe('ok')
    vi.setSystemTime(new Date('2026-10-16T00:10:01Z'))
    expect(providerHealth('p')).toBeUndefined()
  })

  it('没给分类的老服务端照样按 ok 记；失败没分类时记 error，不从中文话里猜关键词', () => {
    rememberProviderHealth('a', { ok: true })
    expect(providerHealth('a')?.code).toBe('ok')
    rememberProviderHealth('b', { ok: false, latencyMs: 30 })
    expect(providerHealth('b')).toMatchObject({ code: 'error', latencyMs: 30 })
    rememberProviderHealth('c', { ok: false, code: 'rate-limited' })
    expect(providerHealth('c')?.code).toBe('rate-limited')
  })

  it('换 key、改地址、删供应商之后，上一次的结论立刻作废', () => {
    rememberProviderHealth('p', { ok: true })
    rememberProviderHealth('q', { ok: true })
    forgetProviderHealth('p')
    expect(providerHealth('p')).toBeUndefined()
    expect(providerHealth('q')?.code).toBe('ok')
  })

  it('排序跟着结论走：刚验过的最前，被限流的降权，没凭据的垫底但仍可选', () => {
    const list = [
      providerInfo({ id: 'nokey' }),
      providerInfo({ id: 'limited', apiKeyConfigured: true }),
      providerInfo({ id: 'ok', apiKeyConfigured: true }),
    ]
    rememberProviderHealth('limited', { ok: false, code: 'rate-limited' })
    rememberProviderHealth('ok', { ok: true })
    expect(providersByReadiness(list).map((item) => item.id)).toEqual(['ok', 'limited', 'nokey'])
    // 结论过期后绿点撤掉，这家退回「凭据已备但未验证」那一档。
    vi.setSystemTime(new Date('2026-10-16T00:11:00Z'))
    expect(providersByReadiness(list).map((item) => item.id)).toEqual(['limited', 'ok', 'nokey'])
  })
})
