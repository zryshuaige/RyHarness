/**
 * 断口续接/搜索定位并入历史之后，「同一条发言」只留一份（纯函数）。
 *
 * 为什么要在这里收口：补回来的那一份来自服务端落库（key 是 `hist:<id>`），屏上那一份
 * 是流式气泡（key 是 `stream:<sender>:<turn>`，用户自己发的是 `user:<时间戳>:<序>`）。
 * 两边 key 不同，而 store 的 mergeMessages 只按 key 去重——于是断口续接（背压 terminate、
 * 心跳超时、休眠唤醒）之后，同一句话在时间线上出现两次。轮次块按 turnIndex 切，两份还
 * 挤在同一轮里，用户看到的就是"它把刚说过的话又说了一遍"。
 *
 * 判据是「同一个人、同一轮、正文互为前缀」：服务端存的就是模型那一轮吐出来的正文，
 * 流式被掐断时它只到一半（历史那份更长），正常收尾时两者相等。正文完全对不上就一条都
 * 不动——宁可多显示一条，也不替用户猜哪句是假的。
 *
 * 留下的是**历史那一份**：它带服务端消息 id（`hist:<id>` 是搜索定位 data-message-id、
 * 反馈去重、`serverMessageId` 的唯一来源），而且是完整正文；流式副本被掐断时可能只有
 * 半句。工具过程不受影响：服务端把每次工具结果单独落一行（见 coordinator 的
 * tool-result 分支），fromHistory 会把它还原成独立的工具行；工具调用没有正文可比，
 * 那一格按 callId 配对。
 */
import type { UiMessage } from '../store.ts'

/** 一条消息的全部文本部件拼成的正文（文本部件之间不加分隔符：流式就是逐块追加的）。 */
function textOf(message: UiMessage): string {
  let text = ''
  for (const part of message.parts) {
    if (part.kind === 'text') text += part.text
  }
  return text
}

/** 工具/产物部件上的 callId：这才是"同一次工具调用"的唯一凭据。 */
function callIdsOf(message: UiMessage): Set<string> {
  const ids = new Set<string>()
  for (const part of message.parts) {
    if (part.kind === 'text') continue
    ids.add(part.callId)
  }
  return ids
}

/** 同一格：同一个发言者在同一轮里的若干条发言（key 各不相同，配对要一一对应）。 */
function slotOf(message: UiMessage): string {
  return `${message.senderId}#${message.turnIndex}`
}

/** 流式副本与历史行是不是同一条发言。 */
function sameUtterance(streamed: UiMessage, candidate: UiMessage): boolean {
  const streamedText = textOf(streamed)
  const candidateText = textOf(candidate)
  if (streamedText.length > 0 && candidateText.length > 0) {
    return candidateText.startsWith(streamedText) || streamedText.startsWith(candidateText)
  }
  // 只有一方有正文时不配对：拿一条有话的行去顶替一条没话的行，等于把说的话弄丢。
  if (streamedText.length > 0 || candidateText.length > 0) return false
  const ids = callIdsOf(streamed)
  if (ids.size === 0) return false
  for (const id of callIdsOf(candidate)) {
    if (ids.has(id)) return true
  }
  return false
}

/**
 * 历史 → 槽位（同一格：同一个发言者在同一轮里的若干条发言）的索引。
 *
 * **按 history 数组的身份缓存**：流式每来一个 token 就要重算一次对账，而历史数组
 * 在流式期间**不换身份**（只有重拉历史才换）。索引建一次、之后每帧只扫流式那几条。
 *
 * 此前每帧都重建这张表：5000 条历史时每秒几十次、每次几千个 Map 条目——每秒十几 MB
 * 的垃圾，全花在"把同一张表再算一遍"上。
 */
const slotIndexCache = new WeakMap<readonly UiMessage[], Map<string, UiMessage[]>>()

function slotIndex(history: readonly UiMessage[]): Map<string, UiMessage[]> {
  const cached = slotIndexCache.get(history)
  if (cached !== undefined) return cached
  const slots = new Map<string, UiMessage[]>()
  for (const message of history) {
    const slot = slotOf(message)
    const bucket = slots.get(slot)
    if (bucket === undefined) slots.set(slot, [message])
    else bucket.push(message)
  }
  slotIndexCache.set(history, slots)
  return slots
}

/**
 * 把已被历史覆盖的流式副本剔掉。
 *
 * 返回值是两个数组而不是一条时间线：排序仍由 store 的 mergeTimeline 负责（判据是
 * turnIndex，不是 seq），这里只回答"哪一份留下来"。没有需要剔除的副本时两边都原样
 * 返回——流式每来一个 token 就会重算，别在常态路径上多分配两个数组。
 */
export function reconcileStreamed(
  history: readonly UiMessage[],
  streamed: readonly UiMessage[],
): { history: readonly UiMessage[]; streamed: readonly UiMessage[] } {
  if (history.length === 0 || streamed.length === 0) return { history, streamed }
  const slots = slotIndex(history)
  /** 已被配上的历史行：一条历史只对应一条流式，否则两次发言会被并成一条。 */
  const claimed = new Set<string>()
  const duplicates = new Set<string>()
  for (const message of streamed) {
    const candidates = slots.get(slotOf(message))
    if (candidates === undefined) continue
    for (const candidate of candidates) {
      if (claimed.has(candidate.key)) continue
      if (!sameUtterance(message, candidate)) continue
      claimed.add(candidate.key)
      duplicates.add(message.key)
      break
    }
  }
  if (duplicates.size === 0) return { history, streamed }
  return {
    history,
    streamed: streamed.filter((message) => {
      return !duplicates.has(message.key)
    }),
  }
}
