/**
 * 进化域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型（这些都是字符串字段），handler 管语义（signal 取值、status 取值、
 * 重复反馈判重、进化系统开关）——手写时代贴着响应文案的 400 保持原样，迁移不改
 * 行为。`signal` / `status` 故意只标 string：它们的取值错误回的是 handler 自己
 * 的 400 文案，不是 schema 的 union 报错。
 * @module @ryharness/server/contract/evolve
 */

import z from '@ryharness/schemastery'

/** POST /api/feedback 的入参：一次 👍/👎 反馈。 */
export interface FeedbackInput {
  conversationId?: string
  agentId?: string
  signal?: string
  messageId?: string
  userText?: string
  assistantText?: string
}

export const FeedbackBody: z<FeedbackInput> = z.object({
  conversationId: z.string(),
  agentId: z.string(),
  signal: z.string(),
  messageId: z.string(),
  userText: z.string(),
  assistantText: z.string(),
})

/** POST /api/playbook/:id/status 的入参：手动 deprecate / 恢复条目。 */
export interface PlaybookStatusInput {
  status?: string
}

export const PlaybookStatusBody: z<PlaybookStatusInput> = z.object({
  status: z.string(),
})
