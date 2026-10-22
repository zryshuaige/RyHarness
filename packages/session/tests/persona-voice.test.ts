/**
 * 音色目录接线：persona.voiceId 必须引用 @ryharness/voice 的真实目录，旧库里的占位
 * id 要在读出来时平滑迁移——旧值让助理保存失败是最不可接受的一种回归。
 */
import { VOICE_PROFILES } from '@ryharness/voice'
import { describe, expect, it } from 'vitest'
import { NO_VOICE_ID, normalizePersona, normalizeVoiceId, PERSONA_DEFAULTS, VOICE_PRESETS } from '../src/persona.ts'

describe('音色 id 归一', () => {
  it('目录里的每条 id 都原样保留，none 是「不朗读」的特例', () => {
    expect(normalizeVoiceId(NO_VOICE_ID)).toBe(NO_VOICE_ID)
    for (const profile of VOICE_PROFILES) {
      expect(normalizeVoiceId(profile.id)).toBe(profile.id)
    }
  })

  it('旧 id 平滑迁移：SiliconFlow 两种气质落到 CosyVoice2，本地 Qwen3 落到系统语音', () => {
    expect(normalizeVoiceId('siliconflow:warm-female')).toBe('sf-cosyvoice2-claire')
    expect(normalizeVoiceId('siliconflow:steady-male')).toBe('sf-cosyvoice2-alex')
    expect(normalizeVoiceId('local:qwen3-tts')).toBe('system-huihui')
  })

  it('没有真实对应的旧 id 与任意脏值都回落到 none，绝不抛错', () => {
    expect(normalizeVoiceId('openai:alloy')).toBe(NO_VOICE_ID)
    expect(normalizeVoiceId('elevenlabs:gentle-female')).toBe(NO_VOICE_ID)
    expect(normalizeVoiceId('  no-such-voice  ')).toBe(NO_VOICE_ID)
    expect(normalizeVoiceId('')).toBe(NO_VOICE_ID)
    expect(normalizeVoiceId(undefined)).toBe(NO_VOICE_ID)
    expect(normalizeVoiceId(42)).toBe(NO_VOICE_ID)
  })

  it('normalizePersona 走同一条迁移，且旧值不会让整份人格失败', () => {
    const persona = normalizePersona({ voiceId: 'siliconflow:warm-female' })
    expect(persona.voiceId).toBe('sf-cosyvoice2-claire')
    expect(normalizePersona({ voiceId: 'openai:alloy' }).voiceId).toBe(NO_VOICE_ID)
    expect(normalizePersona({}).voiceId).toBe(PERSONA_DEFAULTS.voiceId)
    expect(PERSONA_DEFAULTS.voiceId).toBe(NO_VOICE_ID)
  })
})

describe('旧接口的音色清单', () => {
  it('none 排第一，其余与 @ryharness/voice 目录同源（id、显示名、引擎）', () => {
    expect(VOICE_PRESETS[0]?.id).toBe(NO_VOICE_ID)
    for (const profile of VOICE_PROFILES) {
      expect(VOICE_PRESETS).toContainEqual({ id: profile.id, name: profile.name, provider: profile.engine })
    }
  })
})
