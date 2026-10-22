/**
 * 草稿的跨重启持久化（localStorage）。
 *
 * 草稿此前只活在内存里的会话桶：切会话丢不了（桶还在），**重启应用就没了**。
 * 一个下午打到一半的句子因为手滑关了窗口而消失，是那种"软件不可信"的感觉——
 * 哪怕它只丢半句话。
 *
 * 落在 localStorage 而不是服务端：草稿是**本机未发送的输入**，不是会话记录；
 * 放服务端会把它混进"消息"这套语义里（还要考虑加密、备份、跨设备）。
 *
 * 三条边界：
 * - 隐私模式下 localStorage 不可用 → 静默降级为"只在内存里"，不报错；
 * - 单条草稿有体积上限 → 超限不落盘（别把一个粘贴进来的大文件塞进 localStorage）；
 * - 键按会话分 → 切回那个会话时草稿还在原处。
 *
 * @module @ryharness/renderer/lib/drafts
 */

import { readSetting, removeSetting, writeSetting } from './storage.ts'

/** 草稿键前缀（按会话 id 分）。 */
const DRAFT_KEY_PREFIX = 'ryharness-draft:'

/** 单条草稿的体积上限（字节）：超过就不落盘。 */
export const MAX_DRAFT_BYTES = 64 * 1024

/** 某个会话的草稿键。 */
export function draftKey(conversationId: string): string {
  return `${DRAFT_KEY_PREFIX}${conversationId}`
}

/** localStorage 是否可用（隐私模式与部分测试环境里没有）。 */
function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage
  } catch {
    // 某些环境访问 localStorage 本身就抛（安全策略）。
    return undefined
  }
}

/**
 * 存一条草稿。
 *
 * 空串 = 草稿没了 → 删键（而不是写一个空串进去：空串会让"这条会话有草稿"的
 * 判断失去意义，桶的 LRU 逐出策略正是按它排的）。
 */
export function saveDraft(conversationId: string, text: string): void {
  const store = storage()
  if (store === undefined) return
  const key = draftKey(conversationId)
  try {
    if (text.length === 0) {
      removeSetting(key)
      return
    }
    if (text.length > MAX_DRAFT_BYTES) return
    writeSetting(key, text)
  } catch {
    // 写不进去（配额满、只读模式）：静默降级为"只在内存里"。
  }
}

/** 读一条草稿；没有或读不出来都是空串。 */
export function loadDraft(conversationId: string): string {
  const store = storage()
  if (store === undefined) return ''
  try {
    return readSetting(draftKey(conversationId)) ?? ''
  } catch {
    return ''
  }
}

/** 删掉一条草稿（消息发出去之后）。 */
export function clearDraft(conversationId: string): void {
  const store = storage()
  if (store === undefined) return
  try {
    removeSetting(draftKey(conversationId))
  } catch {
    // 忽略：删不掉也只是下次启动时草稿还在。
  }
}
