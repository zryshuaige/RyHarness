/**
 * 长会话流式时的时间线重算（性能基线，不进默认 CI 通道，用 `pnpm perf` 手动跑）。
 *
 * 流式每来一个 token，聊天区就要把「已加载历史 + 屏上流式」合成一条时间线。此前这
 * 一步每帧都做两件与帧长无关的傻事：把几千条历史按「同一个人同一轮」重新分桶
 * 建表、再把整条时间线重新排一次。5000 条历史时每秒几十次、每次几千个 Map 条目，
 * 光是这些临时对象就是每秒十几 MB 垃圾。
 *
 * 断言用**比值**而不是绝对毫秒（机器快慢、CI 负载都不该让基线漂）：
 *  1. 等价性：新路径与旧路径合出来的时间线逐条相同（先证对，再证快）；
 *  2. 收益：长历史下新路径显著便宜于旧路径。
 *
 * 未覆盖（需要真实 Chromium）：帧时间 p50/p95、GC 堆基线。
 * @module apps/desktop/tests/perf/timeline
 */

import { describe, expect, it } from 'vitest'
import { reconcileStreamed } from '../../renderer/src/lib/stream-history.ts'
import { mergeTimeline, type UiMessage } from '../../renderer/src/store.ts'

/** 一条历史消息：轮次递增，正文各不相同。 */
function historyOf(count: number): UiMessage[] {
  const messages: UiMessage[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push({
      key: `hist:m${index}`,
      senderType: 'agent',
      senderId: index % 3 === 0 ? 'ryen' : 'ryen-team-coding',
      senderName: 'Ryen',
      turnIndex: Math.floor(index / 2),
      seq: index,
      parts: [{ kind: 'text', text: `第 ${index} 条历史` }],
      done: true,
    })
  }
  return messages
}

/** 屏上正在流式的那一条（当前轮）。 */
function streamedOf(turnIndex: number): UiMessage[] {
  return [
    {
      key: `stream:ryen:${turnIndex}`,
      senderType: 'agent',
      senderId: 'ryen',
      senderName: 'Ryen',
      turnIndex,
      parts: [{ kind: 'text', text: '正在写' }],
      done: false,
    },
  ]
}

/** 旧实现：每帧重建槽位索引。 */
function reconcileNaive(history: readonly UiMessage[], streamed: readonly UiMessage[]): UiMessage[] {
  const slots = new Map<string, UiMessage[]>()
  for (const message of history) {
    const slot = `${message.senderId}#${message.turnIndex}`
    const bucket = slots.get(slot)
    if (bucket === undefined) slots.set(slot, [message])
    else bucket.push(message)
  }
  const claimed = new Set<string>()
  const duplicates = new Set<string>()
  for (const message of streamed) {
    const candidates = slots.get(`${message.senderId}#${message.turnIndex}`)
    if (candidates === undefined) continue
    for (const candidate of candidates) {
      if (claimed.has(candidate.key)) continue
      const streamedText = message.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
      const candidateText = candidate.parts.map((part) => (part.kind === 'text' ? part.text : '')).join('')
      if (streamedText.length === 0 || candidateText.length === 0) continue
      if (!candidateText.startsWith(streamedText) && !streamedText.startsWith(candidateText)) continue
      claimed.add(candidate.key)
      duplicates.add(message.key)
      break
    }
  }
  return streamed.filter((message) => {
    return !duplicates.has(message.key)
  })
}

/** 旧实现：每帧整条时间线重排。 */
function mergeNaive(history: readonly UiMessage[], streamed: readonly UiMessage[]): UiMessage[] {
  return [...history, ...streamed].sort((a, b) => {
    return a.turnIndex - b.turnIndex
  })
}

/** 跑 frames 次「对账 + 合并」，返回耗时（毫秒）。 */
function runFrames(history: readonly UiMessage[], frames: number, naive: boolean): number {
  const started = performance.now()
  for (let index = 0; index < frames; index += 1) {
    // 每帧的流式气泡内容都变一点：真实的流式就是每帧换一个数组。
    const streamed = streamedOf(history.length / 2 + index)
    const reconciled = naive
      ? { history, streamed: reconcileNaive(history, streamed) }
      : reconcileStreamed(history, streamed)
    if (naive) mergeNaive(reconciled.history, reconciled.streamed)
    else mergeTimeline(reconciled.history, reconciled.streamed)
  }
  return performance.now() - started
}

describe('长会话流式：时间线重算（性能基线）', () => {
  it('等价性：新路径与旧路径合出来的时间线逐条相同', () => {
    const history = historyOf(500)
    const streamed = streamedOf(250)
    const naive = mergeNaive(history, reconcileNaive(history, streamed))
    const fast = mergeTimeline(history, reconcileStreamed(history, streamed).streamed)
    expect(
      fast.map((message) => {
        return message.key
      }),
    ).toEqual(
      naive.map((message) => {
        return message.key
      }),
    )
  })

  it('收益：5000 条历史时，新路径明显便宜于「每帧重建索引 + 每帧重排」', () => {
    const history = historyOf(5000)
    const frames = 40
    // 先热 JIT：第一次调用的编译开销不该算进基线。
    runFrames(history, 5, true)
    runFrames(history, 5, false)

    const naiveMs = runFrames(history, frames, true)
    const fastMs = runFrames(history, frames, false)

    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${history.length} 条历史 × ${frames} 帧：新路径 ${fastMs.toFixed(2)}ms vs 旧路径 ${naiveMs.toFixed(2)}ms`,
    )
    // 留足余量：实测新路径约为旧路径的 1/3 以下（历史的分桶索引只建一次）。
    expect(fastMs).toBeLessThan(naiveMs * 0.6)
  })
})
