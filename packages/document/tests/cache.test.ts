/**
 * 按内容 hash 索引的缓存。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentPdfCache } from '../src/index.ts'
import { createTempDir, fakePdf } from './helpers.ts'

/** 当前测试的临时目录。 */
let dir: { path: string; dispose: () => void } | undefined

afterEach(() => {
  dir?.dispose()
  dir = undefined
})

describe('PDF 缓存', () => {
  it('同样的内容给同样的键', () => {
    const cache = new DocumentPdfCache(join(process.cwd(), 'unused'))
    const first = cache.keyFor(new Uint8Array([1, 2, 3]), 'application/rtf', 'fake')
    const second = cache.keyFor(new Uint8Array([1, 2, 3]), 'application/rtf', 'fake')
    expect(first).toBe(second)
  })

  it('内容、类型、转换器任一不同 → 键不同', () => {
    const cache = new DocumentPdfCache(join(process.cwd(), 'unused'))
    const base = cache.keyFor(new Uint8Array([1, 2, 3]), 'application/rtf', 'fake')
    expect(cache.keyFor(new Uint8Array([1, 2, 4]), 'application/rtf', 'fake')).not.toBe(base)
    expect(cache.keyFor(new Uint8Array([1, 2, 3]), 'application/msword', 'fake')).not.toBe(base)
    expect(cache.keyFor(new Uint8Array([1, 2, 3]), 'application/rtf', 'other')).not.toBe(base)
  })

  it('写进去能读回来', async () => {
    dir = createTempDir()
    const cache = new DocumentPdfCache(dir.path)
    const key = cache.keyFor(new Uint8Array([1]), 'application/rtf', 'fake')
    const pdf = fakePdf('ry')

    const path = await cache.write(key, pdf)

    expect(existsSync(path)).toBe(true)
    const read = await cache.read(key)
    expect(read).toBeDefined()
    expect(Buffer.from(read ?? []).toString('utf8')).toContain('%PDF-1.7')
    expect(cache.has(key)).toBe(true)
  })

  it('没写过的键读出来是 undefined', async () => {
    dir = createTempDir()
    const cache = new DocumentPdfCache(dir.path)
    expect(await cache.read('nothing-here')).toBeUndefined()
    expect(cache.has('nothing-here')).toBe(false)
  })

  it('缓存文件坏了（不像 PDF）→ 当作没命中', async () => {
    dir = createTempDir()
    const cache = new DocumentPdfCache(dir.path)
    const key = cache.keyFor(new Uint8Array([1]), 'application/rtf', 'fake')
    writeFileSync(cache.pathFor(key), '这不是 PDF', 'utf8')

    expect(await cache.read(key)).toBeUndefined()
  })

  it('目录不存在时会自己建出来', async () => {
    dir = createTempDir()
    const cache = new DocumentPdfCache(join(dir.path, 'nested', 'cache'))
    const key = cache.keyFor(new Uint8Array([1]), 'application/rtf', 'fake')

    await cache.write(key, fakePdf())

    expect(existsSync(cache.pathFor(key))).toBe(true)
  })
})
