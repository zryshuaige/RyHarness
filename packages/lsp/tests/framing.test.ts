/**
 * 帧协议：编码、分片解码、坏帧头的处理。
 *
 * 这一层最容易带病上线的地方有两个，都在这里钉住：
 * - 长度按**字节**算还是按**字符**算（正文里有中文时两者不一样）；
 * - 一个多字节字符被切在两次 `data` 事件之间时会不会解出乱码。
 */
import { describe, expect, it } from 'vitest'
import { encodeFrame, FRAME_HEADER_SEPARATOR, LspFrameDecoder, parseContentLength } from '../src/index.ts'

/** 把一帧拆成若干片，模拟分片到达。 */
function split(buffer: Buffer, sizes: number[]): Buffer[] {
  const pieces: Buffer[] = []
  let offset = 0
  for (const size of sizes) {
    pieces.push(buffer.subarray(offset, offset + size))
    offset += size
  }
  if (offset < buffer.length) pieces.push(buffer.subarray(offset))
  return pieces
}

describe('LSP 帧协议', () => {
  it('帧头里的长度是字节数，不是字符数', () => {
    const frame = encodeFrame({ text: '中文字' })

    const header = frame.subarray(0, frame.indexOf(FRAME_HEADER_SEPARATOR)).toString('ascii')
    const declared = Number.parseInt(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? '', 10)
    const body = frame.subarray(frame.indexOf(FRAME_HEADER_SEPARATOR) + FRAME_HEADER_SEPARATOR.length)

    // 正文是 3 个汉字 = 9 个字节，加上 JSON 里的引号与花括号。
    expect(declared).toBe(body.byteLength)
    expect(declared).not.toBe(JSON.stringify({ text: '中文字' }).length)
    expect(body.toString('utf8')).toBe(JSON.stringify({ text: '中文字' }))
  })

  it('编码出来的一帧能原样解回去', () => {
    const payload = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null } }
    const decoder = new LspFrameDecoder()

    const frames = decoder.push(encodeFrame(payload))

    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0])).toEqual(payload)
  })

  it('帧头被切成两半时也算不出一帧', () => {
    const frame = encodeFrame({ id: 7 })
    const decoder = new LspFrameDecoder()
    const [head, rest] = split(frame, [6])

    expect(decoder.push(head)).toEqual([])

    const second = decoder.push(rest)
    expect(second).toHaveLength(1)
    expect(JSON.parse(second[0])).toEqual({ id: 7 })
  })

  it('正文被切成两半时也能拼回来', () => {
    const frame = encodeFrame({ id: 9, method: 'textDocument/hover' })
    const cut = frame.byteLength - 3
    const decoder = new LspFrameDecoder()

    expect(decoder.push(frame.subarray(0, cut))).toEqual([])
    const rest = decoder.push(frame.subarray(cut))

    expect(rest).toHaveLength(1)
    expect(JSON.parse(rest[0])).toEqual({ id: 9, method: 'textDocument/hover' })
  })

  it('一次收到两帧时两帧都吐出来', () => {
    const decoder = new LspFrameDecoder()
    const buffer = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 })])

    const frames = decoder.push(buffer)

    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0])).toEqual({ id: 1 })
    expect(JSON.parse(frames[1])).toEqual({ id: 2 })
  })

  it('汉字被切在两次事件之间时解出来仍然是完整的', () => {
    const payload = { text: '中文字符' }
    const frame = encodeFrame(payload)
    // 找一个落在汉字中间的字节位置：正文的第一个字节之后。
    const bodyStart = frame.indexOf(FRAME_HEADER_SEPARATOR) + FRAME_HEADER_SEPARATOR.length
    const decoder = new LspFrameDecoder()

    const first = decoder.push(frame.subarray(0, bodyStart + 2))
    expect(first).toEqual([])
    const rest = decoder.push(frame.subarray(bodyStart + 2))

    expect(rest).toHaveLength(1)
    expect(JSON.parse(rest[0])).toEqual(payload)
  })

  it('帧头名字大小写不敏感，多余的头被忽略', () => {
    const decoder = new LspFrameDecoder()
    const body = Buffer.from(JSON.stringify({ id: 3 }), 'utf8')
    const raw = Buffer.concat([
      Buffer.from(
        `content-length: ${body.byteLength}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
        'ascii',
      ),
      body,
    ])

    const frames = decoder.push(raw)

    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0])).toEqual({ id: 3 })
  })

  it('帧头里没有 Content-Length：报协议错误', () => {
    expect(() => parseContentLength('Content-Type: application/json')).toThrowError(/Content-Length/)
  })

  it('Content-Length 不是第一个头时也能读到', () => {
    expect(parseContentLength('Content-Type: application/json\r\nContent-Length: 42')).toBe(42)
  })

  it('没有冒号的行被忽略', () => {
    expect(parseContentLength('这不是头\r\nContent-Length: 7')).toBe(7)
  })

  it('帧头里的 Content-Length 不是数字：报协议错误', () => {
    expect(() => parseContentLength('Content-Length: not-a-number')).toThrowError(/不是合法长度/)
  })

  it('解帧时遇到坏帧头，整条连接判死', () => {
    const decoder = new LspFrameDecoder()

    expect(() => decoder.push(Buffer.from('Content-Length: abc\r\n\r\n{}', 'ascii'))).toThrowError(/不是合法长度/)
  })

  it('流结束时把没凑齐的残余交出来', () => {
    const decoder = new LspFrameDecoder()
    decoder.push(Buffer.from('Content-Length: 100\r\n\r\n{"id"', 'ascii'))

    const rest = decoder.flush()

    // 残余是「攒下来但还没凑成帧」的全部内容：头也在里面，因为它同样是半截的。
    expect(rest).toContain('Content-Length: 100')
    expect(rest).toContain('{"id"')
    expect(decoder.flush()).toBeUndefined()
  })
})
