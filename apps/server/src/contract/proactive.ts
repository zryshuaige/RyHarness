/**
 * 主动消息域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（未知键拒绝、hour 的整数与 0-23 范围——那两条
 * 400 的文案是手写时代的原样）。注意 schema 的 object 会**透传未知键**（归一化
 * 只补齐声明的字段，多余的键原样保留），所以「敲错的键 400」必须留在 handler。
 * @module @ryharness/server/contract/proactive
 */

import z from '@ryharness/schemastery'

/** PATCH /api/proactive 的入参：`{ enabled?, hour? }`。 */
export interface ProactiveSettingsInput {
  enabled?: boolean
  hour?: number
}

export const ProactiveSettingsBody: z<ProactiveSettingsInput> = z.object({
  enabled: z.boolean(),
  hour: z.number(),
})
