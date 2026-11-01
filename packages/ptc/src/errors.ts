/**
 * 绑定调用失败：错误里带着分类，跨进程传过去之后失败分类才不丢。
 *
 * 为什么不让绑定只抛普通 Error：程序里的绑定调用失败有好几种性质完全不同的原因
 * （越界、超出配额、宿主压根没这个绑定），调用方要能区别对待。普通 Error 传过 IPC
 * 就只剩一句 message，分类没了。
 * @module @ryharness/ptc/errors
 */

import type { PtcFailureKind } from './types.ts'

/** 绑定调用失败。 */
export class PtcBindingError extends Error {
  /**
   * @param message - 一句能直接给模型看的中文说明。
   * @param kind - 失败分类；缺省按运行时错误算。
   */
  constructor(
    message: string,
    readonly kind: PtcFailureKind = 'runtime',
  ) {
    super(message)
    this.name = 'PtcBindingError'
  }
}
