/**
 * 内容寻址的附件存储：去重、不可变、不泄露路径。
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentError, ContentAddressedAttachmentStore } from '@ryharness/attachment-storage'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

function store(options?: { quotaBytes?: number; maxBytes?: number }): ContentAddressedAttachmentStore {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-attachment-'))
  roots.push(root)
  return new ContentAddressedAttachmentStore({ root, ...options })
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

const bytes = (text: string): Uint8Array => {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

describe('附件存储', () => {
  it('按内容寻址：同一份内容存两次，id 一样', () => {
    const s = store()
    const first = s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    const second = s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(first.attachmentId).toHaveLength(64)
  })

  it('内容不同 id 不同', () => {
    const s = store()
    const a = s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    const b = s.put({ data: bytes('world'), mediaType: 'text/plain' })
    expect(b.attachmentId).not.toBe(a.attachmentId)
  })

  it('去重：同一份内容只占一份空间', () => {
    const s = store()
    s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    const usage = s.usage()
    expect(usage.count).toBe(1)
    expect(usage.bytes).toBe(5)
  })

  it('取回来：字节与元数据都对得上', () => {
    const s = store()
    const ref = s.put({ data: bytes('hello'), mediaType: 'text/plain', name: 'greeting.txt' })
    const got = s.get(ref.attachmentId)
    expect(Buffer.from(got.data).toString('utf8')).toBe('hello')
    expect(got.ref.mediaType).toBe('text/plain')
    expect(got.ref.name).toBe('greeting.txt')
    expect(got.ref.bytes).toBe(5)
  })

  it('不存在的 id 报 not-found', () => {
    const s = store()
    expect(() => s.get('0'.repeat(64))).toThrow(AttachmentError)
    try {
      s.get('0'.repeat(64))
    } catch (error) {
      expect((error as AttachmentError).code).toBe('not-found')
    }
  })

  it('id 不合法直接拒（不让路径从外面漏进来）', () => {
    const s = store()
    expect(() => s.get('../../etc/passwd')).toThrow(AttachmentError)
    try {
      s.get('../../etc/passwd')
    } catch (error) {
      expect((error as AttachmentError).code).toBe('invalid-id')
    }
  })

  it('太大报 too-large，并说清上限', () => {
    const s = store()
    try {
      s.put({ data: bytes('0123456789'), mediaType: 'text/plain', maxBytes: 4 })
      expect.fail('应该报错')
    } catch (error) {
      expect((error as AttachmentError).code).toBe('too-large')
      expect((error as AttachmentError).message).toContain('4')
    }
  })

  it('配额满了报 quota-exceeded', () => {
    const s = store({ quotaBytes: 4 })
    try {
      s.put({ data: bytes('0123456789'), mediaType: 'text/plain' })
      expect.fail('应该报错')
    } catch (error) {
      expect((error as AttachmentError).code).toBe('quota-exceeded')
    }
  })

  it('删掉之后就没了', () => {
    const s = store()
    const ref = s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    expect(s.has(ref.attachmentId)).toBe(true)
    expect(s.delete(ref.attachmentId)).toBe(true)
    expect(s.has(ref.attachmentId)).toBe(false)
    expect(s.delete(ref.attachmentId)).toBe(false)
  })

  it('内容被改坏时取回会报 mismatch（不是悄悄给一份错的）', () => {
    const s = store()
    const ref = s.put({ data: bytes('hello'), mediaType: 'text/plain' })
    const root = s.rootPath
    const path = join(root, ref.attachmentId.slice(0, 2), ref.attachmentId.slice(2, 4), ref.attachmentId)
    writeFileSync(path, 'tampered', 'utf8')
    try {
      s.get(ref.attachmentId)
      expect.fail('应该报错')
    } catch (error) {
      expect((error as AttachmentError).code).toBe('mismatch')
    }
  })

  it('列清单：存过的都在，元数据读得回来', () => {
    const s = store()
    s.put({ data: bytes('a'), mediaType: 'text/plain', name: 'a.txt' })
    s.put({ data: bytes('b'), mediaType: 'text/plain', name: 'b.txt' })
    const list = s.list()
    expect(list).toHaveLength(2)
    expect(list.map((ref) => ref.name).sort()).toEqual(['a.txt', 'b.txt'])
    for (const ref of list) {
      expect(ref.createdAt).toBeGreaterThan(0)
    }
    expect(statSync(s.rootPath).isDirectory()).toBe(true)
  })
})
