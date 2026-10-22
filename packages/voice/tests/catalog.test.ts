/**
 * 音色目录：id 唯一、字段齐全、speaker 段能推出模型 id、系统音色不带模型前缀。
 *
 * 目录是"用户点下去能不能真的出声"的唯一依据，所以这里钉的是形状与推导关系；
 * "哪几条真的可用"是探测脚本的结论，写在 catalog.ts 的注释里，不在测试里重跑网络。
 */
import { describe, expect, it } from 'vitest'
import { speakerModel, VOICE_ENGINES, VOICE_PROFILES, voiceProfile, voiceProfilesForEngine } from '../src/catalog.ts'
import { VOICE_ERROR_CODES, type VoiceEngineId } from '../src/index.ts'

describe('音色目录', () => {
  it('id 唯一，且每条都有试听句与说明（没有 id 的条目建不出路由，没有 sampleText 的条目没法试听）', () => {
    const ids = VOICE_PROFILES.map((profile) => {
      return profile.id
    })
    expect(new Set(ids).size).toBe(ids.length)
    for (const profile of VOICE_PROFILES) {
      expect(profile.name.length).toBeGreaterThan(0)
      expect(profile.sampleText.length).toBeGreaterThan(0)
      expect(profile.description.length).toBeGreaterThan(0)
    }
  })

  it('引擎目录覆盖全部音色用到的引擎；每条音色都属于目录里声明过的一个引擎', () => {
    const declared = new Set<VoiceEngineId>(
      VOICE_ENGINES.map((engine) => {
        return engine.id
      }),
    )
    for (const profile of VOICE_PROFILES) expect(declared.has(profile.engine)).toBe(true)
    // 每个声明过的引擎都得真有音色，否则界面上会列出一个空的分组。
    for (const engine of VOICE_ENGINES) {
      expect(voiceProfilesForEngine(engine.id).length).toBeGreaterThan(0)
    }
  })

  it('按 id 查：命中给原样条目，未知 id 给 undefined（调用方据此回未找到，而不是空对象）', () => {
    const known = VOICE_PROFILES[0]
    expect(known).toBeDefined()
    expect(voiceProfile(known?.id ?? '')).toBe(known)
    expect(voiceProfile('no-such-voice')).toBeUndefined()
    expect(voiceProfile('')).toBeUndefined()
  })

  it('云端音色的 voice 一定是「模型:说话人」，且 speaker 段能推回同一个模型 id', () => {
    const cloud = voiceProfilesForEngine('siliconflow')
    expect(cloud.length).toBeGreaterThanOrEqual(8)
    for (const profile of cloud) {
      expect(profile.voice).toContain(':')
      // 端点只认带模型前缀的 voice，模型 id 又是从 voice 推的：推错了就会发出
      // model 与 voice 对不上的请求，而那正是端点回 Invalid voice 的形状。
      expect(profile.voice.startsWith(`${speakerModel(profile.voice)}:`)).toBe(true)
      expect(profile.sampleText.length).toBeGreaterThan(0)
    }
  })

  it('系统音色的 voice 是 Windows 音色名（不带模型前缀——它由渲染层交给 speechSynthesis）', () => {
    const system = voiceProfilesForEngine('system')
    expect(system.length).toBeGreaterThan(0)
    for (const profile of system) {
      expect(profile.voice.startsWith('Microsoft ')).toBe(true)
      expect(speakerModel(profile.voice)).toBeUndefined()
    }
  })

  it('speakerModel 只认「非空:非空」的形状，空串与畸形串给 undefined（不猜模型名）', () => {
    expect(speakerModel('FunAudioLLM/CosyVoice2-0.5B:anna')).toBe('FunAudioLLM/CosyVoice2-0.5B')
    expect(speakerModel('fnlp/MOSS-TTSD-v0.5:alex')).toBe('fnlp/MOSS-TTSD-v0.5')
    expect(speakerModel('anna')).toBeUndefined()
    expect(speakerModel(':anna')).toBeUndefined()
    expect(speakerModel('model:')).toBeUndefined()
    expect(speakerModel('')).toBeUndefined()
  })

  it('错误码是稳定字面量（前端按 code 分支，改名等于让降级路径失效）', () => {
    expect(VOICE_ERROR_CODES.engineLocal).toBe('VOICE_ENGINE_LOCAL')
    expect(VOICE_ERROR_CODES.noCredential).toBe('VOICE_NO_CREDENTIAL')
    expect(VOICE_ERROR_CODES.rateLimited).toBe('VOICE_RATE_LIMITED')
    expect(VOICE_ERROR_CODES.upstream).toBe('VOICE_UPSTREAM')
    expect(VOICE_ERROR_CODES.unknownProfile).toBe('VOICE_PROFILE_NOT_FOUND')
    expect(VOICE_ERROR_CODES.badRequest).toBe('VOICE_BAD_REQUEST')
  })
})
