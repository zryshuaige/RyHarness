/**
 * Agent 域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型（字段是什么、缺了行不行），handler 管语义（重名、档位是否存在、
 * 模板实例化、亲密度信号）——手写时代贴着响应文案的 400 保持原样，迁移不改行为。
 *
 * 两处手写时代靠 `typeof` 兜的边界要靠 handler 继续兜（schema 拦不住）：
 * `null` 会从一切可缺省字段里透传（缺省语义优先于类型），`Infinity` 是合法的
 * number——所以 string 字段的「非字符串」与温度的「有限数」校验留在 handler。
 * @module @ryharness/server/contract/agents
 */

import z from '@ryharness/schemastery'
import { optionalStringArray } from './util.ts'

/** persona 的补丁形状：性格与设定字段全部可缺省（缺 = 沿用旧值/默认值）。 */
export interface PersonaPatchInput {
  extroversion?: number
  rigor?: number
  humor?: number
  initiative?: number
  affinity?: number
  birthday?: string
  catchphrase?: string
  appearance?: string
  voiceId?: string
}

/**
 * persona 用字面量构造而不是 `z.object`：object 工厂带隐式 default {}，会把
 * 「没传 persona」变成「传了个空对象」——PATCH 的「没传 = 沿用旧值」与 POST
 * 模板路径的「没 persona 就用模板的」都会被破坏（理由同 util.ts 的 optionalArrayOf）。
 */
export const PersonaPatchBody: z<PersonaPatchInput | undefined> = z<PersonaPatchInput | undefined>({
  type: 'object',
  dict: {
    extroversion: z.number(),
    rigor: z.number(),
    humor: z.number(),
    initiative: z.number(),
    affinity: z.number(),
    birthday: z.string(),
    catchphrase: z.string(),
    appearance: z.string(),
    voiceId: z.string(),
  },
  meta: { default: undefined },
})

/**
 * POST /api/agents 与 PATCH /api/agents/:id 共用的字段白名单。
 *
 * 跨字段规则留在 handler：档位必须真实存在、亲密度合并、改名查重、模板实例化。
 */
export interface AgentMutationInput {
  name?: string
  avatar?: string
  systemPrompt?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  temperature?: number
  tools?: string[]
  permissionPreset?: string
  persona?: PersonaPatchInput
}

export const AgentMutationBody: z<AgentMutationInput> = z.object({
  name: z.string(),
  avatar: z.string(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  temperature: z.number(),
  tools: optionalStringArray(),
  permissionPreset: z.string(),
  persona: PersonaPatchBody,
})

/** POST /api/agents 的入参：白名单字段之外还认自定义 id 与模板键。 */
export interface AgentCreateInput extends AgentMutationInput {
  id?: string
  templateKey?: string
}

export const AgentCreateBody: z<AgentCreateInput> = z.object({
  name: z.string(),
  avatar: z.string(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  temperature: z.number(),
  tools: optionalStringArray(),
  permissionPreset: z.string(),
  persona: PersonaPatchBody,
  id: z.string(),
  templateKey: z.string(),
})

/** POST /api/agents/:id/preset 的入参：给这位助理选定一套能力预设。 */
export interface AgentPresetInput {
  presetId?: string
}

export const AgentPresetBody: z<AgentPresetInput> = z.object({
  presetId: z.string(),
})

/** POST /api/agents/:id/affinity 的入参：👍/👎 信号（取值校验在 handler）。 */
export interface AgentAffinityInput {
  signal?: string
}

export const AgentAffinityBody: z<AgentAffinityInput> = z.object({
  signal: z.string(),
})
