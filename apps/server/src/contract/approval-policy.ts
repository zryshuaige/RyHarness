/**
 * 会话审批策略的请求契约（形状的唯一真源）。
 * @module @ryharness/server/contract/approval-policy
 */

import z from '@ryharness/schemastery'

/** POST /api/conversations/:id/approval-policy 的入参：null = 撤销覆盖。 */
export interface ApprovalPolicyBodyInput {
  policy?: 'ask' | 'never' | null
}

export const ApprovalPolicyBody: z<ApprovalPolicyBodyInput> = z.object({
  policy: z.union([z.const('ask'), z.const('never'), z.const(null)]),
})
