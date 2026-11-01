/**
 * 超时闸。
 *
 * 为什么不只靠 AbortSignal：取消信号只在「对方配合」时才管用——一个不理会信号的
 * 取回器会让等待一直悬着，模型那边就是一轮永远不返回的 tool call。这里多一条
 * 必到的拒绝分支，于是「超时」是保证发生的事，而不是对方的善意。
 * @module @ryharness/web/timeout
 */

/** 一次操作的超时闸。 */
export interface TimeoutGate {
  /** 与业务 promise 赛跑的那一条：它先落地就说明超时了。 */
  gate: Promise<never>
  /** 收尾：清掉计时器。 */
  cancel: () => void
  /** 已经超时了吗。 */
  expired: () => boolean
}

/**
 * 造一个超时闸。
 * @param timeoutMs - 超时毫秒数。
 * @param controller - 取消信号：超时时要把它按下去，让还在跑的请求收手。
 * @param label - 超时消息的前缀（如「读取超时」「搜索超时」）。
 * @returns 超时闸。
 */
export function createTimeoutGate(timeoutMs: number, controller: AbortController, label: string): TimeoutGate {
  let fail: ((reason: Error) => void) | undefined
  let expired = false
  const gate = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
    fail?.(new Error(`${label}（${timeoutMs} 毫秒）`))
  }, timeoutMs)
  return {
    gate,
    cancel: () => {
      clearTimeout(timer)
    },
    expired: () => expired,
  }
}
