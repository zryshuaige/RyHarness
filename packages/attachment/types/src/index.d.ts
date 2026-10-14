/**
 * Minimal type-only attachment vocabulary stub.
 *
 * Upstream `@deepseek-ai/dsh-llm` imports attachment types (`import type` only)
 * for image/file content blocks. RyAgent's M1 kernel is text-only, so this
 * package provides just the structural types needed to compile `@ryagent/llm`;
 * a real attachment service can replace it later without touching the LLM seam.
 * @module @ryagent/attachment
 */
import { Service } from '@ryagent/cordis'
/** Opaque attachment identifier; never a filesystem path or bearer URL. */
export type AttachmentId = string & {
  readonly __brand: 'AttachmentId'
}
/** Opaque request-variant identifier for one normalized image rendition. */
export type ImageVariantId = string & {
  readonly __brand: 'ImageVariantId'
}
/** Raster image formats accepted by the attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
/** Durable, serializable reference to one immutable normalized image. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}
/** Durable, serializable reference to one verbatim stored file. */
export interface FileAttachmentRef {
  /** Opaque content-addressed storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Sanitized display filename, also the stored object's leaf name. */
  name: string
  /** Exact byte length. */
  bytes: number
}
/** Cached request version derived from one provider-independent normalized attachment. */
export interface RequestImageAttachment {
  /** Cache and upload-index key over the attachment id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable normalized attachment from which this request version was derived. */
  attachment: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}
/** Request to durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  mediaType: ImageMediaType
  name?: string
  maxBytes: number
}
/** One stored image and its metadata, as read back from the store. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
/**
 * Structural seam over durable attachment storage. The real upstream service
 * declares more methods; `@ryagent/llm` only ever touches `imageHostPath`.
 */
export declare abstract class AttachmentStore extends Service {
  /** Resolve the current host read path for one stored image, when available. */
  abstract imageHostPath(ref: ImageAttachmentRef): string | undefined
}
export default AttachmentStore
