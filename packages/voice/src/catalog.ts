/**
 * 音色目录：可选引擎 + 可选音色。
 *
 * 云端那组的 speaker 清单是**逐个打真实端点探测出来的**（2026-10-17，SiliconFlow
 * `POST /v1/audio/speech`）：16 条全部 HTTP 200 + `audio/mpeg`，且逐条音频的
 * SHA-256 两两不同（不是同一条音色的别名）。探测失败的写法一律没有进这里——
 * 目录里的每一条，用户点下去都能真的出声。
 * @module @ryharness/voice/catalog
 */

import type { VoiceEngineId, VoiceProfile } from './types.ts'

/** 一个语音引擎的对外信息。 */
export interface VoiceEngineInfo {
  id: VoiceEngineId
  name: string
  /** 这条引擎的前置条件 / 使用方式说明（UI 直接显示）。 */
  note?: string
}

/** 引擎目录。 */
export const VOICE_ENGINES: readonly VoiceEngineInfo[] = [
  {
    id: 'system',
    name: '系统语音',
    note: '本机 Windows 自带的声音，由渲染层直接朗读，不经过服务端、不消耗额度',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 云端语音',
    note: '需要先在「设置 → 供应商」里给 SiliconFlow 填好 API Key',
  },
] as const

/** 试听用句：短、带语调变化，听得出的差别才是音色差别。 */
const SAMPLE_TEXT = '你好，我是 Ryen，今天也一起把事情做完吧。'

/**
 * Windows 自带音色。
 *
 * 只列 SAPI 的 *Desktop*（离线）音色，不列 Online Natural——后者由 Windows 自己
 * 去微软服务器取声，Electron 离线启动时往往直接静默失败。这些名字就是
 * `speechSynthesis.getVoices()` 返回的 name，渲染层按名字挑。
 */
const SYSTEM_PROFILES: readonly VoiceProfile[] = [
  {
    id: 'system-huihui',
    name: '慧慧（系统女声）',
    engine: 'system',
    voice: 'Microsoft Huihui Desktop',
    gender: '女',
    style: '自然',
    sampleText: SAMPLE_TEXT,
    description: 'Windows 自带的普通话女声，离线可用',
  },
  {
    id: 'system-yaoyao',
    name: '瑶瑶（系统女声）',
    engine: 'system',
    voice: 'Microsoft Yaoyao Desktop',
    gender: '女',
    style: '自然',
    sampleText: SAMPLE_TEXT,
    description: 'Windows 自带的普通话女声，离线可用',
  },
  {
    id: 'system-kangkang',
    name: '康康（系统男声）',
    engine: 'system',
    voice: 'Microsoft Kangkang Desktop',
    gender: '男',
    style: '自然',
    sampleText: SAMPLE_TEXT,
    description: 'Windows 自带的普通话男声，离线可用',
  },
  {
    id: 'system-yunxi',
    name: '云希（系统男声）',
    engine: 'system',
    voice: 'Microsoft Yunxi Desktop',
    gender: '男',
    style: '自然',
    sampleText: SAMPLE_TEXT,
    description: 'Windows 自带的普通话男声，离线可用',
  },
] as const

/**
 * SiliconFlow 预置说话人。
 *
 * 性别与风格取自 SiliconFlow 官方 TTS 文档列出的 8 条系统预置音色；**能不能用**
 * 以实测为准：8 条在这两个模型上都真的合成出了 mp3。`voice` 必须写成
 * `模型:说话人`——端点对不带模型前缀的裸名字一律回 `Invalid voice`（实测）。
 */
interface PresetSpeaker {
  /** speaker 段（voice 冒号之后那半）。 */
  speaker: string
  gender: '男' | '女'
  style: string
}

const PRESET_SPEAKERS: readonly PresetSpeaker[] = [
  { speaker: 'alex', gender: '男', style: '沉稳' },
  { speaker: 'benjamin', gender: '男', style: '低沉' },
  { speaker: 'charles', gender: '男', style: '磁性' },
  { speaker: 'david', gender: '男', style: '欢快' },
  { speaker: 'anna', gender: '女', style: '沉稳' },
  { speaker: 'bella', gender: '女', style: '激情' },
  { speaker: 'claire', gender: '女', style: '温柔' },
  { speaker: 'diana', gender: '女', style: '欢快' },
] as const

/**
 * 两个云端模型的区别，决定了同一条预置音色该选哪个：
 * - CosyVoice2：跨语种（中/英/日/韩 + 粤语、四川话等方言），单说话人。
 * - MOSS-TTSD：中英双语混读，按 `[S1]` / `[S2]` 标记在多人之间自动切换（实测可用）。
 */
const CLOUD_MODELS: readonly { model: string; label: string; capability: string }[] = [
  {
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    label: 'CosyVoice2',
    capability: '跨语种：中文、英文、日语、韩语与粤语等方言',
  },
  { model: 'fnlp/MOSS-TTSD-v0.5', label: 'MOSS', capability: '中英双语混读，可用 [S1]/[S2] 标记切换说话人' },
] as const

/** 云端音色：两个模型 × 8 条预置说话人，全部实测可用。 */
const SILICONFLOW_PROFILES: readonly VoiceProfile[] = CLOUD_MODELS.flatMap((entry) => {
  return PRESET_SPEAKERS.map((preset) => {
    return {
      id: `sf-${entry.label.toLowerCase()}-${preset.speaker}`,
      name: `${preset.style}${preset.gender}声（${entry.label} ${preset.speaker}）`,
      engine: 'siliconflow' as const,
      voice: `${entry.model}:${preset.speaker}`,
      gender: preset.gender,
      style: preset.style,
      sampleText: SAMPLE_TEXT,
      description: `${entry.model} 预置音色 · ${entry.capability}`,
    }
  })
})

/**
 * 全部音色：先系统、后云端。
 *
 * 顺序即 UI 默认顺序——不需要额度、断网也能用的排前面。
 */
export const VOICE_PROFILES: readonly VoiceProfile[] = [...SYSTEM_PROFILES, ...SILICONFLOW_PROFILES]

/**
 * 运行时注册的音色。
 *
 * 静态目录之外的东西——插件从声线文件里读出来的猫猫音、离线 Piper 那条——也得能被
 * `voiceProfile()` 认下：人格保存时 `normalizeVoiceId` 只放行目录里有的 id，动态
 * 音色会被洗成「不朗读」。用户在下拉里挑了这条、点试听也确实有声音，存下来却变成
 * "不朗读"——那不是"没这条音色"，那是功能坏了。
 */
const runtimeProfiles = new Map<string, VoiceProfile>()

/**
 * 声线文件声明过的 id。
 *
 * 与 {@link runtimeProfiles} 分开记，是因为两件事的寿命不一样：条目随插件装载/卸载
 * 来去，**id 却是永久的**——用户挑过一次的声音，装载状态变了也不该被抹掉（插件关掉
 * 时界面显示"已下架的旧音色"，插件回来它又能用了）。
 */
const declaredVoiceIds = new Set<string>()

/**
 * 声明一个合法的音色 id（哪怕它此刻还没有对应的条目）。
 *
 * 声线文件的默认清单在模块加载时就声明一遍：这样"人格里存着 ryen-cat"这件事在
 * 插件装载之前就已经成立，种子数据不会因为装载顺序被洗成「不朗读」。
 * @param id - 音色 id。
 */
export function declareVoiceId(id: string): void {
  declaredVoiceIds.add(id)
}

/** 这个 id 是不是一条合法的音色 id（不管它此刻能不能合成）。 */
export function isKnownVoiceId(id: string): boolean {
  if (declaredVoiceIds.has(id)) return true
  return VOICE_PROFILES.some((profile) => {
    return profile.id === id
  })
}

/**
 * 注册一条运行时音色，返回精确注销函数（重复调用幂等）。
 *
 * 同 id 重复注册直接覆盖：插件热重载时新的一份应当取代旧的一份，而不是报错把启动
 * 打断——上一份已经不在目录里了，用户看到的就是新的那份。
 * @param profile - 要进目录的音色。
 * @returns 注销这一次注册的函数。
 */
export function registerVoiceProfile(profile: VoiceProfile): () => void {
  runtimeProfiles.set(profile.id, profile)
  declareVoiceId(profile.id)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (runtimeProfiles.get(profile.id) === profile) runtimeProfiles.delete(profile.id)
  }
}

/** 静态目录 + 运行时注册的全部音色（注册的在后面）。 */
export function allVoiceProfiles(): VoiceProfile[] {
  return [...VOICE_PROFILES, ...runtimeProfiles.values()]
}

/** 按 id 取音色；未知 id 返回 undefined（调用方据此回 VOICE_PROFILE_NOT_FOUND）。 */
export function voiceProfile(id: string): VoiceProfile | undefined {
  const builtin = VOICE_PROFILES.find((profile) => {
    return profile.id === id
  })
  if (builtin !== undefined) return builtin
  return runtimeProfiles.get(id)
}

/** 某个引擎下的全部音色。 */
export function voiceProfilesForEngine(engine: VoiceEngineId): VoiceProfile[] {
  return allVoiceProfiles().filter((profile) => {
    return profile.engine === engine
  })
}

/**
 * 从 `模型:说话人` 形式的 voice 里取模型 id。
 *
 * 端点要求 model 与 voice 里的模型段一致，两处各写一份字面量迟早会写歪，所以
 * 模型 id 只从 voice 推。两段都必须非空：`anna` 与 `model:` 都是写坏了的 voice，
 * 拼一个模型名发出去只会换一个更难懂的上游错误——宁可在这里判成未知音色。
 */
export function speakerModel(voice: string): string | undefined {
  const separator = voice.indexOf(':')
  if (separator <= 0 || separator === voice.length - 1) return undefined
  return voice.slice(0, separator)
}
