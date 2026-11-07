/**
 * 设置域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（凭据是否齐全、供应商是否存在）——`json()`
 * 直出的 `{error}` 回包保持原样，迁移不改行为。
 * @module @ryharness/server/contract/settings
 */

import z from '@ryharness/schemastery'

/** POST /api/settings/api-key 的入参：给某家供应商配凭据。 */
export interface ApiKeyInput {
  providerId?: string
  apiKey?: string
}

export const ApiKeyBody: z<ApiKeyInput> = z.object({
  providerId: z.string(),
  apiKey: z.string(),
})
