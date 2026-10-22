/**
 * 调度原因的展示口径（唯一真源）。
 *
 * reason 是给机器看的枚举（user-mention / loop-guard / …），此前右栏与消息流里
 * 直接把它渲染出来，等于把调度器的内部实现甩到界面上。两处渲染空间不同，口径
 * 也就不同，但必须同源派生，否则改一处忘一处就会漂移：
 * - 右栏「调度轨迹」有整行宽度 → 用一句能独立读懂的中文；
 * - 消息流里的接力链是 2–4 字的内联 chip → 用短标签。
 *
 * 右栏轨迹默认折叠（见 relayTimelineSummary），折叠行同样不许露出 reason：
 * 默认可见的那一行才是用户真正会读到的文案。
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

/** 机器枚举的形态：全 ASCII 可打印字符。未知 reason 命中它时一律不许上屏。 */
const ASCII_ENUM = /^[\x20-\x7E]+$/

/** 右栏/日志口径的完整说明。未知 reason：机器枚举换人话，中文原样保留。 */
export function relayLabel(reason: string): string {
  const known = RELAY_LABELS[reason]
  if (known !== undefined) return known
  if (reason.startsWith(RELAY_PREFIX)) return `点名转交给了${reason.slice(RELAY_PREFIX.length)}`
  if (ASCII_ENUM.test(reason)) return '自动安排'
  return reason
}

/** 接力链内的紧凑标签。 */
export function relayChainLabel(reason: string): string {
  const known = RELAY_CHAIN_LABELS[reason]
  if (known !== undefined) return known
  if (reason.startsWith(RELAY_PREFIX)) return '转交'
  if (ASCII_ENUM.test(reason)) return '调度'
  return reason
}

/** 是否为护栏拦截（UI 上用警示色标出）。 */
export function isGuardRelay(reason: string): boolean {
  return GUARD_REASONS.has(reason)
}

/**
 * 折叠态那一行的口径：派了几次、最后谁交付。
 *
 * 轨迹默认收起，用户能看到的只有这一行，所以它必须自成一句人话——把 reason
 * （机器枚举）写进来等于换个地方又把调度器的内部实现甩给界面。取最后一条的
 * 接手方当"交付方"：调度链的末端就是这轮活真正落到人身上的地方。
 */
export function relayTimelineSummary(relays: readonly { toAgent: string }[], nameOf: (id: string) => string): string {
  const last = relays.at(-1)
  if (last === undefined) return '本轮还没有派工'
  return `${relays.length} 次派工 · 最后由 ${nameOf(last.toAgent)} 交付`
}
