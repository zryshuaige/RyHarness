/**
 * 个人资料域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（空名字、长度上限、控制字符——那组 400 带着
 * PROFILE_BAD_REQUEST 机器码，不能被 schema 的报错接管）。`writeProfile` 本身
 * 仍收 `unknown`：它是导出 API，测试与其他调用方会直接喂形状不定的输入，它的
 * 类型守卫因此继续服役；HTTP 面上的类型由这里的 schema 先拦。
 * @module @ryharness/server/contract/profile
 */

import z from '@ryharness/schemastery'

/** PATCH /api/profile 的入参：没给的字段 = 不改（不是改回缺省）。 */
export interface ProfilePatchInput {
  name?: string
  avatar?: string
}

export const ProfilePatchBody: z<ProfilePatchInput> = z.object({
  name: z.string(),
  avatar: z.string(),
})
