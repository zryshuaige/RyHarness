/**
 * 凭据引用与授权流程的类型。
 *
 * 核心那条规矩：**配置里不存明文，只存引用**。所以 {@link CredentialRef} 里没有密钥
 * 本身，只有「这是谁家的、叫什么、末四位是什么」——够界面显示，不够泄露。
 *
 * 真要拿密钥，得走 {@link CredentialUseRequest}：说清要干什么，宿主找人点头，批了才
 * 拿得到。批的范围有「这一次」与「一段时间内都批」两种，后者记到期时间，过期要重批。
 * @module @ryharness/credentials/types
 */

/** 一个凭据的**引用**（不含密钥本身）。 */
export interface CredentialRef {
  /** 引用 id：配置里存的就是它。 */
  readonly id: string
  /** 这是谁家的凭据（供应商 id）。 */
  readonly providerId: string
  /** 给人看的名字。 */
  readonly label: string
  /** 末四位之类的提示；有它界面才能「你填的是不是同一个」。 */
  readonly hint?: string
  /** 登记时间（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 登记一个凭据引用时给的东西。 */
export interface CredentialRegistration {
  /** 这是谁家的凭据。 */
  readonly providerId: string
  /** 给人看的名字。 */
  readonly label: string
  /** 末四位之类的提示。 */
  readonly hint?: string
  /** 自己定引用 id（不给就由注册表生成）。 */
  readonly id?: string
  /** 登记时间（不给就用当前时间）。 */
  readonly createdAt?: number
}

/** 一次取用请求。 */
export interface CredentialUseRequest {
  /** 要用哪个引用。 */
  readonly credentialId: string
  /** 要干什么——**给人看的**，审批弹窗上展示的就是这句。 */
  readonly purpose: string
  /** 谁要（插件 id、助理 id…）；审计要记。 */
  readonly requester?: string
}

/** 授权的范围：这一次，还是一段时间内都批。 */
export type ApprovalScope = 'once' | 'until'

/** 审批的结果。 */
export interface ApprovalDecision {
  /** 批了没有。 */
  readonly approved: boolean
  /** 批的范围；缺省当「这一次」。 */
  readonly scope?: ApprovalScope
  /** `scope: 'until'` 时的到期时间（毫秒时间戳）；过期要再批。 */
  readonly expiresAt?: number
  /** 不批的理由（写进审计与日志）。 */
  readonly reason?: string
}

/** 递给审批人的那一份请求。 */
export interface ApprovalRequest {
  /** 要用哪个引用。 */
  readonly credentialId: string
  /** 这是谁家的。 */
  readonly providerId: string
  /** 给人看的名字。 */
  readonly label: string
  /** 末四位之类的提示。 */
  readonly hint?: string
  /** 要干什么。 */
  readonly purpose: string
  /** 谁要。 */
  readonly requester: string
  /** 发起时间（毫秒时间戳）。 */
  readonly requestedAt: number
}

/** 审批函数：宿主给，问人要不要批。 */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>

/**
 * 取密钥的函数：宿主给。
 *
 * **密钥本身归宿主管**——桌面端用系统密钥库加密存着，本包不碰落盘、也不知道密钥长
 * 什么样。这里只把「哪个引用」递过去。
 */
export type ResolveSecret = (ref: CredentialRef) => string | Promise<string>

/** 一次取用的审计记录。 */
export interface CredentialAuditEntry {
  /** 记录 id。 */
  readonly id: string
  /** 用的是哪个引用。 */
  readonly credentialId: string
  /** 谁要。 */
  readonly requester: string
  /** 为了什么。 */
  readonly purpose: string
  /** 什么时候（毫秒时间戳）。 */
  readonly at: number
  /** 批了没有。 */
  readonly approved: boolean
  /** 结果：拿到了 / 没批 / 出错了。 */
  readonly outcome: 'granted' | 'denied' | 'failed'
  /** 批的范围。 */
  readonly scope?: ApprovalScope
  /** 有效期到什么时候。 */
  readonly expiresAt?: number
  /** 没批或出错的理由。 */
  readonly reason?: string
}
