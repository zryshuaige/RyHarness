/**
 * 附件存储的契约。
 *
 * 与 `@ryharness/attachment`（只有类型）分开：这个包是**真实现**，那边是给
 * `@ryharness/llm` 编译用的最小词汇表。
 * @module @ryharness/attachment-storage/types
 */

/** 一个附件的引用（存下来之后的样子）。 */
export interface AttachmentRef {
  /**
   * 内容寻址的 id：字节内容的 sha256（十六进制）。
   *
   * 同一份内容永远得到同一个 id——去重是免费的，而且天然不可变：内容变了 id 就变了，
   * 不存在「同一个 id 对应两份内容」的情况。
   */
  readonly attachmentId: string
  /** 字节长度。 */
  readonly bytes: number
  /** mime 类型（由调用方给，按字节 sniff 出来更可靠）。 */
  readonly mediaType: string
  /** 显示用的文件名（不含本地路径信息）。 */
  readonly name?: string
  /** 存下来的时刻（毫秒时间戳）。 */
  readonly createdAt: number
}

/** 存一个附件的入参。 */
export interface PutAttachmentInput {
  /** 字节内容。 */
  readonly data: Uint8Array
  /** mime 类型。 */
  readonly mediaType: string
  /** 显示用的文件名。 */
  readonly name?: string
  /** 单个附件的字节上限；超过就报错（别把磁盘写满）。 */
  readonly maxBytes?: number
}

/** 存储失败的原因码。 */
export type AttachmentErrorCode = 'invalid-id' | 'not-found' | 'too-large' | 'quota-exceeded' | 'io-failed' | 'mismatch'

/** 存储失败：带机器码与一句人话。 */
export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AttachmentError'
  }
}
