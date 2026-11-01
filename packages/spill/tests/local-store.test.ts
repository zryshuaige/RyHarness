/**
 * 本机私有文件存储的用例。
 *
 * 断言都落在**具体行为**上：文件落在哪、别的会话读不读得到、容量到顶时报什么错、
 * 分页切得对不对——不是「跑通就行」。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSpillId, LocalSpillStore, sessionSlug } from '../src/local.ts'
import { SpillError } from '../src/types.ts'

/** 每个用例一个临时数据目录。 */
let dataDir = ''
/** 可注入的时钟：清理用例要靠它把时间拨到过去。 */
let clock = 1_700_000_000_000

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ryharness-spill-'))
  clock = 1_700_000_000_000
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** 造一个存储：默认时钟与默认 id 生成器都可控。 */
function makeStore(options: { maxBytes?: number; maxEntryBytes?: number; maxAgeMs?: number } = {}): LocalSpillStore {
  return new LocalSpillStore({
    dataDir,
    now: () => clock,
    ...options,
  })
}

describe('LocalSpillStore 存储', () => {
  it('存一段文本，返回一个能用的定位符', () => {
    const store = makeStore()
    const ref = store.store('这是一段会溢出的工具结果。', { sessionId: 'conv-1' })

    expect(isSpillId(ref.id)).toBe(true)
    expect(ref.chars).toBe(13)
    expect(ref.sessionId).toBe('conv-1')
    expect(ref.retrieval).toContain('spill_read')
    expect(ref.retrieval).toContain(ref.id)
    expect(new Date(ref.createdAt).getTime()).toBe(clock)
  })

  it('正文落到会话私有目录下的 .txt 文件里，内容一字不差', () => {
    const store = makeStore()
    const text = '第一行\n第二行\t带制表符\n第三行'
    const ref = store.store(text, { sessionId: 'conv-1' })

    const file = join(dataDir, 'spills', sessionSlug('conv-1'), `${ref.id}.txt`)
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(join(dataDir, 'spills', sessionSlug('conv-1')))).toContain(`${ref.id}.txt`)
    expect(statSync(file).size).toBe(Buffer.byteLength(text, 'utf8'))
  })

  it('按定位符能取回原文', () => {
    const store = makeStore()
    const text = '取回来要一模一样。'
    const ref = store.store(text, { sessionId: 'conv-1' })

    const result = store.read(ref, { sessionId: 'conv-1' })

    expect(result.text).toBe(text)
    expect(result.chars).toBe(text.length)
    expect(result.hasMore).toBe(false)
    expect(result.offset).toBe(0)
  })

  it('取回时带上的元信息里有来源工具', () => {
    const store = makeStore()
    const ref = store.store('正文', { sessionId: 'conv-1', tool: 'shell_exec' })

    const result = store.read(ref.id, { sessionId: 'conv-1' })

    expect(result.meta?.tool).toBe('shell_exec')
    expect(result.meta?.sessionId).toBe('conv-1')
  })

  it('别的会话拿着同一个定位符取不到', () => {
    const store = makeStore()
    const ref = store.store('这段属于 conv-1', { sessionId: 'conv-1' })

    expect(() => store.read(ref, { sessionId: 'conv-2' })).toThrow(SpillError)
    try {
      store.read(ref, { sessionId: 'conv-2' })
      expect.unreachable('别的会话不该读到')
    } catch (error) {
      expect(error).toBeInstanceOf(SpillError)
      expect((error as SpillError).code).toBe('FORBIDDEN')
      expect((error as SpillError).message).toContain('别的会话')
    }
  })

  it('调用方没有会话上下文时，归属会话的文本也取不到', () => {
    const store = makeStore()
    const ref = store.store('这段属于 conv-1', { sessionId: 'conv-1' })

    try {
      store.read(ref)
      expect.unreachable('没有会话上下文不该读到')
    } catch (error) {
      expect((error as SpillError).code).toBe('FORBIDDEN')
    }
  })

  it('没有归属会话的文本，谁拿着 id 都能取', () => {
    const store = makeStore()
    const ref = store.store('谁都能取的公共文本')

    const result = store.read(ref.id)

    expect(result.text).toBe('谁都能取的公共文本')
  })

  it('两个会话 id 清洗后重名，也不会落到同一个目录', () => {
    expect(sessionSlug('a/b')).not.toBe(sessionSlug('a:b'))
    expect(sessionSlug('conv-1')).toBe(sessionSlug('conv-1'))
    expect(sessionSlug('conv-1')).not.toContain('/')
  })

  it('单条超过上限时报容量错，且不落文件', () => {
    const store = makeStore({ maxEntryBytes: 16 })

    expect(() => store.store('x'.repeat(64), { sessionId: 'conv-1' })).toThrow(SpillError)
    try {
      store.store('x'.repeat(64), { sessionId: 'conv-1' })
    } catch (error) {
      expect((error as SpillError).code).toBe('CAPACITY_EXCEEDED')
    }
    expect(existsSync(join(dataDir, 'spills'))).toBe(false)
  })

  it('总量超过上限时报容量错，原文一句都不丢', () => {
    const store = makeStore({ maxBytes: 40, maxEntryBytes: 32 })
    store.store('a'.repeat(30), { sessionId: 'conv-1' })

    try {
      store.store('b'.repeat(30), { sessionId: 'conv-1' })
      expect.unreachable('超过总量上限不该存进去')
    } catch (error) {
      expect((error as SpillError).code).toBe('CAPACITY_EXCEEDED')
    }
    // 第一条还在，第二条没落盘。
    expect(store.list('conv-1')).toHaveLength(1)
  })

  it('读一个不存在的 id 报找不到', () => {
    const store = makeStore()

    try {
      store.read('sp_0000_000000000000')
      expect.unreachable('不存在的 id 该报错')
    } catch (error) {
      expect((error as SpillError).code).toBe('NOT_FOUND')
    }
  })

  it('读一个形状不合法的定位符直接拒绝，不去碰磁盘', () => {
    const store = makeStore()

    try {
      store.read('../../etc/passwd')
      expect.unreachable('形状不合法的定位符该被拒绝')
    } catch (error) {
      expect((error as SpillError).code).toBe('INVALID_INPUT')
    }
  })

  it('分页取回切的是正确的那一段', () => {
    const store = makeStore()
    const text = '0123456789'
    const ref = store.store(text, { sessionId: 'conv-1' })

    const result = store.read(ref, { sessionId: 'conv-1', offset: 3, limit: 4 })

    expect(result.text).toBe('3456')
    expect(result.offset).toBe(3)
    expect(result.chars).toBe(10)
    expect(result.hasMore).toBe(true)
    expect(result.nextOffset).toBe(7)
  })

  it('偏移超出长度时给空串，且没有下一页', () => {
    const store = makeStore()
    const ref = store.store('短', { sessionId: 'conv-1' })

    const result = store.read(ref, { sessionId: 'conv-1', offset: 99 })

    expect(result.text).toBe('')
    expect(result.hasMore).toBe(false)
    expect(result.nextOffset).toBeUndefined()
  })

  it('清理按年龄来：过期的删掉、新的留下', () => {
    const store = makeStore({ maxAgeMs: 1000 })
    store.store('老的一段', { sessionId: 'conv-1' })
    clock += 5000
    store.store('新的一段', { sessionId: 'conv-1' })

    const result = store.cleanup()

    expect(result.removed).toBe(1)
    expect(result.freedBytes).toBe(Buffer.byteLength('老的一段', 'utf8'))
    expect(store.list('conv-1')).toHaveLength(1)
    expect(store.list('conv-1')[0]?.chars).toBe(4)
  })

  it('清理可以只清一个会话的', () => {
    const store = makeStore()
    store.store('conv-1 的', { sessionId: 'conv-1' })
    store.store('conv-2 的', { sessionId: 'conv-2' })

    const result = store.cleanup({ sessionId: 'conv-1', olderThanMs: 0 })

    expect(result.removed).toBe(1)
    expect(store.list('conv-1')).toHaveLength(0)
    expect(store.list('conv-2')).toHaveLength(1)
  })

  it('删掉一条之后就读不到了', () => {
    const store = makeStore()
    const ref = store.store('待删除', { sessionId: 'conv-1' })

    expect(store.remove(ref)).toBe(true)
    expect(store.remove(ref)).toBe(false)
    expect(() => store.read(ref, { sessionId: 'conv-1' })).toThrow(SpillError)
  })

  it('列表按新到旧排，并且能按会话过滤', () => {
    const store = makeStore()
    store.store('第一条', { sessionId: 'conv-1' })
    clock += 10
    store.store('第二条', { sessionId: 'conv-1' })
    clock += 10
    store.store('第三条', { sessionId: 'conv-2' })

    const all = store.list()
    expect(all).toHaveLength(3)
    expect(all[0]?.chars).toBe(3)
    expect(store.list('conv-1')).toHaveLength(2)
  })

  it('换个实例（模拟重启）也读得到之前存的文本', () => {
    const first = makeStore()
    const ref = first.store('重启前存的', { sessionId: 'conv-1' })

    const second = makeStore()
    const result = second.read(ref.id, { sessionId: 'conv-1' })

    expect(result.text).toBe('重启前存的')
  })

  it('目录里塞了别的文件也不影响索引', () => {
    const store = makeStore()
    store.store('正常的一条', { sessionId: 'conv-1' })
    const dir = join(dataDir, 'spills', sessionSlug('conv-1'))
    writeFileSync(join(dir, '不是我们的文件.txt'), '乱写的', 'utf8')

    expect(store.list('conv-1')).toHaveLength(1)
    expect(store.list('conv-1')[0]?.chars).toBe(5)
  })

  it('正文不是字符串时直接拒绝', () => {
    const store = makeStore()
    const bad: unknown = 42

    try {
      store.store(bad as string)
      expect.unreachable('不是字符串的正文该被拒绝')
    } catch (error) {
      expect((error as SpillError).code).toBe('INVALID_INPUT')
    }
  })

  it('生成的定位符不合法时直接拒绝，不落文件', () => {
    const store = new LocalSpillStore({ dataDir, newId: () => '不合法 的 id' })

    try {
      store.store('正文', { sessionId: 'conv-1' })
      expect.unreachable('不合法的定位符该被拒绝')
    } catch (error) {
      expect((error as SpillError).code).toBe('INVALID_INPUT')
    }
    expect(existsSync(join(dataDir, 'spills'))).toBe(false)
  })

  it('正文文件没了就说读失败，不装作找不到', () => {
    const store = makeStore()
    const ref = store.store('待会儿就不在了', { sessionId: 'conv-1' })
    rmSync(join(dataDir, 'spills', sessionSlug('conv-1'), `${ref.id}.txt`), { force: true })

    try {
      store.read(ref, { sessionId: 'conv-1' })
      expect.unreachable('文件没了该报错')
    } catch (error) {
      expect((error as SpillError).code).toBe('READ_FAILED')
    }
  })

  it('旁挂的元信息坏了，正文照样读得到', () => {
    const store = makeStore()
    const ref = store.store('元信息坏了也读得到', { sessionId: 'conv-1', tool: 'shell_exec' })
    writeFileSync(join(dataDir, 'spills', sessionSlug('conv-1'), `${ref.id}.meta.json`), '{ 坏的', 'utf8')

    const reopened = makeStore()
    const result = reopened.read(ref, { sessionId: 'conv-1' })

    expect(result.text).toBe('元信息坏了也读得到')
    expect(result.meta?.tool).toBeUndefined()
  })
})
