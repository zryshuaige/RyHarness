/**
 * 工具执行审批桥：requiresApproval 的工具（shell_exec）在执行前等用户点头。
 *
 * 链路：AgentLoop 的 approver 挂点 → 这里发 `approval-request` WS 事件 → 渲染层
 * 出审批卡 → 用户点允许/拒绝 → HTTP POST 决议 → resolve 掉挂着的 Promise →
 * 循环继续。超时按拒绝收口（绝不静默放行），轮次取消时全部按取消撤卡。
 *
 * 「记住这条命令」是**本次进程内**的精确匹配白名单（会话 + 工具名 + 参数原文）：
 * 不落盘——落盘的白名单会在用户忘了它存在之后继续放行；重启后重新问一遍，
 * 是保守但不会背叛用户的语义。
 *
 * @module @ryharness/server/approvals
 */

import { randomUUID } from 'node:crypto'
import type { EventHub } from './bus.ts'
import type { WsEvent } from './events.ts'

/** 一次挂起的审批。 */
interface PendingApproval {
  conversationId: string
  toolName: string
  /** 参数原文：白名单按它精确匹配，不做前缀/模糊——近似匹配放行的面不可审计。 */
  args: string
  resolve: (allowed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  /** 允许时勾选「记住这条命令」：同会话同参数原文的后续调用不再询问。 */
  remember?: boolean
}

/** 默认审批等待上限：超时按拒绝收口。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  /** 会话内白名单（键 = 会话|工具名 → 参数原文集合）。进程内有效。 */
  private readonly remembered = new Map<string, Set<string>>()

  constructor(
    private readonly hub: EventHub,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  /**
   * AgentLoop 挂进来的审批入口。
   * @returns true=放行（白名单命中或用户允许）；false=拒绝（用户拒绝/超时/取消）。
   */
  request(input: { conversationId: string; agentId: string; toolName: string; args: string }): Promise<boolean> {
    const rememberedSet = this.remembered.get(this.rememberKey(input.conversationId, input.toolName))
    if (rememberedSet !== undefined && rememberedSet.has(input.args)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const approvalId = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(approvalId)
        this.publishResolved(input.conversationId, approvalId, 'timeout')
        resolve(false)
      }, this.timeoutMs)
      this.pending.set(approvalId, {
        conversationId: input.conversationId,
        toolName: input.toolName,
        args: input.args,
        resolve,
        timer,
      })
      const event: WsEvent = {
        type: 'approval-request',
        conversationId: input.conversationId,
        senderId: input.agentId,
        approvalId,
        toolName: input.toolName,
        arguments: input.args,
      }
      this.hub.publish(event)
    })
  }

  /**
   * 用户决议（HTTP 路由进来）。
   * @returns 是否命中挂起中的审批（找不到/已被超时收口返回 false，路由据此 404）。
   */
  decide(conversationId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(approvalId)
    if (pending === undefined || pending.conversationId !== conversationId) return false
    this.pending.delete(approvalId)
    clearTimeout(pending.timer)
    const allowed = decision.decision === 'allow'
    if (allowed && decision.remember === true) {
      const key = this.rememberKey(conversationId, pending.toolName)
      const set = this.remembered.get(key) ?? new Set<string>()
      set.add(pending.args)
      this.remembered.set(key, set)
    }
    this.publishResolved(conversationId, approvalId, allowed ? 'allow' : 'deny')
    pending.resolve(allowed)
    return true
  }

  /** 该会话挂起中的审批全部按取消收口（轮次取消/被顶掉时调用：不留死等）。 */
  cancelConversation(conversationId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.conversationId !== conversationId) continue
      this.pending.delete(approvalId)
      clearTimeout(pending.timer)
      this.publishResolved(conversationId, approvalId, 'cancelled')
      pending.resolve(false)
    }
  }

  /** 该会话挂起中的审批（观测/测试用；返回副本）。 */
  pendingOf(conversationId: string): { approvalId: string; toolName: string; arguments: string }[] {
    const out: { approvalId: string; toolName: string; arguments: string }[] = []
    for (const [approvalId, pending] of this.pending) {
      if (pending.conversationId !== conversationId) continue
      out.push({ approvalId, toolName: pending.toolName, arguments: pending.args })
    }
    return out
  }

  private rememberKey(conversationId: string, toolName: string): string {
    return `${conversationId}|${toolName}`
  }

  private publishResolved(
    conversationId: string,
    approvalId: string,
    outcome: 'allow' | 'deny' | 'timeout' | 'cancelled',
  ): void {
    const event: WsEvent = {
      type: 'approval-resolved',
      conversationId,
      approvalId,
      outcome,
    }
    this.hub.publish(event)
  }
}
