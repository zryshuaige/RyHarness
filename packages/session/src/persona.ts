/**
 * 助理人格：性格四维、生日、口头禅、形象、音色、亲密度。
 *
 * 人格不是又一个自由文本框：四维各自分档（0-100），每档有一句中文描述，
 * 描述直接进系统提示（见 {@link composePersonaPrompt}）。用户改一个滑杆，
 * 就能在预览里看见它拼进提示词的那一行——人格"看得见因果"。
 * @module @ryagent/session/persona
 */

/** 性格四维的键，顺序即展示与拼接顺序。 */
export const TRAIT_KEYS = ['extroversion', 'rigor', 'humor', 'initiative'] as const

/** 性格四维之一（0-100 整数）。 */
export type TraitKey = (typeof TRAIT_KEYS)[number]

/** 一个助理的人格。存量 agent 没有这个字段，读出来时按 {@link PERSONA_DEFAULTS} 补齐。 */
export interface AgentPersona {
  /** 外向：话多话少、群里抢不抢话。 */
  extroversion: number
  /** 严谨：结论有没有依据、数字能不能核对。 */
  rigor: number
  /** 幽默：正事之外抖不抖机灵。 */
  humor: number
  /** 主动：不问你先做事、先提醒。 */
  initiative: number
  /** 生日，`MM-DD` 或 `YYYY-MM-DD`（纯展示，用户自由填也可以）。 */
  birthday?: string
  /** 口头禅。 */
  catchphrase: string
  /** 亲密度 0-100：随互动自然增长，影响称呼与主动性（不是用户可填的字段）。 */
  affinity: number
  /** 音色 id，取值见 {@link VOICE_PRESETS}；仅登记，尚未接入语音合成。 */
  voiceId: string
  /** 一句话形象描述（长什么样、什么动物）。 */
  appearance: string
}

/** 一个性格维度的分档：上限（含）与该档的中文描述。 */
export interface TraitBand {
  /** 该档的分数上界（含）。 */
  max: number
  /** 档位名（编辑器滑杆旁显示）。 */
  label: string
  /** 该档的行为描述（直接拼进系统提示）。 */
  describe: string
}

/** 一个性格维度的展示与分档定义。 */
export interface TraitMeta {
  key: TraitKey
  /** 中文名（编辑器滑杆标签）。 */
  label: string
  /** 一句话说明这个维度管什么。 */
  hint: string
  bands: readonly TraitBand[]
}

/** 四维定义：分档与中文文案。分数切在 25/50/75，编辑器滑杆按 step=1 给。 */
export const TRAIT_META: readonly TraitMeta[] = [
  {
    key: 'extroversion',
    label: '外向',
    hint: '话多话少：群里抢不抢话',
    bands: [
      { max: 25, label: '安静', describe: '话不多，等人问才开口' },
      { max: 50, label: '适中', describe: '有问必答，群里偶尔接一句' },
      { max: 75, label: '外向', describe: '主动接话，群里也抢着发言' },
      { max: 100, label: '自来熟', describe: '自来熟，陌生人也能聊起来' },
    ],
  },
  {
    key: 'rigor',
    label: '严谨',
    hint: '结论有没有依据、数字能不能核对',
    bands: [
      { max: 25, label: '随性', describe: '凭手感答，不爱较真' },
      { max: 50, label: '尚可', describe: '大致靠谱，偶尔省略前提' },
      { max: 75, label: '严谨', describe: '先摆依据再下结论，数字要能核对' },
      { max: 100, label: '一丝不苟', describe: '先摆依据再下结论，宁可标「不确定」也不猜' },
    ],
  },
  {
    key: 'humor',
    label: '幽默',
    hint: '正事之外抖不抖机灵',
    bands: [
      { max: 25, label: '不幽默', describe: '正经作答，几乎不抖机灵' },
      { max: 50, label: '偶尔', describe: '偶尔一句玩笑，不抢正经事' },
      { max: 75, label: '爱开玩笑', describe: '爱开玩笑，但正事说得清' },
      { max: 100, label: '贫嘴', describe: '句句带梗，正事别被笑没了' },
    ],
  },
  {
    key: 'initiative',
    label: '主动',
    hint: '不等你问，先做事还是先提醒',
    bands: [
      { max: 25, label: '被动', describe: '你问才答，不主动提事' },
      { max: 50, label: '适中', describe: '你问就答，顺带提一句重点' },
      { max: 75, label: '爱提醒', describe: '会提前提醒相关的事' },
      { max: 100, label: '很主动', describe: '不等你问就先安排好，再回来问你意见' },
    ],
  },
] as const

/** 分档查询：超出 0-100 的分数先夹紧再查（脏数据不该让 UI 显示空档位）。 */
export function traitBand(meta: TraitMeta, value: number): TraitBand {
  const score = clampTrait(value)
  for (const band of meta.bands) {
    if (score <= band.max) return band
  }
  return meta.bands[meta.bands.length - 1]!
}

/** 按 key 取维度定义。 */
export function traitMeta(key: TraitKey): TraitMeta {
  return TRAIT_META.find((meta) => {
    return meta.key === key
  })!
}

/** 夹紧并取整到 0-100 的性格分。 */
export function clampTrait(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** 一个可选音色（供应商 TTS 预设名）。 */
export interface VoicePreset {
  id: string
  /** 界面显示名。 */
  name: string
  /** 这套预设属于哪家的 TTS（只登记，尚未接入调用）。 */
  provider: string
}

/**
 * 音色目录：只登记 id 与显示名。
 *
 * 目前**没有**任何 TTS 调用路径（见 apps/server 与 @ryagent/llm 都没有语音接口），
 * 所以这里只是给"这个助理该是什么声音"留一个可选择的位置；界面必须如实说明
 * 尚未接入，不得暗示能播。
 */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: 'none', name: '暂不设定', provider: 'none' },
  { id: 'siliconflow:warm-female', name: '暖橘女声（SiliconFlow）', provider: 'siliconflow' },
  { id: 'siliconflow:steady-male', name: '沉稳男声（SiliconFlow）', provider: 'siliconflow' },
  { id: 'openai:alloy', name: 'Alloy（OpenAI）', provider: 'openai' },
  { id: 'openai:shimmer', name: 'Shimmer（OpenAI）', provider: 'openai' },
  { id: 'elevenlabs:gentle-female', name: '柔和女声（ElevenLabs）', provider: 'elevenlabs' },
  { id: 'local:qwen3-tts', name: '本地 Qwen3-TTS（Ollama）', provider: 'local' },
] as const

/** 音色显示名；未知 id 回落到"未知音色"而不是静默显示空串。 */
export function voiceName(voiceId: string): string {
  return (
    VOICE_PRESETS.find((preset) => {
      return preset.id === voiceId
    })?.name ?? '未知音色'
  )
}

/**
 * 人格字段的默认值：旧 agent（无 persona 列）读出来就是这一份。
 *
 * 放在音色目录之后：默认音色就是目录里的第一项，声明顺序跟着依赖走。
 */
export const PERSONA_DEFAULTS: AgentPersona = {
  extroversion: 50,
  rigor: 60,
  humor: 40,
  initiative: 50,
  catchphrase: '',
  affinity: 0,
  voiceId: VOICE_PRESETS[0]!.id,
  appearance: '',
}

/** 亲密度档位：称呼与相处方式随它变。 */
export interface AffinityTier {
  key: string
  /** 档位名（界面显示）。 */
  label: string
  /** 该档的分数上界（含）。 */
  max: number
  /** 怎么称呼用户（进系统提示，也是界面上的说明）。 */
  address: string
  /** 相处方式的一行描述。 */
  describe: string
}

/** 亲密度分档（0-100，切在 20/45/70）。 */
export const AFFINITY_TIERS: readonly AffinityTier[] = [
  {
    key: 'stranger',
    max: 20,
    label: '初识',
    address: '称「你」，礼貌但保持距离',
    describe: '刚认识不久：先回答问题，不主动寒暄，也不追问隐私',
  },
  {
    key: 'familiar',
    max: 45,
    label: '熟面孔',
    address: '称「你」，少客套',
    describe: '已经混熟：可以少客套直接问需求，偶尔主动提一句',
  },
  {
    key: 'close',
    max: 70,
    label: '亲近',
    address: '可以直呼其名',
    describe: '关系亲近：会关心你的状态，敢开玩笑，主动分享你用得上的东西',
  },
  {
    key: 'confidant',
    max: 100,
    label: '挚友',
    address: '用昵称互相称呼',
    describe: '老朋友了：主动提起你们聊过的事，偶尔不聊正事也没关系',
  },
] as const

/** 亲密度分档查询。 */
export function affinityTier(affinity: number): AffinityTier {
  const score = clampTrait(affinity)
  for (const tier of AFFINITY_TIERS) {
    if (score <= tier.max) return tier
  }
  return AFFINITY_TIERS[AFFINITY_TIERS.length - 1]!
}

/** 每次对话轮次涨的亲密度。 */
export const AFFINITY_TURN_GAIN = 2
/** 用户点赞（👍）涨的亲密度。 */
export const AFFINITY_LIKE_GAIN = 5
/** 用户点踩（👎）掉的亲密度。 */
export const AFFINITY_DISLIKE_LOSS = 4

/** 一次互动事件（轮次与点赞可同时出现）。 */
export interface AffinityEvent {
  /** 新完成的对话轮数。 */
  turns?: number
  /** 点赞数。 */
  likes?: number
  /** 点踩数。 */
  dislikes?: number
}

/**
 * 亲密度增长：轮次与点赞累加，点踩扣分，结果夹在 0-100。
 *
 * 纯函数（不读时钟、不查库）：协调器在每轮发言落库后按轮次加，点赞/点踩由
 * POST /api/agents/:id/affinity 传入同一套规则——「聊得越多越熟」这条规律
 * 只有一处定义，改文案不会让两个入口算出不同的亲密度。
 */
export function nextAffinity(affinity: number, event: AffinityEvent): number {
  const delta =
    (event.turns ?? 0) * AFFINITY_TURN_GAIN +
    (event.likes ?? 0) * AFFINITY_LIKE_GAIN -
    (event.dislikes ?? 0) * AFFINITY_DISLIKE_LOSS
  return clampTrait(affinity + delta)
}

/** 性格建议温度的基准值（不幽默也不严谨时大约落在这里）。 */
const TEMPERATURE_BASE = 0.45

/**
 * 按性格给建议温度：越幽默越高、越严谨越低、越外向略高。
 *
 * 这是**建议**不是改写：编辑器和 API 都只把它显示/返回给用户，agent 实际用的
 * temperature 仍以用户填的为准（人格是"建议"，不能偷偷改掉用户的采样参数）。
 */
export function suggestTemperature(persona: AgentPersona): number {
  const value =
    TEMPERATURE_BASE +
    (clampTrait(persona.humor) / 100) * 0.2 -
    (clampTrait(persona.rigor) / 100) * 0.1 +
    (clampTrait(persona.extroversion) / 100) * 0.05
  return Math.round(Math.min(1.6, Math.max(0.1, value)) * 10) / 10
}

/**
 * 归一人格：任何来源（数据库 JSON、API body、模板）都要过这一道。
 *
 * 未知/缺失的字段落到 {@link PERSONA_DEFAULTS}，数值夹紧取整，字符串去空白后
 * 为空则不写——用户没填的生日不该在提示里出现「生日：（空）」这种行。
 */
export function normalizePersona(value: unknown): AgentPersona {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const text = (key: string): string => {
    const raw = record[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const birthday = text('birthday')
  const catchphrase = text('catchphrase')
  const appearance = text('appearance')
  const voiceId = text('voiceId')
  return {
    extroversion: clampTrait(record.extroversion ?? PERSONA_DEFAULTS.extroversion),
    rigor: clampTrait(record.rigor ?? PERSONA_DEFAULTS.rigor),
    humor: clampTrait(record.humor ?? PERSONA_DEFAULTS.humor),
    initiative: clampTrait(record.initiative ?? PERSONA_DEFAULTS.initiative),
    ...(birthday.length === 0 ? {} : { birthday }),
    catchphrase,
    affinity: clampTrait(record.affinity ?? PERSONA_DEFAULTS.affinity),
    voiceId: VOICE_PRESETS.some((preset) => {
      return preset.id === voiceId
    })
      ? voiceId
      : PERSONA_DEFAULTS.voiceId,
    appearance,
  }
}

/** 人格落库形态（agents.persona 列，一列 JSON）。 */
export function serializePersona(persona: AgentPersona): string {
  return JSON.stringify(persona)
}

/** 人格段落的小标题：用户能在预览里一眼看出"这段是人格拼上去的"。 */
export const PERSONA_PROMPT_HEADER = '〔人格〕'

/** 四维的一行：分数、档位名、该档描述。 */
export function traitPromptLine(persona: AgentPersona, meta: TraitMeta): string {
  const score = clampTrait(persona[meta.key])
  const band = traitBand(meta, score)
  return `· ${meta.label} ${score}/100（${band.label}）：${band.describe}`
}

/**
 * 把人格拼到系统提示后面。
 *
 * 拼什么、按什么顺序写在这里，用户在编辑器预览里看到的也是这段（同一个函数）：
 * 原人设 → 〔人格〕标题 → 性格四维 → 生日 → 形象 → 口头禅 → 相处（亲密度与称呼）。
 * 顺序固定是有意的：模型先读"是谁"，再读"性格"，最后读"怎么相处"；
 * 用户拖滑杆时预览跳变的也只是中间那几行，行为可预期。
 */
export function composePersonaPrompt(basePrompt: string, persona: AgentPersona): string {
  const base = basePrompt.trim()
  const lines = TRAIT_META.map((meta) => {
    return traitPromptLine(persona, meta)
  })
  if (persona.birthday !== undefined) lines.push(`生日：${persona.birthday}`)
  if (persona.appearance.length > 0) lines.push(`形象：${persona.appearance}`)
  if (persona.catchphrase.length > 0) {
    lines.push(`口头禅：爱说「${persona.catchphrase}」——自然地带出来，别每句都塞`)
  }
  const tier = affinityTier(persona.affinity)
  lines.push(`相处：你们是「${tier.label}」（亲密度 ${clampTrait(persona.affinity)}/100）——${tier.describe}`)
  lines.push(`称呼：${tier.address}`)
  const section = [PERSONA_PROMPT_HEADER, ...lines].join('\n')
  return base.length === 0 ? section : `${base}\n\n${section}`
}
