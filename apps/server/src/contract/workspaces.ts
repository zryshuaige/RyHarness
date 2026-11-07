/**
 * 工作区域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（名字与根目录非空、目录存在、根目录合法性、
 * 两处归属的回滚）——MISSING_* / ROOT_* / ASSIGN_FAILED 那组机器码保持原样，
 * 迁移不改行为。
 * @module @ryharness/server/contract/workspaces
 */

import z from '@ryharness/schemastery'

/** POST /api/workspaces 的入参：给名字与根目录。 */
export interface WorkspaceCreateInput {
  name?: string
  rootPath?: string
}

export const WorkspaceCreateBody: z<WorkspaceCreateInput> = z.object({
  name: z.string(),
  rootPath: z.string(),
})

/** PATCH /api/conversations/:id/workspace 的入参：归属或摘出（缺省/空串 = 摘出）。 */
export interface WorkspaceAssignInput {
  workspaceId?: string
}

export const WorkspaceAssignBody: z<WorkspaceAssignInput> = z.object({
  workspaceId: z.string(),
})
