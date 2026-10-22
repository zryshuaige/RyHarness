/**
 * 服务端测试共用的流控助手。
 *
 * 「在 signal 被掐断前一直挂起」这件事，多个测试文件都要用：占住某个会话的串行链、
 * 逼出「中止之后那一轮怎么收尾」这些路径。抄一份到每个文件里，重复代码门禁
 * （scripts/verify-duplication.mjs）会判为复制粘贴——所以放在这里，各处 import。
 * @module @ryharness/server/tests/helpers/stream
 */

/** 在 signal 被掐断前挂起：让某条消息一直占着会话的串行链。 */
export function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return
    const onAbort = (): void => {
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
