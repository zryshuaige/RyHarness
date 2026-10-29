/**
 * 人格模块的「查表类」公开函数：维度定义、音色显示名、温度建议、生日归一。
 *
 * 这几个都是渲染层与内核真正在调的公开函数，此前只有类型与签名、没有任何用例——
 * 于是覆盖率棘轮把它们记成未覆盖（persona.ts 一度欠 17 行、超过 16 的上限）。
 *
 * 棘轮要的是「新写的公开函数带着用例进来」，所以这里补的是**行为断言**而不是
 * 为了凑覆盖率而跑的函数：每条都写清它对用户意味着什么。
 */

import {
  affinityTier,
  clampTrait,
  normalizeBirthday,
  PERSONA_DEFAULTS,
  suggestTemperature,
  traitBand,
  traitMeta,
  voiceName,
} from '@ryharness/session'
import { registerVoiceProfile } from '@ryharness/voice'
import { describe, expect, it } from 'vitest'

describe('维度定义与档位', () => {
  it('按 key 取回该维度的定义：描述、标签与档位都在里面', () => {
    const rigor = traitMeta('rigor')
    expect(rigor.key).toBe('rigor')
    expect(rigor.label.length).toBeGreaterThan(0)
    expect(rigor.bands.length).toBeGreaterThan(0)
    // 档位按上限递增，界面按分数落到其中一档。
    const maxes = rigor.bands.map((band) => {
      return band.max
    })
    expect(
      [...maxes].sort((a, b) => {
        return a - b
      }),
    ).toEqual(maxes)
  })

  it('分数越界先夹紧再查档位：脏数据不会让界面显示空档位', () => {
    const meta = traitMeta('rigor')
    expect(clampTrait(999)).toBe(100)
    expect(traitBand(meta, 999)).toEqual(traitBand(meta, 100))
    expect(traitBand(meta, -50)).toEqual(traitBand(meta, 0))
  })

  it('亲密度分档同理：超界分数落到最高档而不是空档', () => {
    expect(affinityTier(999)).toEqual(affinityTier(100))
    expect(affinityTier(0).max).toBeGreaterThan(0)
  })
})

describe('音色显示名', () => {
  it('静态目录里的音色回目录里的名字', () => {
    expect(voiceName('none')).toBe('不朗读')
  })

  it('运行时注册进来的音色（声线文件那条）回目录里的名字', () => {
    registerVoiceProfile({
      id: 'test-registered-voice',
      name: '测试音色',
      engine: 'minimax',
      voice: 'test-voice',
      sampleText: '你好',
      description: '用例注册的临时音色',
    })
    expect(voiceName('test-registered-voice')).toBe('测试音色')
  })

  it('谁都不认识的 id 回「未知音色」，而不是静默显示空串', () => {
    expect(voiceName('definitely-not-a-voice')).toBe('未知音色')
  })
})

describe('温度建议', () => {
  it('只是建议，不改用户的采样参数：幽默高、严谨低时给的值更高', () => {
    const playful = suggestTemperature({ ...PERSONA_DEFAULTS, humor: 100, rigor: 0 })
    const strict = suggestTemperature({ ...PERSONA_DEFAULTS, humor: 0, rigor: 100 })
    expect(playful).toBeGreaterThan(strict)
  })

  it('结果夹在 0.1 ~ 1.6 之间，且只到一位小数', () => {
    const value = suggestTemperature(PERSONA_DEFAULTS)
    expect(value).toBeGreaterThanOrEqual(0.1)
    expect(value).toBeLessThanOrEqual(1.6)
    expect(value).toBe(Math.round(value * 10) / 10)
  })
})

describe('生日归一', () => {
  it('完整日期砍成月日：提示词、右栏、卡片看到的是同一个样子', () => {
    expect(normalizeBirthday('2026-07-15')).toBe('07-15')
  })

  it('月日原样补零', () => {
    expect(normalizeBirthday('7-5')).toBe('07-05')
  })

  it('非法日期回缺省：月份 13、日期 40 都不该写进提示', () => {
    expect(normalizeBirthday('2026-13-01')).toBeUndefined()
    expect(normalizeBirthday('2026-07-40')).toBeUndefined()
    expect(normalizeBirthday('13-01')).toBeUndefined()
    expect(normalizeBirthday('07-40')).toBeUndefined()
  })

  it('空串与乱写的都不是生日', () => {
    expect(normalizeBirthday('   ')).toBeUndefined()
    expect(normalizeBirthday('今天')).toBeUndefined()
  })
})
