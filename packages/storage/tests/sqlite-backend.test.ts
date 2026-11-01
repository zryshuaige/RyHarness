import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteBackend, StorageCorruptError, type StorageRecord } from '@ryharness/storage'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录当数据库所在目录。 */
function dbRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-storage-sqlite-'))
  roots.push(root)
  return root
}

/** 造一条记录。 */
function makeRecord(id: string, kind: string, data: unknown, createdAt = 1): StorageRecord {
  return { id, kind, data, createdAt, updatedAt: createdAt }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('SQLite 后端的存取', () => {
  it('写进去的记录原样取回来', () => {
    const backend = new SqliteBackend({ file: join(dbRoot(), 'records.db') })
    backend.put(makeRecord('a1', 'note', { title: '标题', n: 3 }, 1700))
    expect(backend.get('note', 'a1')).toEqual({
      id: 'a1',
      kind: 'note',
      data: { title: '标题', n: 3 },
      createdAt: 1700,
      updatedAt: 1700,
    })
    backend.close()
  })

  it('没有这条记录时返回 undefined（不抛错）', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    expect(backend.get('note', '不存在')).toBeUndefined()
    backend.close()
  })

  it('覆盖写是整条替换，旧数据不残留', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('a1', 'note', { 旧: 1 }))
    backend.put(makeRecord('a1', 'note', { 新: 2 }))
    expect(backend.get('note', 'a1')?.data).toEqual({ 新: 2 })
    backend.close()
  })

  it('数据列存的是 JSON 文档，索引列单独存', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', { 标题: '带中文' }))
    backend.close()
    const probe = new DatabaseSync(file)
    const row = probe.prepare('SELECT kind, id, created_at, document FROM records').get()
    probe.close()
    if (row === undefined) throw new Error('刚写进去的那一行查不到了')
    expect(row['kind']).toBe('note')
    expect(row['id']).toBe('a1')
    expect(row['created_at']).toBe(1)
    expect(JSON.parse(String(row['document']))).toEqual({ 标题: '带中文' })
  })
})

describe('SQLite 后端的并发设置', () => {
  it('文件库用 WAL：另开一个连接读到的日志模式是 wal', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    const row = probe.prepare('PRAGMA journal_mode').get()
    probe.close()
    if (row === undefined) throw new Error('读不到日志模式')
    expect(row['journal_mode']).toBe('wal')
  })

  it('内存库跳过 WAL（内存库不支持），但照样能读写', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('a1', 'note', 1))
    expect(backend.get('note', 'a1')?.data).toBe(1)
    backend.close()
  })

  it('写锁被别处占着时会等一会儿再写，而不是立刻失败', async () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))

    // 子进程拿住写锁 600ms 再放开：父进程这一侧的写必须等它，而不是抛 SQLITE_BUSY。
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
         const db = new DatabaseSync(process.argv[1])
         db.exec('PRAGMA busy_timeout = 0')
         db.exec('BEGIN EXCLUSIVE')
         process.stdout.write('locked\\n')
         setTimeout(() => { db.exec('COMMIT'); db.close() }, 600)`,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await waitForLine(holder.stdout)

    const started = Date.now()
    backend.put(makeRecord('a2', 'note', 2))
    const waited = Date.now() - started
    // 子进程可能已经退出了，这时不能再等它的 exit 事件。
    if (holder.exitCode === null) {
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()))
    }

    expect(waited).toBeGreaterThanOrEqual(150)
    expect(backend.get('note', 'a2')?.data).toBe(2)
    backend.close()
  })
})

describe('SQLite 后端的列举与删除', () => {
  it('list 按创建时间排；时间相同再按 id 排', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('b', 'note', 1, 200))
    backend.put(makeRecord('a', 'note', 2, 100))
    backend.put(makeRecord('c', 'note', 3, 100))
    expect(backend.list('note').map((r) => r.id)).toEqual(['a', 'c', 'b'])
    backend.close()
  })

  it('list 只给这个 kind 的记录', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('a', 'note', 1))
    backend.put(makeRecord('b', 'config', 2))
    expect(backend.list('note').map((r) => r.id)).toEqual(['a'])
    backend.close()
  })

  it('kinds 列出全部分组并按名字排', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('a', 'zeta', 1))
    backend.put(makeRecord('b', 'alpha', 2))
    expect(backend.kinds()).toEqual(['alpha', 'zeta'])
    backend.close()
  })

  it('删掉之后取不到，再删一次返回 false（幂等）', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.put(makeRecord('a', 'note', 1))
    expect(backend.remove('note', 'a')).toBe(true)
    expect(backend.get('note', 'a')).toBeUndefined()
    expect(backend.remove('note', 'a')).toBe(false)
    backend.close()
  })

  it('close 之后再 close 不会报错', () => {
    const backend = new SqliteBackend({ file: ':memory:' })
    backend.close()
    expect(() => backend.close()).not.toThrow()
  })
})

describe('坏掉的行', () => {
  it('document 列不是合法 JSON 时报「内容损坏」', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    probe.prepare('UPDATE records SET document = ? WHERE id = ?').run('{ 半个', 'a1')
    probe.close()

    const reopened = new SqliteBackend({ file })
    let caught: unknown
    try {
      reopened.get('note', 'a1')
    } catch (error) {
      caught = error
    }
    reopened.close()
    expect(caught).toBeInstanceOf(StorageCorruptError)
    expect((caught as StorageCorruptError).message).toContain('不是合法的 JSON')
  })

  it('document 列不是文本时报「内容损坏」', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    // TEXT 列对数字有亲和性（数字会被转成文本），所以塞一个 BLOB 进去才不是文本。
    probe.prepare("UPDATE records SET document = X'00FF' WHERE id = ?").run('a1')
    probe.close()

    const reopened = new SqliteBackend({ file })
    let caught: unknown
    try {
      reopened.get('note', 'a1')
    } catch (error) {
      caught = error
    }
    reopened.close()
    expect(caught).toBeInstanceOf(StorageCorruptError)
    expect((caught as StorageCorruptError).message).toContain('document 列不是文本')
  })

  it('时间戳列不是数字时报「内容损坏」', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    probe.prepare('UPDATE records SET created_at = ? WHERE id = ?').run('不是数字', 'a1')
    probe.close()

    const reopened = new SqliteBackend({ file })
    let caught: unknown
    try {
      reopened.get('note', 'a1')
    } catch (error) {
      caught = error
    }
    reopened.close()
    expect(caught).toBeInstanceOf(StorageCorruptError)
    expect((caught as StorageCorruptError).message).toContain('时间戳列不是数字')
  })

  it('list 撞到坏行时也会报出来', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    probe.prepare("UPDATE records SET document = X'00FF' WHERE id = ?").run('a1')
    probe.close()

    const reopened = new SqliteBackend({ file })
    let caught: unknown
    try {
      reopened.list('note')
    } catch (error) {
      caught = error
    }
    reopened.close()
    expect(caught).toBeInstanceOf(StorageCorruptError)
  })

  it('kind 列不是文本时 kinds 会报出来', () => {
    const root = dbRoot()
    const file = join(root, 'records.db')
    const backend = new SqliteBackend({ file })
    backend.put(makeRecord('a1', 'note', 1))
    backend.close()
    const probe = new DatabaseSync(file)
    probe.prepare("UPDATE records SET kind = X'00FF'").run()
    probe.close()

    const reopened = new SqliteBackend({ file })
    let caught: unknown
    try {
      reopened.kinds()
    } catch (error) {
      caught = error
    }
    reopened.close()
    expect(caught).toBeInstanceOf(StorageCorruptError)
    expect((caught as StorageCorruptError).message).toContain('kind 列不是文本')
  })
})

/** 等子进程在 stdout 上说一声「锁拿到了」。 */
function waitForLine(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (stream === null) {
      reject(new Error('子进程没有 stdout'))
      return
    }
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error('子进程没有在 5 秒内报出「锁拿到了」'))
    }, 5_000)
    stream.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      if (buffer.includes('locked')) {
        clearTimeout(timer)
        resolve('locked')
      }
    })
    stream.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
