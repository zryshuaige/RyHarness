/**
 * 内容寻址的附件存储。
 *
 * 三件事：
 * - **按内容寻址**：id 是字节的 sha256，同一份内容存两次只占一份空间。
 * - **不可变**：内容变了 id 就变了，所以一个 id 永远只对应一份字节。存同一个 id
 *   两次不会覆盖——真要覆盖就是另一份内容，那是另一个 id。
 * - **不泄露路径**：对外只有 id，磁盘布局是内部实现。
 *
 * 元数据（mime、文件名、时刻）放在旁边的 `.json` 边车文件里：内容文件保持原样，
 * 哈希出来的就是它自己的字节，不用为了算 id 去改内容。
 * @module @ryharness/attachment-storage/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AttachmentError, type AttachmentRef, type PutAttachmentInput } from './types.ts'

/** 单个附件的默认上限：8 MiB。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** 整个存储的默认配额：512 MiB。 */
export const DEFAULT_QUOTA_BYTES = 512 * 1024 * 1024
/** id 的形状：64 位十六进制（sha256）。 */
const ID_PATTERN = /^[0-9a-f]{64}$/u

/** 存储的构造参数。 */
export interface AttachmentStoreOptions {
  /** 存储根目录。 */
  readonly root: string
  /** 单个附件上限（字节）。 */
  readonly maxBytes?: number
  /** 总配额（字节）。 */
  readonly quotaBytes?: number
  /** 时钟（测试注入用）。 */
  readonly now?: () => number
}

/** 存储的统计。 */
export interface AttachmentUsage {
  /** 存了几个附件。 */
  readonly count: number
  /** 占了多少字节（按内容文件算，不含边车）。 */
  readonly bytes: number
}

/** 内容寻址的附件存储。 */
export class ContentAddressedAttachmentStore {
  private readonly root: string
  private readonly maxBytes: number
  private readonly quotaBytes: number
  private readonly now: () => number

  constructor(options: AttachmentStoreOptions) {
    this.root = resolve(options.root)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES
    this.now = options.now ?? Date.now
  }

  /**
   * 存储根目录。
   *
   * 宿主要用它把附件文件读出去（比如给界面下载），所以是公开的——但**对外的引用
   * 仍然只有 id**：这个路径是给宿主用的，不是给调用方用的。
   */
  get rootPath(): string {
    return this.root
  }

  /**
   * 存一个附件。
   *
   * 同一份内容存第二次：id 一样、文件已经在、**不重写**（重写会把引用计数与元数据
   * 搅在一起）。返回的是已有的那份引用。
   * @param input - 字节、mime 与文件名。
   * @returns 附件引用。
   */
  put(input: PutAttachmentInput): AttachmentRef {
    const data = input.data
    const limit = input.maxBytes ?? this.maxBytes
    if (data.length > limit) {
      throw new AttachmentError('too-large', `附件太大（${data.length} 字节，上限 ${limit} 字节）：先压缩或分批传。`)
    }
    const id = createHash('sha256').update(data).digest('hex')
    const existing = this.tryReadMeta(id)
    if (existing !== undefined) {
      const contentPath = this.contentPath(id)
      if (existsSync(contentPath)) return existing.ref
    }
    const usage = this.usage()
    // 已经存着同样的内容时不算新增占用。
    if (!existing) {
      if (usage.bytes + data.length > this.quotaBytes) {
        throw new AttachmentError(
          'quota-exceeded',
          `附件存储满了（已用 ${usage.bytes} 字节，配额 ${this.quotaBytes} 字节）：删掉几个旧附件再传。`,
        )
      }
    }
    const contentPath = this.contentPath(id)
    const metaPath = this.metaPath(id)
    try {
      mkdirSync(join(this.root, id.slice(0, 2), id.slice(2, 4)), { recursive: true })
      // 内容文件先写临时名再改名：写一半崩了不会留下一个「看起来存在、其实不完整」的文件。
      const temporary = `${contentPath}.tmp`
      writeFileSync(temporary, data)
      renameSync(temporary, contentPath)
    } catch (error) {
      throw new AttachmentError('io-failed', `附件写盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const ref: AttachmentRef = {
      attachmentId: id,
      bytes: data.length,
      mediaType: input.mediaType,
      ...(input.name === undefined ? {} : { name: input.name }),
      createdAt: this.now(),
    }
    try {
      writeFileSync(metaPath, JSON.stringify(ref), 'utf8')
    } catch (error) {
      throw new AttachmentError(
        'io-failed',
        `附件元数据写盘失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return ref
  }

  /**
   * 取一个附件的字节与引用。
   * @param attachmentId - 内容寻址的 id。
   * @returns 字节与引用。
   */
  get(attachmentId: string): { data: Uint8Array; ref: AttachmentRef } {
    const meta = this.tryReadMeta(attachmentId)
    if (meta === undefined) {
      throw new AttachmentError('not-found', `没有这个附件：${attachmentId}`)
    }
    const path = this.contentPath(attachmentId)
    if (!existsSync(path)) {
      throw new AttachmentError('not-found', `附件内容不见了：${attachmentId}`)
    }
    try {
      const bytes = readFileSync(path)
      // 哈希对不上说明内容被改过：内容寻址的存储里这不是「能读」，是「坏了」。
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== attachmentId) {
        throw new AttachmentError('mismatch', `附件内容对不上它的 id（存储被改坏了）：${attachmentId}`)
      }
      return { data: new Uint8Array(bytes), ref: meta.ref }
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('io-failed', `附件读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 这个 id 存过没有。 */
  has(attachmentId: string): boolean {
    return this.tryReadMeta(attachmentId) !== undefined
  }

  /** 列出全部附件（按存放顺序）。 */
  list(): AttachmentRef[] {
    const refs: AttachmentRef[] = []
    for (const id of this.ids()) {
      const meta = this.tryReadMeta(id)
      if (meta !== undefined) refs.push(meta.ref)
    }
    return refs
  }

  /**
   * 删一个附件。
   * @param attachmentId - 内容寻址的 id。
   * @returns 删掉了返回 true；本来就没有返回 false。
   */
  delete(attachmentId: string): boolean {
    this.assertId(attachmentId)
    const contentPath = this.contentPath(attachmentId)
    if (!existsSync(contentPath)) return false
    rmSync(contentPath, { force: true })
    rmSync(this.metaPath(attachmentId), { force: true })
    return true
  }

  /** 存储现在占了多少。 */
  usage(): AttachmentUsage {
    let count = 0
    let bytes = 0
    for (const id of this.ids()) {
      const path = this.contentPath(id)
      if (!existsSync(path)) continue
      count += 1
      bytes += statSync(path).size
    }
    return { count, bytes }
  }

  /** id 合不合法（只认 64 位十六进制，别让路径从外面漏进来）。 */
  private assertId(attachmentId: string): void {
    if (!ID_PATTERN.test(attachmentId)) {
      throw new AttachmentError('invalid-id', `附件 id 不合法：${attachmentId}`)
    }
  }

  /** 读边车元数据；没有就是 undefined（不是错误）。 */
  private tryReadMeta(attachmentId: string): { ref: AttachmentRef } | undefined {
    this.assertId(attachmentId)
    const path = this.metaPath(attachmentId)
    if (!existsSync(path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const record = parsed as Record<string, unknown>
      const id = record.attachmentId
      const bytes = record.bytes
      const mediaType = record.mediaType
      const createdAt = record.createdAt
      if (typeof id !== 'string' || typeof bytes !== 'number' || typeof mediaType !== 'string') return undefined
      if (typeof createdAt !== 'number') return undefined
      const name = record.name
      return {
        ref: {
          attachmentId: id,
          bytes,
          mediaType,
          ...(typeof name === 'string' ? { name } : {}),
          createdAt,
        },
      }
    } catch {
      return undefined
    }
  }

  /** 全部已存的 id（从边车文件反查，不扫内容文件——内容文件可能没有边车）。 */
  private ids(): string[] {
    const ids: string[] = []
    const walk = (directory: string, depth: number): void => {
      if (depth > 2) return
      let entries: string[]
      try {
        entries = readdirSync(directory)
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(directory, entry)
        let isDirectory = false
        try {
          isDirectory = statSync(path).isDirectory()
        } catch {
          continue
        }
        if (isDirectory) {
          walk(path, depth + 1)
          continue
        }
        if (!entry.endsWith('.json')) continue
        const id = entry.slice(0, -'.json'.length)
        if (ID_PATTERN.test(id)) ids.push(id)
      }
    }
    walk(this.root, 0)
    return ids
  }

  /** 内容文件的绝对路径。 */
  private contentPath(attachmentId: string): string {
    this.assertId(attachmentId)
    return join(this.root, attachmentId.slice(0, 2), attachmentId.slice(2, 4), attachmentId)
  }

  /** 边车元数据文件的绝对路径。 */
  private metaPath(attachmentId: string): string {
    this.assertId(attachmentId)
    return join(this.root, attachmentId.slice(0, 2), attachmentId.slice(2, 4), `${attachmentId}.json`)
  }
}
