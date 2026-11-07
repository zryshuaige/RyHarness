/**
 * 长期记忆域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（内容去空白与长度上限、id 是否存在、状态是否
 * 归档、embedding 供应商与凭据校验）——这些 400 的回包是 `json()` 直出的
 * `{error}`（没有 code 字段），必须留在 handler 而不是被 schema 的报错接管。
 * @module @ryharness/server/contract/memory
 */

import z from '@ryharness/schemastery'

/** PATCH /api/memories/:id 的入参：就地改一条记忆的正文。 */
export interface MemoryPatchInput {
  content?: string
}

export const MemoryPatchBody: z<MemoryPatchInput> = z.object({
  content: z.string(),
})

/** POST /api/memory/restore 的入参：要恢复的归档记忆 id。 */
export interface MemoryRestoreInput {
  id?: string
}

export const MemoryRestoreBody: z<MemoryRestoreInput> = z.object({
  id: z.string(),
})

/** POST /api/memory/embedding 的入参：换向量模型。 */
export interface EmbeddingInput {
  providerId?: string
  model?: string
}

export const EmbeddingBody: z<EmbeddingInput> = z.object({
  providerId: z.string(),
  model: z.string(),
})
