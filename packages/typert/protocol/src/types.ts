/**
 * The wire vocabulary `@ryagent/llm` actually depends on: the Remote failure
 * code registry its `@Remote` methods augment, plus the derived failure union
 * the carrier and consumers discriminate on.
 *
 * 上游 `dsh-typert-protocol` 在这里还声明了一整套 Typert Gateway 运行时
 * （lookup/context 注册表、codec 描述符、stream 句柄、事件转发、Peer/Connection
 * 会话）。RyAgent 裁剪内核时没有裁掉它，但它在本仓没有实现方：没有 gateway 包、
 * 没有连接层、没有生成的 Client，Gateway 是将来才可能落地的多端形态。因此这里
 * 只保留已接线的那部分；要接 Gateway 时，从上游按实际需要重新引入，别把它当成本
 * 包已具备的能力。
 *
 * @module @ryagent/typert-protocol/types
 */

/**
 * Merge-extensible Remote failure vocabulary: this package declares the
 * universal carrier codes once; every owner merges its domain codes next to the
 * throwing code.
 */
export interface RemoteErrorDetailsMap {
  /** Owner-side business validation refused the request; `issues` carries codec output when one produced it. */
  'gateway/bad-request': { readonly issues?: readonly object[] }
  /** The call was cancelled by the carrier signal or the backend. */
  'gateway/cancelled': {}
  /** Carrier, dispatch, or unclassified Host failure. */
  'gateway/internal': {}
}

/** Every declared Remote failure code. */
export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * One Remote call's failure: the code-discriminated union of RemoteError
 * instances, so a `code` branch narrows `details` with no cast.
 */
export type RemoteFailure = {
  [Code in RemoteErrorCode]: import('./remote-error.ts').RemoteError<Code>
}[RemoteErrorCode]
