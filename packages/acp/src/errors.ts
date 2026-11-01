/**
 * ACP 的机器码。
 * @module @ryharness/acp/errors
 */

import { RemoteError } from '@ryharness/typert-protocol'

declare module '@ryharness/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 对端回的东西不符合协议。 */
    'acp/invalid-response': { readonly method: string }
    /** 会话已经关了或者根本不存在。 */
    'acp/session-unknown': { readonly sessionId: string }
  }
}

/**
 * 对端回的东西不认识。
 * @param method - 哪个方法回的。
 * @returns 带机器码的失败。
 */
export function invalidResponseFailure(method: string): RemoteError<'acp/invalid-response'> {
  return new RemoteError('acp/invalid-response', `对端回的 "${method}" 不符合协议`, { method })
}

/**
 * 会话不存在或已经关了。
 * @param sessionId - 会话 id。
 * @returns 带机器码的失败。
 */
export function sessionUnknownFailure(sessionId: string): RemoteError<'acp/session-unknown'> {
  return new RemoteError('acp/session-unknown', `没有这个会话：${sessionId}`, { sessionId })
}
