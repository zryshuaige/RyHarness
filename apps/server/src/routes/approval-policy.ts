/**
 * 会话审批策略路由：对一个会话显式放行（'never'）或恢复逐条问（'ask'）。
 *
 * 形状照抄 sandbox 的会话级覆盖（routes/sandbox.ts）——「临时放开某个会话」在
 * 这套产品里已经有了一个家，审批策略跟它姓同一个：进程内存、重启即回逐条问、
 * 撤销键显式给 null。
 * @module @ryharness/server/routes/approval-policy
 */

import type { ApprovalBroker } from '../approvals.ts'
import { ApprovalPolicyBody } from '../contract/approval-policy.ts'
import { route } from '../route.ts'
import { json, type Router } from '../router.ts'

/** 审批策略路由的依赖。 */
export interface ApprovalPolicyRoutes {
  approvals: ApprovalBroker
  /** 会话是否存在（404 判定用）。 */
  conversationExists: (conversationId: string) => boolean
}

/** 注册会话审批策略路由。 */
export function registerApprovalPolicyRoutes(router: Router, deps: ApprovalPolicyRoutes): void {
  router.get('/api/conversations/:id/approval-policy', async (req, res) => {
    const conversationId = req.params.id as string
    if (!deps.conversationExists(conversationId)) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    json(res, 200, { policy: deps.approvals.policyOf(conversationId) })
  })

  route(router, 'POST', '/api/conversations/:id/approval-policy', { body: ApprovalPolicyBody }, async (req, res) => {
    const conversationId = req.params.id as string
    if (!deps.conversationExists(conversationId)) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const policy = (await req.body()).policy
    deps.approvals.setPolicy(conversationId, policy ?? undefined)
    json(res, 200, { conversationId, policy: deps.approvals.policyOf(conversationId) })
  })
}
