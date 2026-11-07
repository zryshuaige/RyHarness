/**
 * RyVibe 域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（需求长度上限、版本 id 是否存在、题目归属）——
 * VIBE_* 机器码的 400 保持原样，迁移不改行为。
 *
 * 回答体（/answer）的宽容语义要有意识地保住：`answers` 与 `skipped` 只标
 * unknown（数组里的非对象条目被静默跳过、`skipped` 非 true 即假），把这些搬进
 * schema 会把「传了也当没传」变成 400。单题字段的类型由 schema 兜底，handler
 * 里的 `strField` 继续负责「空串视同没答」。
 * @module @ryharness/server/contract/vibe
 */

import z from '@ryharness/schemastery'
import { optionalStringArray } from './util.ts'

/** POST /api/vibe 的入参：一句话需求。 */
export interface VibeCreateInput {
  requirement?: string
}

export const VibeCreateBody: z<VibeCreateInput> = z.object({
  requirement: z.string(),
})

/** POST /api/vibe/:id/restore 的入参：恢复到哪个版本。 */
export interface VibeRestoreInput {
  versionId?: string
}

export const VibeRestoreBody: z<VibeRestoreInput> = z.object({
  versionId: z.string(),
})

/**
 * POST /api/vibe/:id/answer 的入参：整卡提交（`answers` 数组）与单题提交
 * （`questionId` + `selected`/`text`）两种形态都认。
 */
export interface VibeAnswerInput {
  answers?: unknown
  questionId?: string
  selected?: string[]
  text?: string
  skipped?: unknown
}

export const VibeAnswerBody: z<VibeAnswerInput> = z.object({
  answers: z.any(),
  questionId: z.string(),
  selected: optionalStringArray(),
  text: z.string(),
  skipped: z.any(),
})
