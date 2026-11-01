/**
 * ZIP 格式与游标：两个小工具的细节。
 *
 * ZIP 是自己拼的，所以格式本身值得钉死几个数：CRC32 的已知值、空包的结构、
 * UTF-8 文件名。游标则是「翻页不许错位」的那一环，值得单独盯。
 */

import { describe, expect, it } from 'vitest'
import { crc32, createZip, decodeCursor, encodeCursor, filterFingerprint, SessionQueryError } from '../src/index.ts'

describe('ZIP 格式', () => {
  it('CRC32 用的是 IEEE 那套（已知校验值）', () => {
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcb_f4_39_26)
    expect(crc32(Buffer.from('', 'utf8'))).toBe(0)
  })

  it('空包只有中央目录结尾记录', () => {
    const zip = createZip([])
    expect(zip.length).toBe(22)
    expect(zip.readUInt32LE(0)).toBe(0x06_05_4b_50)
    expect(zip.readUInt16LE(8)).toBe(0)
  })

  it('文件头与中央目录都对得上', () => {
    const zip = createZip([{ path: 'a.txt', data: Buffer.from('hello', 'utf8') }])
    expect(zip.readUInt32LE(0)).toBe(0x04_03_4b_50)
    expect(zip.readUInt16LE(8)).toBe(8)
    expect(zip.readUInt16LE(26)).toBe(5)
    expect(zip.subarray(30, 35).toString('utf8')).toBe('a.txt')
  })

  it('中文文件名按 UTF-8 写，标志位也标上了', () => {
    const zip = createZip([{ path: '产物/导出.zip', data: Buffer.from('x', 'utf8') }])
    expect(zip.readUInt16LE(6) & 0x08_00).toBe(0x08_00)
    const nameLength = zip.readUInt16LE(26)
    expect(zip.subarray(30, 30 + nameLength).toString('utf8')).toBe('产物/导出.zip')
  })
})

describe('分页游标', () => {
  it('编出来的游标能原样解回来', () => {
    const fingerprint = filterFingerprint({ conversationId: 'c1' })
    const cursor = encodeCursor(42, fingerprint)
    expect(decodeCursor(cursor, fingerprint)).toBe(42)
  })

  it('指纹不同就报「换了条件」，不给另一组结果', () => {
    const cursor = encodeCursor(42, filterFingerprint({ conversationId: 'c1' }))
    const other = filterFingerprint({ conversationId: 'c2' })
    expect(() => {
      decodeCursor(cursor, other)
    }).toThrow(SessionQueryError)
    try {
      decodeCursor(cursor, other)
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CURSOR_MISMATCH')
    }
  })

  it('坏游标报「格式不对」', () => {
    try {
      decodeCursor('乱写的', filterFingerprint({}))
      throw new Error('不该走到这里')
    } catch (error) {
      expect(error instanceof SessionQueryError ? error.code : '').toBe('CURSOR_INVALID')
    }
  })

  it('同样的条件算出同一个指纹，不同条件算出不同的', () => {
    expect(filterFingerprint({ conversationId: 'c1', senderType: 'user' })).toBe(
      filterFingerprint({ conversationId: 'c1', senderType: 'user' }),
    )
    expect(filterFingerprint({ conversationId: 'c1' })).not.toBe(filterFingerprint({ conversationId: 'c2' }))
  })
})
