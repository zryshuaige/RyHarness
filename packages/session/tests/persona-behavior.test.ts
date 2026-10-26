import { composePersonaPrompt, normalizePersona, TRAIT_META, type TraitKey, traitBand } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

const situations = ['澄清需求', '交付结果', '承认失败', '主动提醒', '日常闲聊'] as const
const scenarios = TRAIT_META.flatMap((meta) => {
  return situations.map((situation) => {
    return { trait: meta.key, situation }
  })
})

function promptWith(trait: TraitKey, value: number): string {
  return composePersonaPrompt('你是用户的长期工作伙伴。', normalizePersona({ [trait]: value }))
}

describe('人格行为契约：四维 × 五个高频场景，共 20 个可重复评测入口', () => {
  it('场景矩阵确实是 20 条，覆盖每个维度', () => {
    expect(scenarios).toHaveLength(20)
    expect(new Set(scenarios.map((scenario) => scenario.trait))).toEqual(new Set(TRAIT_META.map((meta) => meta.key)))
  })

  for (const scenario of scenarios) {
    it(`${scenario.situation}：${scenario.trait} 的强弱档位给模型不同且明确的行为指令`, () => {
      const low = promptWith(scenario.trait, 0)
      const high = promptWith(scenario.trait, 100)
      expect(low).not.toBe(high)
      for (const [value, prompt] of [
        [0, low],
        [100, high],
      ] as const) {
        const meta = TRAIT_META.find((candidate) => candidate.key === scenario.trait)
        if (meta === undefined) throw new Error('人格维度不存在')
        const band = traitBand(meta, value)
        expect(prompt).toContain(`${scenario.trait === 'rigor' ? '严谨' : meta.label} ${value}/100`)
        expect(prompt).toContain(band.describe)
        expect(prompt).toContain('长期工作伙伴')
      }
    })
  }

  it('严肃交付时人格段落不会强迫模型卖萌或每句塞口头禅', () => {
    const prompt = composePersonaPrompt(
      '交付失败时先说清事实和修复办法，不要玩笑。',
      normalizePersona({ humor: 100, catchphrase: '喵' }),
    )
    expect(prompt).toContain('别每句都塞')
    expect(prompt).toContain('先说清事实和修复办法')
  })
})
