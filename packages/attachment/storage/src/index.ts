/**
 * 附件存储的入口。
 *
 * 三个东西：契约类型、存储实现、错误。
 * @module @ryharness/attachment-storage
 */

export type { AttachmentStoreOptions, AttachmentUsage } from './store.ts'
export { ContentAddressedAttachmentStore, DEFAULT_MAX_ATTACHMENT_BYTES, DEFAULT_QUOTA_BYTES } from './store.ts'
export type { AttachmentErrorCode, AttachmentRef, PutAttachmentInput } from './types.ts'
export { AttachmentError } from './types.ts'
