/**
 * 查询服务的领域错误。
 *
 * 只有三种情况值得当成「错误」抛出去，其余（查不到、翻到头）都是正常结果，
 * 用 `undefined` / 空数组表达。分出来是因为它们各自的处置不一样：游标坏了是
 * 调用方的 bug（换一次筛选条件重来），会话不存在是正常事实。
 * @module @ryharness/session-query/errors
 */

/** 错误码。 */
export type SessionQueryErrorCode = 'CURSOR_INVALID' | 'CURSOR_MISMATCH' | 'CONVERSATION_NOT_FOUND'

/** 查询服务的领域错误。 */
export class SessionQueryError extends Error {
  constructor(
    /** 机器可读的错误码。 */
    readonly code: SessionQueryErrorCode,
    /** 给人看的中文说明。 */
    message: string,
  ) {
    super(message)
    this.name = 'SessionQueryError'
  }
}
