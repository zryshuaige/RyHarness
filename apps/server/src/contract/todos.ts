/**
 * 待办域的请求契约：**形状的唯一真源**。
 *
 * schema 管类型，handler 管语义（conversationId 是否真实存在、条目形状的逐条
 * 校验）——TODO_* 机器码的 400 保持原样，迁移不改行为。
 *
 * `items` 故意只标 unknown：撤销清空回传的条目带**宽容改写**语义（createdAt 非
 * 数字当场取 now、done 非 true 即 false），schema 化会把「宽容收下」变成 400——
 * 那是行为变化，逐条形状校验因此留在 handler。
 * @module @ryharness/server/contract/todos
 */

import z from '@ryharness/schemastery'

/** PATCH /api/todos/:id 的入参：勾选 / 取消勾选一条待办。 */
export interface TodoSetDoneInput {
  conversationId?: string
  done?: boolean
}

export const TodoSetDoneBody: z<TodoSetDoneInput> = z.object({
  conversationId: z.string(),
  done: z.boolean(),
})

/** POST /api/todos/restore 的入参：把被清掉的那批待办原样写回。 */
export interface TodoRestoreInput {
  conversationId?: string
  items?: unknown
}

export const TodoRestoreBody: z<TodoRestoreInput> = z.object({
  conversationId: z.string(),
  items: z.any(),
})
