/**
 * 有界输出缓冲：让「一个 `yes` 就能把内存吃穿」这件事不成立。
 *
 * 三条约束叠在一起：
 *
 * 1. **总量有界**。缓冲区最多留 `maxBytes` 字节，超了就丢最旧的。这条管的是
 *    「会话一直开着、输出一直涨」的情况。
 * 2. **单次读取有界**。一次 read 最多返回 `maxReadBytes` 字节。调用方拿到的是
 *    一段有上限的文本，不是「剩下的全部」。
 * 3. **截断要能说清**。每次 read 都报 `remainingBytes`（还剩多少没读）与
 *    `droppedBytes`（因为总量上限丢了多少）。不说清楚，调用方就会把截断过的
 *    输出当成完整的输出——这是最常见的误用。
 *
 * 数据结构用**分块数组**而不是一整根字符串：整体拼接每次追加都要复制一遍，
 * 输出多的时候是 O(n²)。分块追加是均摊 O(1)，读取时再拼。
 * @module @ryharness/terminal/buffer
 */

import type { TerminalReadResult, TerminalTruncationReason } from './types.ts'

/** UTF-8 字节长度。 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 按 UTF-8 字节切一段字符串出来，尽量不切坏多字节字符。
 *
 * 直接按字节下标切会把一个中文字切成两半，前半截变成乱码。所以这里退一步：
 * 最多切到 `maxBytes`，但如果那会切坏字符，就少切一个字符。
 * @param text - 源串。
 * @param maxBytes - 最多取多少字节。
 * @returns 切出来的片段与它实际占的字节数。
 */
function sliceByBytes(text: string, maxBytes: number): { readonly slice: string; readonly bytes: number } {
  if (byteLength(text) <= maxBytes) return { slice: text, bytes: byteLength(text) }
  let bytes = 0
  let end = 0
  // 按码点走：一次多取一个 UTF-16 码元，低位代理项单独跳过。
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return { slice: text.slice(0, end), bytes }
}

/** 缓冲的构造参数。 */
export interface TerminalBufferOptions {
  /** 缓冲区最多保留多少字节；超了丢最旧的。 */
  readonly maxBytes?: number
  /** 单次 read 最多返回多少字节。 */
  readonly maxReadBytes?: number
}

/** 输出缓冲的默认上限（256 KiB）。 */
export const DEFAULT_BUFFER_MAX_BYTES = 256 * 1024

/** 单次读取的默认上限（64 KiB）。 */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024

/**
 * 有界输出缓冲。
 *
 * 用法是「谁在写、谁在读」：shell 的 stdout/stderr 往 {@link push} 里写，
 * 调用方用 {@link read} 取增量。
 */
export class TerminalBuffer {
  /** 保留的分块，按写入顺序。 */
  private readonly chunks: string[] = []
  /** 当前保留的总字节数。 */
  private retained = 0
  /** 因为超出总量上限而被丢掉的字节数（累计）。 */
  private dropped = 0
  /** 总量上限。 */
  private readonly maxBytes: number
  /** 单次读取上限。 */
  private readonly maxReadBytes: number

  constructor(options: TerminalBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES
  }

  /** 当前保留的字节数。 */
  get retainedBytes(): number {
    return this.retained
  }

  /** 累计被丢弃的字节数。 */
  get droppedBytes(): number {
    return this.dropped
  }

  /** 单次读取的上限。 */
  get readLimitBytes(): number {
    return this.maxReadBytes
  }

  /**
   * 追加一段输出。
   *
   * 总量超了上限时丢最旧的——留着最新的，因为最近的输出才是调用方现在要的。
   */
  push(text: string): void {
    if (text.length === 0) return
    this.chunks.push(text)
    this.retained += byteLength(text)
    this.trim()
  }

  /**
   * 读一段增量输出。
   *
   * @param maxBytes - 本次的字节上限；不给就用构造时定的那个。
   * @returns 读取结果，含截断标记与剩余字节数。
   */
  read(maxBytes?: number): TerminalReadResult {
    const limit = Math.min(maxBytes ?? this.maxReadBytes, this.maxReadBytes)
    const parts: string[] = []
    let bytes = 0
    let truncated = false
    let reason: TerminalTruncationReason | undefined

    while (this.chunks.length > 0) {
      const head = this.chunks[0] as string
      const headBytes = byteLength(head)
      const room = limit - bytes
      if (room <= 0) {
        truncated = true
        reason = 'limit'
        break
      }
      if (headBytes <= room) {
        parts.push(head)
        bytes += headBytes
        this.chunks.shift()
        continue
      }
      // 这一块比剩下的额度大：切一半出去，剩下的留在缓冲里等下次读。
      const cut = sliceByBytes(head, room)
      if (cut.slice.length === 0) {
        // 一个字符都放不下（额度比一个字符还小）：这次就到此为止，
        // 免得陷入「切不出东西又没进展」的死循环。
        truncated = true
        reason = 'limit'
        break
      }
      parts.push(cut.slice)
      bytes += cut.bytes
      this.chunks[0] = head.slice(cut.slice.length)
      truncated = true
      reason = 'limit'
      break
    }

    this.retained -= bytes
    return {
      text: parts.join(''),
      bytes,
      truncated,
      ...(reason === undefined ? {} : { truncationReason: reason }),
      remainingBytes: this.retained,
      droppedBytes: this.dropped,
    }
  }

  /**
   * 清空缓冲（会话关闭时用）。
   *
   * 丢弃的字节要计入 {@link droppedBytes}——它确实没了，账得算清。
   */
  clear(): void {
    this.dropped += this.retained
    this.chunks.length = 0
    this.retained = 0
  }

  /** 总量超上限时丢最旧的分块。 */
  private trim(): void {
    while (this.retained > this.maxBytes && this.chunks.length > 1) {
      const oldest = this.chunks[0] as string
      const oldestBytes = byteLength(oldest)
      if (this.retained - oldestBytes >= this.maxBytes) {
        this.chunks.shift()
        this.retained -= oldestBytes
        this.dropped += oldestBytes
        continue
      }
      // 丢掉最旧的这块会腾得太多，那就只丢掉它的一部分。
      const excess = this.retained - this.maxBytes
      const cut = sliceByBytes(oldest, Math.min(oldestBytes, excess))
      if (cut.slice.length === 0) break
      this.chunks[0] = oldest.slice(cut.slice.length)
      this.retained -= cut.bytes
      this.dropped += cut.bytes
      break
    }
  }
}
