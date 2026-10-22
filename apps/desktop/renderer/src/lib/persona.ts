/**
 * 渲染层的人格逻辑：与 @ryharness/session 的 persona.ts 同一套分档、文案与拼接顺序。
 *
 * 为什么不直接 import 服务端那份：渲染层打包进浏览器，`@ryharness/session` 的入口
 * 会把 store（node:sqlite）一起拖进来。这里只留纯函数，并用
 * `apps/desktop/tests/persona-ui.test.tsx`（"两套人格必须逐字同源"）锁住两边的输出
 * 必须逐字相同——用户在编辑器看到的预览，必须等于模型真正收到的那段提示。
 */

import type { AgentPersona } from '../api.ts'

/** 性格四维的键，顺序即展示与拼接顺序。 */
export const TRAIT_KEYS = ['extroversion', 'rigor', 'humor', 'initiative'] as const

/** 性格四维之一。 */
export type TraitKey = (typeof TRAIT_KEYS)[number]

/** 一个性格维度的分档：上限（含）、档位名、该档的行为描述。 */
export interface TraitBand {
  max: number
  label: string
  describe: string
}

/** 一个性格维度的展示与分档定义。 */
export interface TraitMeta {
  key: TraitKey
  label: string
  hint: string
  bands: readonly TraitBand[]
}

/** 四维定义：分档与中文文案。分数切在 25/50/75。 */
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

/** 「不朗读」：与服务端 `normalizeVoiceId` 的特例同一个字面量。 */
export const NO_VOICE_ID = 'none'

/** 亲密度分档（切在 20/45/70）。 */
export interface AffinityTier {
  key: string
  label: string
  max: number
  address: string
  describe: string
}

/** 亲密度分档：称呼与相处方式随它变。 */
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

/** 人格默认值：旧 agent（没有 persona 字段）打开编辑器时看到的就是这一份。 */
export const PERSONA_DEFAULTS: AgentPersona = {
  extroversion: 50,
  rigor: 60,
  humor: 40,
  initiative: 50,
  catchphrase: '',
  affinity: 0,
  voiceId: NO_VOICE_ID,
  appearance: '',
}

/** 人格段落的小标题。 */
export const PERSONA_PROMPT_HEADER = '〔人格〕'

/** 夹紧并取整到 0-100。 */
export function clampTrait(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** 分档查询。 */
export function traitBand(meta: TraitMeta, value: number): TraitBand {
  const score = clampTrait(value)
  // 末档的 max 恒为 100，而 clampTrait 已把分数夹进 [0,100]，所以循环必然命中；
  // 这里的兜底只是为了让返回类型收口，不依赖运行期数据。分档表为空属于编程错误，
  // 直接抛而不是悄悄返回 undefined 让它流到界面上。
  const last = meta.bands.at(-1)
  if (last === undefined) throw new Error(`traitBand: ${meta.key} 的分档表为空`)
  for (const band of meta.bands) {
    if (score <= band.max) return band
  }
  return last
}

/** 按 key 取维度定义。 */
export function traitMeta(key: TraitKey): TraitMeta {
  const meta = TRAIT_META.find((candidate) => {
    return candidate.key === key
  })
  // key 的类型就是 TRAIT_META 的键集合，查不到说明调用方拼错了字符串——抛出来比
  // 返回 undefined 让下游在别处炸掉更容易定位。
  if (meta === undefined) throw new Error(`traitMeta: 未知维度 ${key}`)
  return meta
}

/** 亲密度分档查询。 */
export function affinityTier(affinity: number): AffinityTier {
  const score = clampTrait(affinity)
  const last = AFFINITY_TIERS.at(-1)
  if (last === undefined) throw new Error('affinityTier: 亲密度分档表为空')
  for (const tier of AFFINITY_TIERS) {
    if (score <= tier.max) return tier
  }
  return last
}

/**
 * 生日归一：只保留月日（`MM-DD`）。
 *
 * 与 @ryharness/session 的同名函数同源（那边是权威版）——两套必须逐字一致，
 * 由 apps/desktop/tests/persona-ui.test.tsx 锁住。
 *
 * 生日不需要年份，而日期控件（`<input type="date">`）要完整日期——中间用 2000
 * 当占位年。旧数据里可能是 `YYYY-MM-DD`（手敲的），这里统一砍成 `MM-DD`。
 */
export function normalizeBirthday(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const md = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (md) {
    const month = Number(md[1])
    const day = Number(md[2])
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (ymd) {
    const month = Number(ymd[2])
    const day = Number(ymd[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    return `${ymd[2]}-${ymd[3]}`
  }
  return undefined
}

/**
 * 生日 → 日期控件的值（`YYYY-MM-DD`）。
 *
 * 控件要完整日期，生日只有月日，所以补一个 2000 当占位年。
 */
export function birthdayInputValue(birthday: string | undefined): string {
  const normalized = birthday === undefined ? undefined : normalizeBirthday(birthday)
  if (normalized === undefined) return ''
  return `2000-${normalized}`
}

/**
 * 日期控件的值 → 生日（只留月日）；清空时返回 undefined。
 */
export function birthdayFromInput(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  return `${match[2]}-${match[3]}`
}

/** 把任意来源的人格补齐成完整一份（缺字段按默认值）。 */
export function normalizePersona(value: AgentPersona | undefined): AgentPersona {
  const record = (value ?? {}) as Partial<AgentPersona>
  const text = (key: string): string => {
    const raw = record[key as keyof AgentPersona]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const birthday = normalizeBirthday(text('birthday'))
  const voiceId = text('voiceId')
  return {
    extroversion: clampTrait(record.extroversion ?? PERSONA_DEFAULTS.extroversion),
    rigor: clampTrait(record.rigor ?? PERSONA_DEFAULTS.rigor),
    humor: clampTrait(record.humor ?? PERSONA_DEFAULTS.humor),
    initiative: clampTrait(record.initiative ?? PERSONA_DEFAULTS.initiative),
    ...(birthday === undefined ? {} : { birthday }),
    catchphrase: text('catchphrase'),
    affinity: clampTrait(record.affinity ?? PERSONA_DEFAULTS.affinity),
    // 目录在服务端（GET /api/voice/catalog），渲染层不另抄一份 id 清单。旧值原样
    // 保留：编辑器让它作为「未知音色」选项可见，保存时由内核的 normalizeVoiceId
    // 做迁移/回落，界面不替它猜。
    voiceId: voiceId.length === 0 ? PERSONA_DEFAULTS.voiceId : voiceId,
    appearance: text('appearance'),
  }
}

/** 按性格给建议温度（只建议，不改写用户填的值）。 */
export function suggestTemperature(persona: AgentPersona): number {
  const value =
    0.45 +
    (clampTrait(persona.humor) / 100) * 0.2 -
    (clampTrait(persona.rigor) / 100) * 0.1 +
    (clampTrait(persona.extroversion) / 100) * 0.05
  return Math.round(Math.min(1.6, Math.max(0.1, value)) * 10) / 10
}

/** 四维的一行（分数、档位名、该档描述）。 */
function traitPromptLine(persona: AgentPersona, meta: TraitMeta): string {
  const score = clampTrait(persona[meta.key])
  const band = traitBand(meta, score)
  return `· ${meta.label} ${score}/100（${band.label}）：${band.describe}`
}

/**
 * 把人格拼到系统提示后面——与服务端逐字相同的实现。
 *
 * 顺序固定：原人设 → 〔人格〕→ 性格四维 → 生日 → 形象 → 口头禅 → 相处与称呼。
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

/** 人格一句话摘要（卡片上用）。 */
export function personaSummary(persona: AgentPersona): string {
  const p = normalizePersona(persona)
  const parts = TRAIT_META.map((meta) => {
    return traitBand(meta, p[meta.key]).label
  })
  return `${parts.join(' · ')} · ${affinityTier(p.affinity).label}`
}
