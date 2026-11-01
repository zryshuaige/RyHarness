/**
 * 有界输出缓冲的单元测试。
 *
 * 这些用例盯的是**行为**不是行数：截断时剩下的字节数对不对、总量上限有没有真的
 * 生效、多字节字符会不会被切坏——这三条错了，上层读到的输出就是错的。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_BUFFER_MAX_BYTES, TerminalBuffer } from '../src/index.ts'

describe('有界输出缓冲', () => {
  it('读出来的是写进去的文本', () => {
    const buffer = new TerminalBuffer()
    buffer.push('hello ')
    buffer.push('world')
    const result = buffer.read()
    expect(result.text).toBe('hello world')
    expect(result.bytes).toBe(11)
    expect(result.truncated).toBe(false)
    expect(result.remainingBytes).toBe(0)
  })

  it('读是增量的：读过的不会再读到', () => {
    const buffer = new TerminalBuffer()
    buffer.push('first')
    expect(buffer.read().text).toBe('first')
    buffer.push('second')
    expect(buffer.read().text).toBe('second')
  })

  it('单次读取有上限，超出部分留在缓冲里并报剩余字节数', () => {
    const buffer = new TerminalBuffer({ maxReadBytes: 100 })
    buffer.push('0123456789')
    const result = buffer.read(4)
    expect(result.text).toBe('0123')
    expect(result.bytes).toBe(4)
    expect(result.truncated).toBe(true)
    expect(result.truncationReason).toBe('limit')
    expect(result.remainingBytes).toBe(6)
  })

  it('总量超上限时丢最旧的，并累计丢掉多少字节', () => {
    const buffer = new TerminalBuffer({ maxBytes: 10, maxReadBytes: 100 })
    buffer.push('aaaa')
    buffer.push('bbbb')
    buffer.push('cccc')
    // 保留上限 10 字节：'aaaa' + 'bbbb' 刚好 8，再加 'cccc' 就超了。
    expect(buffer.retainedBytes).toBe(10)
    expect(buffer.droppedBytes).toBe(2)
    const result = buffer.read()
    expect(result.text).toBe('aabbbbcccc')
    expect(result.droppedBytes).toBe(2)
  })

  it('单次读取上限不超过构造时定的那个（不能被调用方放大）', () => {
    const buffer = new TerminalBuffer({ maxReadBytes: 4 })
    buffer.push('0123456789')
    const result = buffer.read(1000)
    expect(result.bytes).toBe(4)
    expect(result.truncated).toBe(true)
  })

  it('多字节字符不会被切坏', () => {
    const buffer = new TerminalBuffer({ maxReadBytes: 100 })
    buffer.push('中文测试')
    // 汉字在 UTF-8 里是 3 字节：切在第 5 个字节上会切坏「文」。
    const result = buffer.read(5)
    expect(result.text).toBe('中')
    expect(result.bytes).toBe(3)
    expect(result.truncated).toBe(true)
    // 剩下 9 字节（文 + 测 + 试），一个字都没坏。
    expect(result.remainingBytes).toBe(9)
    expect(buffer.read(100).text).toBe('文测试')
  })

  it('清空时把丢掉的字节也算进账里', () => {
    const buffer = new TerminalBuffer()
    buffer.push('some output')
    buffer.clear()
    expect(buffer.retainedBytes).toBe(0)
    expect(buffer.droppedBytes).toBe(11)
  })

  it('默认上限是 256 KiB 量级，不至于把内存吃穿', () => {
    expect(DEFAULT_BUFFER_MAX_BYTES).toBe(256 * 1024)
    const buffer = new TerminalBuffer()
    expect(buffer.readLimitBytes).toBe(64 * 1024)
  })
})
