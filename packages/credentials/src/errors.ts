/**
 * 凭据流程的领域错误。
 *
 * 每一种失败都要**如实失败**：没批就是没批，审批抛错就是审批抛错，超时就是超时。
 * 最坏的一种是「假装成功」——调用方以为拿到密钥了，实际拿到一个空串，于是请求发出去
 * 被服务端拒了，而日志里看不出是哪一步出的问题。
 *
 * 所以这里的每条错误都带一个机器可读的 `code`，界面与日志按它分支。
 * @module @ryharness/credentials/errors
 */

/** 凭据流程的错误种类。 */
export type CredentialErrorCode =
  /** 没有这个引用。 */
  | 'UNKNOWN_CREDENTIAL'
  /** 引用已经吊销。 */
  | 'REVOKED'
  /** 引用 id 重复。 */
  | 'DUPLICATE_ID'
  /** 登记的东西不合法（缺供应商或名字）。 */
  | 'INVALID_REGISTRATION'
  /** 登记时试图把密钥本身塞进来——不行，引用里不放密钥。 */
  | 'SECRET_IN_REGISTRATION'
  /** 人没点头。 */
  | 'DENIED'
  /** 审批过程本身出错了。 */
  | 'APPROVAL_FAILED'
  /** 等人点头等超时了。 */
  | 'APPROVAL_TIMEOUT'
  /** 批了，但密钥取不到（空串或宿主那边报错）。 */
  | 'SECRET_UNAVAILABLE'

/** 凭据流程的错误。 */
export class CredentialError extends Error {
  /**
   * @param code - 错误种类。
   * @param message - 一句能直接给人看的中文。
   * @param credentialId - 出事的是哪个引用（知道的话）。
   */
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
    readonly credentialId?: string,
  ) {
    super(message)
    this.name = 'CredentialError'
  }
}

/** 异常 → 一句可展示的原因。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
