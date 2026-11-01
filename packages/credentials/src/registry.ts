/**
 * 凭据注册表：登记引用、吊销引用，以及**要人点头**的取用流程。
 *
 * 上游 dsh 把这一族拆成三个包：`credentials/` 存与取、`credentials-local/` 放本机
 * 私有存储、`authorization/` 管要人点头的流程。我们把后两件事收进一个包，但**不碰
 * 密钥落盘**——密钥归宿主那个加密存储管（桌面端走系统密钥库），本包只管「引用」与
 * 「授权」。
 *
 * 取用要走完这几步，一步都不能省：
 *
 * 1. 引用得存在，也没被吊销；
 * 2. **人要点头**：宿主给的 `requestApproval` 批了才往下走；没批、审批抛错、等超时，
 *    都如实失败（最坏的是假装成功——调用方以为拿到密钥了，实际拿到空串）；
 * 3. 批的范围：「这一次」还是「一段时间内都批」。后者记到期时间，过期要重批；
 * 4. 留一条审计：谁、什么时候、为了什么、批没批。
 *
 * 密钥本身由宿主用自己的解码器取（`resolveSecret`）：本包不知道密钥长什么样，也
 * 不写盘。
 * @module @ryharness/credentials/registry
 */

import { randomUUID } from 'node:crypto'
import { CredentialError, describeError } from './errors.ts'
import type { CredentialSnapshot, CredentialStore } from './store.ts'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalScope,
  CredentialAuditEntry,
  CredentialRef,
  CredentialRegistration,
  CredentialUseRequest,
  RequestApproval,
  ResolveSecret,
} from './types.ts'

/** 注册表的构造参数。 */
export interface CredentialRegistryOptions {
  /** 要人点头的审批函数（宿主给）。 */
  readonly requestApproval: RequestApproval
  /** 用宿主自己的加密存储取真正的密钥（宿主给）。 */
  readonly resolveSecret: ResolveSecret
  /** 引用的落盘（存的是引用，不是密钥）；不给就不落盘。 */
  readonly store?: CredentialStore
  /** 等人点头等多久算超时（毫秒）；不给或 0 = 不限时。 */
  readonly approvalTimeoutMs?: number
  /** 时钟（毫秒时间戳）。 */
  readonly now?: () => number
  /** 引用 id 的生成方式。 */
  readonly newId?: () => string
}

/** 注册表内部记的一条引用。 */
interface CredentialRecord {
  readonly ref: CredentialRef
  revoked: boolean
}

/** 一段时间内有效的授权。 */
interface Grant {
  readonly expiresAt: number
}

/** 审批的结果包一层：好让超时与出错都能走同一条路。 */
type Settled =
  | { readonly kind: 'decision'; readonly decision: ApprovalDecision }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' }

/** 登记时**不许出现**的字段名：这些是密钥该待的地方，不是引用该有的。 */
const SECRET_FIELD_NAMES = ['secret', 'value', 'apiKey', 'api_key', 'token', 'password', 'key'] as const

/** 凭据注册表。 */
export class CredentialRegistry {
  private readonly records = new Map<string, CredentialRecord>()
  /** 一段时间内有效的授权：引用 id → 到期时间。 */
  private readonly grants = new Map<string, Grant>()
  private readonly audits: CredentialAuditEntry[] = []
  private readonly options: CredentialRegistryOptions
  private auditSeq = 0

  constructor(options: CredentialRegistryOptions) {
    this.options = options
    if (options.store !== undefined) {
      for (const snapshot of options.store.load()) {
        this.records.set(snapshot.ref.id, { ref: snapshot.ref, revoked: snapshot.revoked })
      }
    }
  }

  /**
   * 登记一个凭据**引用**。
   *
   * 这里没有地方能塞密钥：类型上就没有，真传进来了也会被挡下并报错——引用里出现明文
   * 密钥，就等于把「配置不存明文」这条规矩废了。
   * @param input - 要登记的东西。
   * @returns 登记好的引用。
   * @throws CredentialError - 缺供应商或名字（`INVALID_REGISTRATION`）、带密钥
   *   （`SECRET_IN_REGISTRATION`）、id 重复（`DUPLICATE_ID`）。
   */
  register(input: CredentialRegistration): CredentialRef {
    if (input.providerId.trim().length === 0) {
      throw new CredentialError('INVALID_REGISTRATION', '凭据引用要写清是哪家的（providerId）')
    }
    if (input.label.trim().length === 0) {
      throw new CredentialError('INVALID_REGISTRATION', '凭据引用要有个名字（label）')
    }
    assertNoSecret(input)
    const id = input.id ?? this.newId()
    if (this.records.has(id)) {
      throw new CredentialError('DUPLICATE_ID', `已经有这个凭据引用了：${id}`, id)
    }
    const ref: CredentialRef = {
      id,
      providerId: input.providerId,
      label: input.label,
      ...(input.hint === undefined ? {} : { hint: input.hint }),
      createdAt: input.createdAt ?? this.now(),
    }
    this.records.set(id, { ref, revoked: false })
    this.persist()
    return { ...ref }
  }

  /**
   * 列出凭据引用。
   * @param options - `includeRevoked` 为真时把吊销过的也算进来。
   * @returns 引用清单（**不含密钥**）。
   */
  list(options: { includeRevoked?: boolean } = {}): CredentialRef[] {
    const out: CredentialRef[] = []
    for (const record of this.records.values()) {
      if (record.revoked && options.includeRevoked !== true) continue
      out.push({ ...record.ref })
    }
    return out
  }

  /**
   * 取一个引用。
   * @param id - 引用 id。
   * @returns 引用；没有就是 undefined。
   */
  get(id: string): CredentialRef | undefined {
    const record = this.records.get(id)
    if (record === undefined) return undefined
    return { ...record.ref }
  }

  /**
   * 吊销一个引用：之后用它取号会被挡下。
   * @param id - 引用 id。
   * @returns 之前登记过就返回 true。
   */
  revoke(id: string): boolean {
    const record = this.records.get(id)
    if (record === undefined) return false
    record.revoked = true
    // 吊销了，之前批的那段时间内授权也不再算数。
    this.grants.delete(id)
    this.persist()
    return true
  }

  /**
   * 取密钥：走完授权流程才拿得到。
   *
   * 授权在有效期内（批的是「一段时间内都批」）时不再问人；过期了就再批一次。
   * @param request - 要用哪个引用、为了什么、谁要。
   * @returns 真正的密钥。
   * @throws CredentialError - 引用不存在（`UNKNOWN_CREDENTIAL`）、已吊销（`REVOKED`）、
   *   没批（`DENIED`）、审批出错（`APPROVAL_FAILED`）、等超时（`APPROVAL_TIMEOUT`）、
   *   密钥取不到（`SECRET_UNAVAILABLE`）。
   */
  async use(request: CredentialUseRequest): Promise<string> {
    const record = this.records.get(request.credentialId)
    if (record === undefined) {
      throw new CredentialError('UNKNOWN_CREDENTIAL', `没有这个凭据引用：${request.credentialId}`, request.credentialId)
    }
    if (record.revoked) {
      throw new CredentialError('REVOKED', `凭据 "${record.ref.label}" 已经吊销了`, record.ref.id)
    }
    const requester = request.requester ?? 'unknown'
    const grant = this.grants.get(record.ref.id)
    if (grant !== undefined) {
      if (grant.expiresAt > this.now()) {
        return await this.grantSecret(record.ref, requester, request.purpose, {
          approved: true,
          scope: 'until',
          expiresAt: grant.expiresAt,
        })
      }
      // 过期了：要再批一次。
      this.grants.delete(record.ref.id)
    }
    const asked = await this.ask(record.ref, request)
    if (!asked.ok) {
      this.record({
        credentialId: record.ref.id,
        requester,
        purpose: request.purpose,
        approved: false,
        outcome: 'failed',
        reason: asked.error.message,
      })
      throw asked.error
    }
    const decision = asked.decision
    if (!decision.approved) {
      this.record({
        credentialId: record.ref.id,
        requester,
        purpose: request.purpose,
        approved: false,
        outcome: 'denied',
        reason: decision.reason ?? '没有拿到授权',
      })
      throw new CredentialError('DENIED', decision.reason ?? `没有人批准这次取用（${request.purpose}）`, record.ref.id)
    }
    const scope: ApprovalScope = decision.scope ?? 'once'
    const expiresAt = decision.expiresAt
    if (scope === 'until' && typeof expiresAt === 'number' && expiresAt > this.now()) {
      this.grants.set(record.ref.id, { expiresAt })
    }
    return await this.grantSecret(record.ref, requester, request.purpose, {
      approved: true,
      scope,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
  }

  /** 全部审计记录（按时间先后）。 */
  audit(): readonly CredentialAuditEntry[] {
    return this.audits.map((entry) => {
      return { ...entry }
    })
  }

  /**
   * 某个引用的审计记录。
   * @param credentialId - 引用 id。
   * @returns 审计记录。
   */
  auditFor(credentialId: string): readonly CredentialAuditEntry[] {
    return this.audit().filter((entry) => {
      return entry.credentialId === credentialId
    })
  }

  /**
   * 问人要不要批。
   *
   * 不抛错，而是把结果分成两种：批了（`ok: true`），或者没批成（`ok: false`，带上
   * 原因）。这样「审批出错」与「审批超时」都能如实变成一个具体的错误，而不是混在
   * 一起变成一句说不清的失败。
   */
  private async ask(
    ref: CredentialRef,
    request: CredentialUseRequest,
  ): Promise<{ ok: true; decision: ApprovalDecision } | { ok: false; error: CredentialError }> {
    const approval: ApprovalRequest = {
      credentialId: ref.id,
      providerId: ref.providerId,
      label: ref.label,
      ...(ref.hint === undefined ? {} : { hint: ref.hint }),
      purpose: request.purpose,
      requester: request.requester ?? 'unknown',
      requestedAt: this.now(),
    }
    const timeoutMs = this.options.approvalTimeoutMs ?? 0
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const races: Promise<Settled>[] = [settle(this.options.requestApproval(approval))]
      if (timeoutMs > 0) {
        races.push(
          new Promise<Settled>((resolve) => {
            timer = setTimeout(() => {
              resolve({ kind: 'timeout' })
            }, timeoutMs)
          }),
        )
      }
      const settled = await Promise.race(races)
      if (settled.kind === 'timeout') {
        return {
          ok: false,
          error: new CredentialError('APPROVAL_TIMEOUT', `等人点头等了 ${timeoutMs} 毫秒还没等到`, ref.id),
        }
      }
      if (settled.kind === 'error') {
        return {
          ok: false,
          error: new CredentialError('APPROVAL_FAILED', `审批没走完：${describeError(settled.error)}`, ref.id),
        }
      }
      return { ok: true, decision: settled.decision }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 授权过了，去把真密钥取回来，并留审计。 */
  private async grantSecret(
    ref: CredentialRef,
    requester: string,
    purpose: string,
    decision: { approved: boolean; scope: ApprovalScope; expiresAt?: number },
  ): Promise<string> {
    let secret: string
    try {
      secret = await this.options.resolveSecret(ref)
    } catch (error) {
      this.record({
        credentialId: ref.id,
        requester,
        purpose,
        approved: decision.approved,
        outcome: 'failed',
        scope: decision.scope,
        ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        reason: `取不到密钥：${describeError(error)}`,
      })
      throw new CredentialError('SECRET_UNAVAILABLE', `取不到密钥：${describeError(error)}`, ref.id)
    }
    if (secret.length === 0) {
      this.record({
        credentialId: ref.id,
        requester,
        purpose,
        approved: decision.approved,
        outcome: 'failed',
        scope: decision.scope,
        ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        reason: '取到的密钥是空的',
      })
      throw new CredentialError('SECRET_UNAVAILABLE', '取到的密钥是空的', ref.id)
    }
    this.record({
      credentialId: ref.id,
      requester,
      purpose,
      approved: decision.approved,
      outcome: 'granted',
      scope: decision.scope,
      ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
    })
    return secret
  }

  /** 记一条审计。 */
  private record(entry: {
    credentialId: string
    requester: string
    purpose: string
    approved: boolean
    outcome: CredentialAuditEntry['outcome']
    scope?: ApprovalScope
    expiresAt?: number
    reason?: string
  }): void {
    this.auditSeq += 1
    this.audits.push({
      id: `audit-${this.auditSeq}`,
      credentialId: entry.credentialId,
      requester: entry.requester,
      purpose: entry.purpose,
      at: this.now(),
      approved: entry.approved,
      outcome: entry.outcome,
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })
  }

  /** 把全部引用落盘。 */
  private persist(): void {
    const store = this.options.store
    if (store === undefined) return
    const snapshots: CredentialSnapshot[] = []
    for (const record of this.records.values()) {
      snapshots.push({ ref: { ...record.ref }, revoked: record.revoked })
    }
    store.save(snapshots)
  }

  /** 当前时间。 */
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 新引用 id。 */
  private newId(): string {
    return this.options.newId?.() ?? `cred-${randomUUID().slice(0, 8)}`
  }
}

/** 把审批 promise 包一层：出错也变成一种结果，而不是没人接的 rejection。 */
function settle(approval: Promise<ApprovalDecision>): Promise<Settled> {
  return approval.then(
    (decision) => {
      return { kind: 'decision', decision }
    },
    (error: unknown) => {
      return { kind: 'error', error }
    },
  )
}

/** 登记时检查有没有把密钥塞进来。 */
function assertNoSecret(input: CredentialRegistration): void {
  for (const name of SECRET_FIELD_NAMES) {
    if (name in input) {
      throw new CredentialError(
        'SECRET_IN_REGISTRATION',
        `凭据引用里不许放密钥（${name}）：引用只写名字，密钥由宿主的加密存储管`,
      )
    }
  }
}
