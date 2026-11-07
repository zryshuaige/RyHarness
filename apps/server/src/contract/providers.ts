/**
 * 供应商域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型（含 models 条目「裸 id | 带补录上下文」的 union），handler 管语义
 * （trim、协议白名单、contextWindow 范围、去重、baseUrl 归一）——手写时代贴着响应
 * 文案的 400 保持原样，迁移不改行为。
 * @module @ryharness/server/contract/providers
 */

import z from '@ryharness/schemastery'
import { optionalArrayOf } from './util.ts'

/** models 数组里「带补录上下文长度」的对象（OpenAI 兼容端点不报这个数）；裸 id 直接用 string。 */
export interface ProviderModelEntry {
  id?: string
  contextWindow?: number
}

/** models 数组：裸 id 与对象可混在一份数组里。 */
export type ProviderModelEntries = (string | ProviderModelEntry)[]

/** POST /api/providers 的入参形状。 */
export interface NewProviderBodyInput {
  displayName?: string
  protocol?: string
  baseUrl?: string
  models?: ProviderModelEntries
  apiKey?: string
  presetId?: string
}

const ModelEntry: z<string | ProviderModelEntry> = z.union([
  z.string(),
  z.object({ id: z.string(), contextWindow: z.number() }),
])

export const NewProviderBody: z<NewProviderBodyInput> = z.object({
  displayName: z.string(),
  protocol: z.string(),
  baseUrl: z.string(),
  models: optionalArrayOf(ModelEntry),
  apiKey: z.string(),
  presetId: z.string(),
})

/** PATCH /api/providers/:id 的入参形状：键不存在 = 这一项不改。 */
export interface ProviderPatchBodyInput {
  displayName?: string
  protocol?: string
  baseUrl?: string
  models?: ProviderModelEntries
}

export const ProviderPatchBody: z<ProviderPatchBodyInput> = z.object({
  displayName: z.string(),
  protocol: z.string(),
  baseUrl: z.string(),
  models: optionalArrayOf(ModelEntry),
})

/** POST /api/providers/discover 的入参形状：一份还没保存的供应商草稿。 */
export interface DiscoverBodyInput {
  baseUrl?: string
  protocol?: string
  apiKey?: string
}

export const DiscoverBody: z<DiscoverBodyInput> = z.object({
  baseUrl: z.string(),
  protocol: z.string(),
  apiKey: z.string(),
})
