/**
 * 调度原因的展示口径（唯一真源）。
 *
 * reason 是给机器看的枚举（user-mention / loop-guard / …），此前右栏与消息流里
 * 直接把它渲染出来，等于把调度器的内部实现甩到界面上。两处渲染空间不同，口径
 * 也就不同，但必须同源派生，否则改一处忘一处就会漂移：
 * - 右栏「调度轨迹」有整行宽度 → 用一句能独立读懂的中文；
 * - 消息流里的接力链是 2–4 字的内联 chip → 用短标签。
 */

/** 护栏类原因：这些接力是被拦下来的，不是真的转了手。 */
const GUARD_REASONS: ReadonlySet<string> = new Set(['loop-guard', 'max-turns'])

const RELAY_LABELS: Readonly<Record<string, string>> = {
  'user-mention': '你点名了它',
  'default-dispatcher': '总管默认接手',
  'loop-guard': '互相推诿已拦下',
  'max-turns': '达到轮次上限',
}

const RELAY_CHAIN_LABELS: Readonly<Record<string, string>> = {
  'user-mention': '点名',
  'default-dispatcher': '调度',
  'loop-guard': '循环保护',
  'max-turns': '轮次上限',
}

/** 接力前缀：`relay @Coder` 表示上一个 agent 主动点名把活转给了 Coder。 */
const RELAY_PREFIX = 'relay @'

/** 右栏/日志口径的完整说明。未知 reason 原样返回（宁可显示原始值，也不吞信息）。 */
export function relayLabel(reason: string): string {
  const known = RELAY_LABELS[reason]
  if (known !== undefined) return known
  if (reason.startsWith(RELAY_PREFIX)) return `点名转交给了${reason.slice(RELAY_PREFIX.length)}`
  return reason
}

/** 接力链内的紧凑标签。 */
export function relayChainLabel(reason: string): string {
  const known = RELAY_CHAIN_LABELS[reason]
  if (known !== undefined) return known
  if (reason.startsWith(RELAY_PREFIX)) return '转交'
  return reason
}

/** 是否为护栏拦截（UI 上用警示色标出）。 */
export function isGuardRelay(reason: string): boolean {
  return GUARD_REASONS.has(reason)
}
