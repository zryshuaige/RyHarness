/**
 * 插件域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型（enabled 必须是布尔），handler 管语义（core 插件 403、未知插件
 * 404）——迁移不改行为。
 * @module @ryharness/server/contract/plugins
 */

import z from '@ryharness/schemastery'

/** PATCH /api/plugins/:id 的入参：开关是唯一可改的字段。 */
export interface PluginPatchInput {
  enabled: boolean
}

export const PluginPatchBody: z<PluginPatchInput> = z.object({
  enabled: z.boolean().required(),
})
