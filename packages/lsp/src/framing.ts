/**
 * LSP 的帧协议：`Content-Length: N\r\n\r\n` 后面跟着正好 N **字节**的 JSON。
 *
 * 为什么自己写而不用现成的库：这条协议本身只有几十行，而引一个依赖意味着这个包
 * 从此有了一个要跟着升级、要审 CVE、要在别人 clone 下来时能装上的东西。为了几十行
 * 协议背这个包袱不值当。更重要的是自己写能把两件事做对：
 *
 * 1. **长度是字节数不是字符数**。JSON 里只要有一个中文，`body.length` 与
 *    `Buffer.byteLength` 就不一样——按字符数写头，服务器就会在半个字上错位，
 *    然后所有后续消息全部解析失败。这类 bug 极难从现象反推原因。
 * 2. **分片到达**。一次 `data` 事件不等于一帧：头可能断在中间，body 也可能只到一半。
 *    所以解码器是有状态的，喂进去多少字节就吐出多少帧。
 *
 * 协议细节见 https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#baseProtocol
 * @module @ryharness/lsp/framing
 */

import { LspError } from './errors.ts'

/** 帧头与帧体之间的分隔（协议规定用 CRLF CRLF）。 */
export const FRAME_HEADER_SEPARATOR = '\r\n\r\n'

/**
 * 把一条消息编码成一帧。
 *
 * 长度按 **UTF-8 字节数** 算——这是这条协议最容易写错的一处。
 * @param payload - 要编码的对象（会被 JSON 序列化）。
 * @returns 可以直接写进 stdin 的字节。
 */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.byteLength}${FRAME_HEADER_SEPARATOR}`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * 从帧头里读出 Content-Length。
 *
 * 头是 `Key: Value` 一行一行拼起来的，`Content-Length` 必须有（协议要求），
 * 其它头（`Content-Type` 之类）忽略。
 * @param headerText - 帧头文本（不含分隔符）。
 * @returns 正文长度（字节）。
 */
export function parseContentLength(headerText: string): number {
  for (const line of headerText.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    // 头名大小写不敏感（协议按 HTTP 的习惯来）。
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') continue
    const raw = line.slice(separator + 1).trim()
    const length = Number.parseInt(raw, 10)
    if (!Number.isInteger(length) || length < 0) {
      throw new LspError('protocol-error', `帧头里的 Content-Length 不是合法长度：${raw}`)
    }
    return length
  }
  throw new LspError('protocol-error', '帧头里没有 Content-Length，这不是一个合法的 LSP 帧')
}

/**
 * 分片解码器：喂进字节，吐出这次凑齐的完整帧正文。
 *
 * 状态留在内部缓冲区里，所以「头到一半」「正文到一半」「一帧里塞了两帧」这些真会
 * 遇到的情况都能正确处理。
 */
export class LspFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * 喂进一段字节。
   * @param chunk - 这次收到的字节。
   * @returns 这次凑齐的帧正文（UTF-8 文本），可能一个都没有。
   */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const messages: string[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(FRAME_HEADER_SEPARATOR)
      if (headerEnd < 0) break
      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = parseContentLength(headerText)
      const bodyStart = headerEnd + FRAME_HEADER_SEPARATOR.length
      if (this.buffer.byteLength < bodyStart + length) break
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      messages.push(body)
    }
    return messages
  }

  /**
   * 流结束时把没凑齐的残余交出来。
   *
   * 这不是「补齐」——半帧就是坏帧。它的用处是**取证**：进程半路死掉时，
   * 这是唯一能说清「它最后说了半句话」的东西。
   * @returns 残余文本；没有残余就是 undefined。
   */
  flush(): string | undefined {
    if (this.buffer.byteLength === 0) return undefined
    const rest = this.buffer.toString('utf8')
    this.buffer = Buffer.alloc(0)
    return rest
  }
}
