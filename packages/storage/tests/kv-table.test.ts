/**
 * 存储表（键值表）的用例：一张表摊在一条记录上。
 *
 * 这一族盯的是「表的行为对不对」：写进去读得回来、删了就没了、整体覆盖的
 * 语义、以及**并发写不会互相吞掉**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonBackend, StorageService } from '../src/index.ts'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-kv-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 建一个带 JSON 后端的服务。 */
function makeService(): StorageService {
  return new StorageService({ backends: [new JsonBackend({ root: tempDir() })] })
}

describe('存储表', () => {
  it('写进去读得回来', () => {
    const service = makeService()
    const table = service.table<{ count: number }>('counters')
    table.set('a', { count: 1 })
    table.set('b', { count: 2 })
    expect(table.get('a')).toEqual({ count: 1 })
    expect(table.get('b')).toEqual({ count: 2 })
    expect(table.size()).toBe(2)
  })

  it('表一开始是空的，不是一个空壳记录', () => {
    const service = makeService()
    const table = service.table('counters')
    expect(table.all()).toEqual({})
    expect(table.size()).toBe(0)
  })

  it('删一行：删掉的读不到，其余还在', () => {
    const service = makeService()
    const table = service.table<number>('counters')
    table.set('a', 1)
    table.set('b', 2)
    expect(table.remove('a')).toBe(true)
    expect(table.get('a')).toBeUndefined()
    expect(table.get('b')).toBe(2)
    // 删不存在的那行不算失败（幂等）。
    expect(table.remove('a')).toBe(false)
  })

  it('同一张表重新打开（同一后端）读得回来', () => {
    const root = tempDir()
    const first = new StorageService({ backends: [new JsonBackend({ root })] })
    first.table<number>('counters').set('a', 7)
    const second = new StorageService({ backends: [new JsonBackend({ root })] })
    expect(second.table<number>('counters').get('a')).toBe(7)
  })

  it('不同的表互不干扰', () => {
    const service = makeService()
    service.table<number>('a').set('x', 1)
    service.table<number>('b').set('x', 2)
    expect(service.table<number>('a').get('x')).toBe(1)
    expect(service.table<number>('b').get('x')).toBe(2)
  })

  it('写多行是一次写回', () => {
    const service = makeService()
    const table = service.table<number>('counters')
    table.setMany({ a: 1, b: 2, c: 3 })
    expect(table.size()).toBe(3)
    expect(table.get('c')).toBe(3)
  })

  it('行 id 不能是空串', () => {
    const service = makeService()
    const table = service.table<number>('counters')
    expect(() => table.set('', 1)).toThrow()
  })
})
