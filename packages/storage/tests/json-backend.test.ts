import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeSegment, encodeSegment, JsonBackend, StorageCorruptError, type StorageRecord } from '@ryharness/storage'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录当后端根目录。 */
function backendRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-storage-json-'))
  roots.push(root)
  return root
}

/** 造一条记录。 */
function makeRecord(id: string, kind: string, data: unknown, createdAt = 1): StorageRecord {
  return { id, kind, data, createdAt, updatedAt: createdAt }
}

/** 某个 kind 目录下的文件名。 */
function filesOf(root: string, kind: string): string[] {
  return readdirSync(join(root, encodeSegment(kind))).sort()
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('JSON 后端的存取', () => {
  it('写进去的记录原样取回来', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('a1', 'note', { title: '标题', n: 3 }, 1700))
    const got = backend.get('note', 'a1')
    expect(got).toEqual({ id: 'a1', kind: 'note', data: { title: '标题', n: 3 }, createdAt: 1700, updatedAt: 1700 })
  })

  it('没有这条记录时返回 undefined（不抛错）', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    expect(backend.get('note', '不存在')).toBeUndefined()
  })

  it('同一个 id 在不同 kind 下各存一份，互不覆盖', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('same', 'note', { 在: 'note' }))
    backend.put(makeRecord('same', 'config', { 在: 'config' }))
    expect(backend.get('note', 'same')?.data).toEqual({ 在: 'note' })
    expect(backend.get('config', 'same')?.data).toEqual({ 在: 'config' })
  })

  it('落盘的是人能读的 JSON，字段名原样保留', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a1', 'note', { 标题: '带中文' }))
    const text = readFileSync(join(root, encodeSegment('note'), `${encodeSegment('a1')}.json`), 'utf8')
    expect(text).toContain('"标题": "带中文"')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('覆盖写是整条替换，旧数据不残留', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('a1', 'note', { 旧: 1 }))
    backend.put(makeRecord('a1', 'note', { 新: 2 }))
    expect(backend.get('note', 'a1')?.data).toEqual({ 新: 2 })
  })
})

describe('JSON 后端的列举', () => {
  it('list 按创建时间排；时间相同再按 id 排', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('b', 'note', 1, 200))
    backend.put(makeRecord('a', 'note', 2, 100))
    backend.put(makeRecord('c', 'note', 3, 100))
    expect(backend.list('note').map((r) => r.id)).toEqual(['a', 'c', 'b'])
  })

  it('list 只给这个 kind 的记录', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('a', 'note', 1))
    backend.put(makeRecord('b', 'config', 2))
    expect(backend.list('note').map((r) => r.id)).toEqual(['a'])
    expect(backend.list('config').map((r) => r.id)).toEqual(['b'])
  })

  it('kind 目录不存在时 list 给空数组', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    expect(backend.list('根本没有这个 kind')).toEqual([])
  })

  it('kinds 列出全部分组并按名字排', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('a', 'zeta', 1))
    backend.put(makeRecord('b', 'alpha', 2))
    backend.put(makeRecord('c', 'mid', 3))
    expect(backend.kinds()).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('kinds 忽略没有记录的目录', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    mkdirSync(join(root, encodeSegment('空目录')), { recursive: true })
    backend.put(makeRecord('a', 'note', 1))
    expect(backend.kinds()).toEqual(['note'])
  })

  it('根目录不存在时 kinds 给空数组', () => {
    const root = join(backendRoot(), '根本没有这个根目录')
    expect(new JsonBackend({ root }).kinds()).toEqual([])
  })

  it('根目录里混着别的文件时 kinds 只给分组名', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    writeFileSync(join(root, '随手放的一个文件.txt'), 'x', 'utf8')
    expect(backend.kinds()).toEqual(['note'])
  })

  it('list 跳过写一半的临时文件', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    writeFileSync(join(root, encodeSegment('note'), 'a.json.123.456.tmp'), '{ 半个', 'utf8')
    expect(backend.list('note').map((r) => r.id)).toEqual(['a'])
  })
})

describe('JSON 后端的原子写', () => {
  it('写完目录里只剩记录文件，没有临时文件残留', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', { x: 1 }))
    expect(filesOf(root, 'note')).toEqual([`${encodeSegment('a')}.json`])
  })

  it('写失败时临时文件被清掉，不留半份记录', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    // 先把目标位置占成一个目录：rename 覆盖到已存在的目录会失败。
    mkdirSync(join(root, encodeSegment('note'), `${encodeSegment('a')}.json`), { recursive: true })
    expect(() => backend.put(makeRecord('a', 'note', { x: 1 }))).toThrow()
    expect(filesOf(root, 'note').filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('第一次写会先把 kind 目录建出来', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    expect(readdirSync(root)).toEqual([encodeSegment('note')])
  })
})

describe('JSON 后端的删除', () => {
  it('删掉之后取不到，再删一次返回 false（幂等）', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    backend.put(makeRecord('a', 'note', 1))
    expect(backend.remove('note', 'a')).toBe(true)
    expect(backend.get('note', 'a')).toBeUndefined()
    expect(backend.remove('note', 'a')).toBe(false)
  })

  it('删一个本来就没有的记录返回 false', () => {
    const backend = new JsonBackend({ root: backendRoot() })
    expect(backend.remove('note', '从来没有过')).toBe(false)
  })
})

describe('文件名的可逆编码', () => {
  it('安全字符原样保留，其余按 UTF-8 字节百分号编码', () => {
    expect(encodeSegment('a-b_c1')).toBe('_a-b_c1')
    expect(encodeSegment('a/b')).toBe('_a%2Fb')
    expect(encodeSegment('工作区')).toBe('_%E5%B7%A5%E4%BD%9C%E5%8C%BA')
  })

  it('Windows 的保留名靠前缀躲开', () => {
    expect(encodeSegment('CON')).toBe('_CON')
    expect(encodeSegment('NUL')).toBe('_NUL')
  })

  it('编码能原样还原', () => {
    for (const value of ['', 'a/b', '工作区', 'x y', 'CON', '带"引号"的']) {
      expect(decodeSegment(encodeSegment(value))).toBe(value)
    }
  })

  it('目录名反推回来就是 kind', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', '我的项目/草稿', 1))
    expect(readdirSync(root).map(decodeSegment)).toEqual(['我的项目/草稿'])
    expect(backend.kinds()).toEqual(['我的项目/草稿'])
  })
})

describe('坏掉的文件', () => {
  it('内容不是合法 JSON 时报「内容损坏」，并带上路径', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    const path = join(root, encodeSegment('note'), `${encodeSegment('a')}.json`)
    writeFileSync(path, '{ 写了一半', 'utf8')
    expect(() => backend.get('note', 'a')).toThrow(StorageCorruptError)
    try {
      backend.get('note', 'a')
    } catch (error) {
      expect(error).toBeInstanceOf(StorageCorruptError)
      expect((error as StorageCorruptError).path).toBe(path)
      expect((error as StorageCorruptError).message).toContain('不是合法的 JSON')
    }
  })

  it('内容不像一条记录时报「内容损坏」', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    writeFileSync(join(root, encodeSegment('note'), `${encodeSegment('a')}.json`), '{"id":"a"}', 'utf8')
    expect(() => backend.get('note', 'a')).toThrow(StorageCorruptError)
  })

  it('内容是 null 时也报「内容损坏」', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    writeFileSync(join(root, encodeSegment('note'), `${encodeSegment('a')}.json`), 'null', 'utf8')
    expect(() => backend.get('note', 'a')).toThrow(/不像一条记录/u)
  })

  it('记录与文件路径对不上时报「内容损坏」', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    const path = join(root, encodeSegment('note'), `${encodeSegment('a')}.json`)
    writeFileSync(path, JSON.stringify({ id: '别的', kind: 'note', data: 1, createdAt: 1, updatedAt: 1 }), 'utf8')
    expect(() => backend.get('note', 'a')).toThrow(/与路径对不上/u)
  })

  it('list 撞到坏文件也会报出来，不会静默跳过', () => {
    const root = backendRoot()
    const backend = new JsonBackend({ root })
    backend.put(makeRecord('a', 'note', 1))
    writeFileSync(join(root, encodeSegment('note'), `${encodeSegment('b')}.json`), '不是 JSON', 'utf8')
    expect(() => backend.list('note')).toThrow(StorageCorruptError)
  })
})
