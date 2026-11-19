/**
 * 会话域的请求契约：**形状的唯一真源**。
 *
 * 规矩（照 dsh 的双注解手法）：接口人写、schema 用 `z<Input>` 钉住——哪边先改，
 * 另一边编译报错，手抄 drift（dispatcherAgentId 三处三种口径）从此没有生存空间。
 *
 * schema 管**类型**（这个字段是什么、缺了行不行）；handler 管**语义**（空串报什么
 * 错、成员是否存在、跨字段规则）——手写时代那些贴着响应文案的 400 保持原样，
 * 迁移不改行为。
 * @module @ryharness/server/contract/conversations
 */

import z from '@ryharness/schemastery'
import { optionalStringArray } from './util.ts'

/** PATCH /api/conversations/:id 的界面态补丁。 */
export interface ConversationPatchInput {
  title?: string
  pinned?: boolean
  muted?: boolean
  memberAgentIds?: string[]
}

export const ConversationPatchBody: z<ConversationPatchInput> = z.object({
  title: z.string(),
  pinned: z.boolean(),
  muted: z.boolean(),
  memberAgentIds: optionalStringArray(),
})

/**
 * POST /api/conversations 的建会话入参。
 *
 * `kind` 的 direct/group 分支与跨字段校验（成员必须存在、调度员必须在名单里）
 * 留在 handler——那是业务规则不是形状。`dispatcherAgentId` 在这里**有**：建群
 * 时它就是要落库的字段；PATCH 的界面态补丁里**没有**（服务端从不接受改它），
 * 手写时代那份多抄的键正是 drift 本体。
 */
export interface CreateConversationInput {
  kind: string
  agentId?: string
  title?: string
  memberAgentIds?: string[]
  dispatcherAgentId?: string
}

export const CreateConversationBody: z<CreateConversationInput> = z.object({
  kind: z.string().required(),
  agentId: z.string(),
  title: z.string(),
  memberAgentIds: optionalStringArray(),
  dispatcherAgentId: z.string(),
})

/** POST …/messages 与 …/messages/:seq/edit 共用：正文一条。 */
export interface SendTextInput {
  text?: string
}

export const SendTextBody: z<SendTextInput> = z.object({
  text: z.string(),
})

/** POST …/approvals/:approvalId 的决议。 */
export interface ApprovalDecisionInput {
  decision?: 'allow' | 'deny'
  remember?: boolean
}

export const ApprovalDecisionBody: z<ApprovalDecisionInput> = z.object({
  decision: z.union([z.const('allow'), z.const('deny')]),
  remember: z.boolean(),
})

/** POST …/branch 的分支点：从哪条消息分叉（1 起的消息号）。 */
export interface BranchInput {
  atSeq?: number
  title?: string
}

export const BranchBody: z<BranchInput> = z.object({
  atSeq: z.natural().min(1),
  title: z.string(),
})

/** POST /api/conversations/:id/files 的上传体。 */
export interface UploadArtifactInput {
  name?: string
  data?: string
  mime?: string
}

export const UploadArtifactBody: z<UploadArtifactInput> = z.object({
  name: z.string(),
  data: z.string(),
  mime: z.string(),
})

/**
 * GET /api/conversations/:id/context 的只读响应：composer 的模型读数。
 *
 * 解析在服务端完成（direct → 唯一成员，group → 调度员），与 loop 实际派工同一口径；
 * 渲染层自己 join 会话成员 + agent 清单 + 供应商清单的话，composer 就得为一行读数
 * 订阅两份 store，40ms 流式窗口下每帧重算。
 *
 * `contextWindow` 只取供应商里**声明**的值：适配器没报、用户没补录时是 null，
 * 界面显示「上下文未知」——绝不猜一个数字（见 routes/providers.ts 的注释）。
 */
export interface ConversationContextView {
  providerId: string
  modelId: string
  /** 「模型叶名 · 供应商名」的读数（服务端口径，渲染层沿用 modelPair 的同一套写法）。 */
  modelLabel: string
  contextWindow: number | null
  /** 本会话累计 token（与 GET /api/conversations/:id 的 usage 同一聚合）。 */
  usedTokens: number | null
}

/** POST /api/attachments/lookup 的查重体。 */
export interface AttachmentLookupInput {
  data?: string
}

export const AttachmentLookupBody: z<AttachmentLookupInput> = z.object({
  data: z.string(),
})
