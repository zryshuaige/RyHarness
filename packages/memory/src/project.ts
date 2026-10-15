/**
 * 记忆的对外投影：向量只在包内流转，接口回包只给业务字段。
 *
 * {@link MemoryRow} 带着 `embedding`（Float32Array）。直接 JSON.stringify 它，
 * 向量会变成 `{"0":0.0123,"1":…,"1023":-0.008}` 这样一坨「下标→数值」的对象：
 * 一条 1024 维记忆就是几千个字段，一页记忆列表轻松到几 MB（实测单请求
 * 5.26MB），而这些数字对渲染层毫无用处——它们是检索的内部状态。
 *
 * 约定：凡是**要出包**的记忆列表（HTTP 回包、事件负载、导出）都先过
 * {@link toPublicMemory}，不许把 store 的原始行直接往外抛。
 * @module @ryagent/memory/project
 */

import type { MemoryKind } from './schema.ts'
import type { MemoryRow } from './store.ts'

/** 记忆的对外形状（渲染层与接口共用；字段与渲染层的记忆面板一一对应）。 */
export interface PublicMemoryRow {
  id: string
  agentId: string
  kind: MemoryKind
  content: string
  createdAt: number
  updatedAt: number
  accessCount: number
  sourceConversationId?: string
}

/** 单条投影：白名单挑字段，embedding/dim/embeddingModel 等一律不出包。 */
export function toPublicMemory(row: MemoryRow): PublicMemoryRow {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessCount: row.accessCount,
    ...(row.sourceConversationId === undefined ? {} : { sourceConversationId: row.sourceConversationId }),
  }
}

/** 列表投影（接口回包直接用它；空数组也返回空数组，不给 undefined）。 */
export function toPublicMemories(rows: readonly MemoryRow[]): PublicMemoryRow[] {
  return rows.map(toPublicMemory)
}
