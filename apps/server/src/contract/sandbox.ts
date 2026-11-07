/**
 * 沙箱域的请求契约：**形状的唯一真源**。
 *
 * `mode` 的取值白名单（三个模式）是 handler 的语义校验：传了个不认识的**字符串**
 * 回的是带 SANDBOX_BAD_MODE 机器码的 400，所以这里只约束「字符串或 null」——
 * null 表示撤掉覆盖（回到助理自己的档位）。
 * @module @ryharness/server/contract/sandbox
 */

import z from '@ryharness/schemastery'

/** POST /api/sandbox/conversations/:id 的入参：设 / 撤一个会话的覆盖。 */
export interface SandboxOverrideInput {
  mode?: string | null
}

export const SandboxOverrideBody: z<SandboxOverrideInput> = z.object({
  mode: z.union([z.string(), z.const(null)]),
})
