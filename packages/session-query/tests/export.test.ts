/**
 * 会话导出：包里有什么、能不能解开。
 *
 * 解压这件事用一个**自己写的读法**验（读中央目录 + raw inflate + 校验 CRC32），
 * 不用外部解压工具：那样才能证明格式是自己写对的，而不是恰好被某个库容忍了。
 */

import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { exportSession, SessionQueryService } from '../src/index.ts'
import { createFixture } from './helpers.ts'

/** 从 ZIP 字节里读出全部文件（自己解析中央目录）。 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('没有中央目录结尾记录')
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02_01_4b_50) throw new Error('中央目录记录签名不对')
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const content = method === 8 ? inflateRawSync(raw) : raw
    if (crc32(content) !== crc) throw new Error(`${name} 的 CRC32 对不上`)
    files.set(name, content)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

/** 校验和（与 zip.ts 同一套口径，这里独立写一份，免得用错实现反而验不出来）。 */
function crc32(data: Buffer): number {
  let crc = 0xff_ff_ff_ff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

describe('会话导出', () => {
  it('包里有一份会话元数据、两种消息格式、产物清单和说明', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    expect(result.entries).toEqual(['session.json', 'messages.json', 'messages.jsonl', 'artifacts.json', 'README.md'])
    expect(result.messageCount).toBe(6)
    expect(result.artifactCount).toBe(1)
  })

  it('导出的 ZIP 能解开，解出来的文件与清单一致', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    const files = readZip(result.data)
    expect(files.size).toBe(5)
    expect([...files.keys()]).toEqual(result.entries)
  })

  it('会话元数据里是那个会话', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId, exportedAt: 1_700_000_000_000 })
    const files = readZip(result.data)
    const metadata = JSON.parse(files.get('session.json')?.toString('utf8') ?? '{}') as {
      conversation: { id: string; title: string }
      messageCount: number
      exportedAt: number
    }
    expect(metadata.conversation.id).toBe(fixture.conversationId)
    expect(metadata.conversation.title).toBe('配置检查')
    expect(metadata.messageCount).toBe(6)
    expect(metadata.exportedAt).toBe(1_700_000_000_000)
  })

  it('消息按 seq 升序导出，内容与库里一致', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    const files = readZip(result.data)
    const messages = JSON.parse(files.get('messages.json')?.toString('utf8') ?? '[]') as { seq: number; id: string }[]
    expect(messages).toHaveLength(6)
    expect(messages.map((message) => message.id)).toEqual(fixture.messages.map((message) => message.id))
    expect(messages[0].seq).toBeLessThan(messages[5].seq)
  })

  it('JSONL 一行一条，行数与消息数一致', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    const files = readZip(result.data)
    const lines = (files.get('messages.jsonl')?.toString('utf8') ?? '').trim().split('\n')
    expect(lines).toHaveLength(6)
    const first = JSON.parse(lines[0]) as { id: string }
    expect(first.id).toBe(fixture.messages[0].id)
  })

  it('产物清单记着是哪条消息产出了什么文件', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    const files = readZip(result.data)
    const records = JSON.parse(files.get('artifacts.json')?.toString('utf8') ?? '[]') as {
      messageId: string
      name: string
      size: number
      mime: string
      path?: string
    }[]
    expect(records).toHaveLength(1)
    expect(records[0].messageId).toBe(fixture.messages[5].id)
    expect(records[0].name).toBe('配置导出.zip')
    expect(records[0].size).toBe(128)
    expect(records[0].mime).toBe('application/zip')
    expect(records[0].path).toBeUndefined()
  })

  it('带上产物文件本体时，包里有那个文件，清单也记着路径', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, {
      conversationId: fixture.conversationId,
      artifacts: [{ path: 'artifacts/配置导出.zip', data: Buffer.from('假装这是一个 zip', 'utf8') }],
    })
    expect(result.entries).toContain('artifacts/配置导出.zip')
    const files = readZip(result.data)
    expect(files.get('artifacts/配置导出.zip')?.toString('utf8')).toBe('假装这是一个 zip')
    const records = JSON.parse(files.get('artifacts.json')?.toString('utf8') ?? '[]') as { path?: string }[]
    expect(records[0].path).toBe('artifacts/配置导出.zip')
  })

  it('包里的说明写清楚了有什么、怎么读', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    const result = exportSession(service, { conversationId: fixture.conversationId })
    const files = readZip(result.data)
    const readme = files.get('README.md')?.toString('utf8') ?? ''
    expect(readme).toContain('messages.json')
    expect(readme).toContain('artifacts.json')
    expect(readme).toContain('6 条消息')
  })

  it('导一个不存在的会话会报错，不给一个空包', () => {
    const fixture = createFixture()
    const service = new SessionQueryService({ store: fixture.store })
    expect(() => {
      exportSession(service, { conversationId: '不存在的会话' })
    }).toThrow(/不存在/)
  })
})
