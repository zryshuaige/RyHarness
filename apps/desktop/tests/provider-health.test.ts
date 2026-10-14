/**
 * 供应商可用性判定的唯一真源：三态、免 key 的本地服务、以及失败原因的人话化。
 * 这几行一旦在两个地方各写一份，欢迎页与「我的」页就会对同一个供应商给出相反结论。
 */
import { describe, expect, it } from 'vitest'
import type { ProviderInfo } from '../renderer/src/api.ts'
import {
  explainModelMismatch,
  explainVerifyFailure,
  firstProviderMissingKey,
  firstUsableProviderId,
  hasUsableProvider,
  isLocalService,
  isProviderUsable,
  providerModelIds,
  providerStatus,
  providerStatusText,
  providersByReadiness,
  providerUsage,
} from '../renderer/src/lib/provider-health.ts'

function provider(overrides: Partial<ProviderInfo> & { id: string }): ProviderInfo {
  return { displayName: overrides.id, apiKeyConfigured: false, models: [], ...overrides }
}

describe('三态', () => {
  it('没 key → 未配置凭据；只有 key 没测 → 凭据已备；测过才叫已验证', () => {
    const bare = provider({ id: 'deepseek' })
    const keyed = provider({ id: 'deepseek', apiKeyConfigured: true })
    expect(providerStatus(bare, false)).toBe('unconfigured')
    expect(providerStatus(bare, true)).toBe('unconfigured')
    expect(providerStatus(keyed, false)).toBe('ready')
    expect(providerStatus(keyed, true)).toBe('verified')
    expect(providerStatusText('unconfigured')).toBe('未配置凭据')
    expect(providerStatusText('ready')).toBe('凭据已备（未验证）')
  })

  it('免 key 的本地服务自成一态，不参与「有没有 key」这套说法', () => {
    const ollama = provider({ id: 'ollama', protocol: 'ollama' })
    expect(isLocalService(ollama)).toBe(true)
    expect(providerStatus(ollama, false)).toBe('local')
    expect(providerStatus(ollama, true)).toBe('local')
    expect(providerStatusText('local')).toBe('本地服务')
    // 没有 key 但照样可用：不能因此把用户按去填 key。
    expect(isProviderUsable(ollama)).toBe(true)
  })
})

describe('可用性与默认选择', () => {
  const list = [
    provider({ id: 'deepseek' }),
    provider({ id: 'siliconflow', apiKeyConfigured: true }),
    provider({ id: 'ollama', protocol: 'ollama' }),
  ]

  it('默认供应商是第一个配好凭据或免 key 的，不是列表里的第一个', () => {
    expect(firstUsableProviderId(list)).toBe('siliconflow')
    expect(hasUsableProvider(list)).toBe(true)
    expect(hasUsableProvider([provider({ id: 'deepseek' })])).toBe(false)
  })

  it('下拉排序：可用的在前，没配 key 的降权但没被丢掉', () => {
    const ordered = providersByReadiness(list).map((item) => {
      return item.id
    })
    expect(ordered).toEqual(['siliconflow', 'ollama', 'deepseek'])
    expect(ordered).toHaveLength(list.length)
  })

  it('提醒补 key 时跳过免 key 的本地服务（它没有 key 可填）', () => {
    expect(firstProviderMissingKey(list)?.id).toBe('deepseek')
    expect(firstProviderMissingKey([provider({ id: 'ollama', protocol: 'ollama' })])).toBeUndefined()
  })
})

describe('错误文案', () => {
  it('401 / 403 归到「凭据被拒绝」，并说清下一步', () => {
    expect(explainVerifyFailure('401 Unauthorized')).toContain('更换 Key')
    expect(explainVerifyFailure('invalid api key')).toContain('凭据被供应商拒绝')
    expect(explainVerifyFailure('HTTP 404')).toContain('测试连接')
    expect(explainVerifyFailure('fetch failed')).toContain('Base URL')
    expect(explainVerifyFailure('429 rate limited')).toContain('限流')
    expect(explainVerifyFailure(undefined)).toContain('稍后再试')
    // 服务端已经给了中文原因时不要改写它。
    expect(explainVerifyFailure('余额不足')).toContain('余额不足')
  })

  it('model 不属于该供应商：给出人话，不让保存', () => {
    expect(explainModelMismatch('SiliconFlow', ['a', 'b'])).toContain('SiliconFlow')
    expect(explainModelMismatch('SiliconFlow', [])).toContain('模型供应商')
  })

  it('使用者的缺省形态：后端没下发 usedBy 时是空数组，不是 undefined', () => {
    expect(providerUsage(provider({ id: 'x' }))).toEqual([])
    expect(providerUsage(provider({ id: 'x', usedBy: [{ agentId: 'a', agentName: '小译' }] }))).toHaveLength(1)
    expect(providerModelIds(undefined)).toEqual([])
  })
})
