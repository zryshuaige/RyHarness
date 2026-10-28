/**
 * 声线文件：解析规则、默认清单与 id 的声明时机。
 *
 * 解析规则钉的是「什么算一条合格的声线」——字段不合格就整条作废，而不是塞默认值。
 * 这条规则松了，用户会得到一条悄悄用了别人语速的声线，比没有这条更难查。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_FILES,
  isKnownVoiceId,
  parseVoiceFile,
  RYEN_CAT_VOICE,
  voiceFileToProfile,
} from '../src/index.ts'

/** 一条最小的合格声线。 */
const VALID = {
  id: 'ryen-cat',
  name: 'Ryen 的猫猫音',
  engine: 'minimax',
  voice: 'Chinese (Mandarin)_Crisp_Girl',
  sampleText: '你好，我是 Ryen。',
  description: '猫猫音',
}

describe('声线文件解析', () => {
  it('合格的文件原样解析出来（旋钮为可选）', () => {
    const file = parseVoiceFile({ ...VALID, model: 'speech-2.6-hd', speed: 1.05, pitch: 2, vol: 1, emotion: 'happy' })
    expect(file).toBeDefined()
    expect(file?.id).toBe('ryen-cat')
    expect(file?.engine).toBe('minimax')
    expect(file?.voice).toBe('Chinese (Mandarin)_Crisp_Girl')
    expect(file?.model).toBe('speech-2.6-hd')
    expect(file?.speed).toBe(1.05)
    expect(file?.pitch).toBe(2)
    expect(file?.emotion).toBe('happy')
  })

  it('必填字段缺一个就整条作废（不做"尽力而为"的默认值）', () => {
    for (const key of ['id', 'name', 'engine', 'voice', 'sampleText', 'description'] as const) {
      const broken: Record<string, unknown> = { ...VALID }
      delete broken[key]
      expect(parseVoiceFile(broken)).toBeUndefined()
    }
    expect(parseVoiceFile({ ...VALID, id: '' })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, name: '   ' })).toBeUndefined()
  })

  it('id 形状不对（带斜杠、大写、太空格）一律作废——它要当文件名与路由片段用', () => {
    expect(parseVoiceFile({ ...VALID, id: 'Ryen Cat' })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, id: 'ryen/cat' })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, id: '-ryen' })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, id: 'ryen-cat-2' })).toBeDefined()
  })

  it('旋钮越界等于整条写坏了：不是夹到边界，而是不给这条声线', () => {
    expect(parseVoiceFile({ ...VALID, speed: 0.1 })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, speed: 5 })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, pitch: -13 })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, pitch: 13 })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, vol: 0 })).toBeUndefined()
    expect(parseVoiceFile({ ...VALID, vol: 11 })).toBeUndefined()
    // 写坏与"没写"是两回事：没写旋钮是合法的。
    expect(parseVoiceFile({ ...VALID, speed: undefined })).toBeDefined()
  })

  it('不是对象的一律作废（不会因为 JSON.parse 出来是数组就当目录条目）', () => {
    expect(parseVoiceFile(undefined)).toBeUndefined()
    expect(parseVoiceFile(null)).toBeUndefined()
    expect(parseVoiceFile('ryen-cat')).toBeUndefined()
    expect(parseVoiceFile([VALID])).toBeUndefined()
  })

  it('转成目录条目时不带上旋钮（那些旋钮对界面没用，不塞进目录接口）', () => {
    const profile = voiceFileToProfile(RYEN_CAT_VOICE)
    expect(profile.id).toBe('ryen-cat')
    expect(profile.engine).toBe('minimax')
    expect(profile.voice).toBe('Chinese (Mandarin)_Crisp_Girl')
    expect(profile.sampleText.length).toBeGreaterThan(0)
    expect('speed' in profile).toBe(false)
    expect('pitch' in profile).toBe(false)
  })
})

describe('默认声线与 id 声明', () => {
  it('默认清单里那条就是 Ryen 的猫猫音', () => {
    expect(DEFAULT_VOICE_FILES.length).toBeGreaterThan(0)
    expect(DEFAULT_VOICE_FILES[0]?.id).toBe('ryen-cat')
    expect(DEFAULT_VOICE_FILES[0]?.engine).toBe('minimax')
  })

  it('默认 id 在模块加载时就声明为合法音色 id（种子数据比插件早落库，不能被洗掉）', () => {
    expect(isKnownVoiceId('ryen-cat')).toBe(true)
    expect(isKnownVoiceId('no-such-voice')).toBe(false)
  })

  it('默认那条自己也解析得出来（写进数据目录的就是它）', () => {
    expect(parseVoiceFile(RYEN_CAT_VOICE)).toBeDefined()
  })
})
