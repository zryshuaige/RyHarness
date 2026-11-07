/**
 * 提问域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（回答非空、问题 id 是否存在）——带着
 * QUESTION_* 机器码的 400 保持原样，迁移不改行为。
 * @module @ryharness/server/contract/questions
 */

import z from '@ryharness/schemastery'
import { optionalStringArray } from './util.ts'

/** POST /api/questions/:id/answer 的入参：一句回答 + 勾过的选项。 */
export interface QuestionAnswerInput {
  text?: string
  selected?: string[]
}

export const QuestionAnswerBody: z<QuestionAnswerInput> = z.object({
  text: z.string(),
  selected: optionalStringArray(),
})
