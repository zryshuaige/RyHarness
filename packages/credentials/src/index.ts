/**
 * 凭据引用与授权流程。
 *
 * 配置里**不存明文密钥，只存引用**。要拿密钥就走一条要人点头的流程：说清要干什么，
 * 人批了才拿得到；批「一段时间内都批」的记着到期时间，过期要重批；每一次取用都留
 * 一条审计（谁、什么时候、为了什么、批没批）。
 *
 * 本包**不碰密钥落盘**：密钥由宿主自己的加密存储管（桌面端走系统密钥库，见
 * `apps/server/src/config.ts` 那个 `SecretCodec`）。这里只管「引用」与「授权」，
 * 取密钥的回调也是宿主给的。
 * @module @ryharness/credentials
 */

export type { CredentialErrorCode } from './errors.ts'
export { CredentialError, describeError } from './errors.ts'
export { CredentialRegistry, type CredentialRegistryOptions } from './registry.ts'
export type { CredentialSnapshot, CredentialStore, FileCredentialStoreOptions } from './store.ts'
export { FileCredentialStore, MemoryCredentialStore } from './store.ts'
export type {
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
