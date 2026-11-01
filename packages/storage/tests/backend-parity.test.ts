import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JSON_BACKEND_NAME,
  JsonBackend,
  SQLITE_BACKEND_NAME,
  SqliteBackend,
  type StorageBackend,
  type StorageRecord,
  StorageService,
} from '@ryharness/storage'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的临时目录。 */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-storage-parity-'))
  roots.push(root)
  return root
}

/** 造一条记录。 */
function makeRecord(id: string, kind: string, data: unknown, createdAt = 1): StorageRecord {
  return { id, kind, data, createdAt, updatedAt: createdAt }
}

/** 两个后端各来一份，用来做同一串操作的对照。 */
function backendPair(): { json: StorageBackend; sqlite: StorageBackend } {
  const root = scratch()
  return {
    json: new JsonBackend({ root: join(root, 'json') }),
    sqlite: new SqliteBackend({ file: join(root, 'records.db') }),
  }
}

/** 在一个后端上跑固定的一串操作，把每一步的结果记下来。 */
function runScript(backend: StorageBackend): unknown[] {
  const trace: unknown[] = []
  backend.put(makeRecord('a', 'note', { v: 1 }, 100))
  backend.put(makeRecord('b', 'note', { v: 2 }, 200))
  backend.put(makeRecord('c', 'config', { v: 3 }, 300))
  trace.push(backend.get('note', 'a'))
  trace.push(backend.get('note', '不存在的'))
  trace.push(backend.list('note').map((record) => record.id))
  trace.push(backend.list('config').map((record) => record.id))
  trace.push(backend.kinds())
  trace.push(backend.remove('note', 'a'))
  trace.push(backend.remove('note', 'a'))
  trace.push(backend.get('note', 'a'))
  trace.push(backend.list('note').map((record) => record.id))
  backend.put(makeRecord('a', 'note', { v: 9 }, 400))
  trace.push(backend.get('note', 'a'))
  return trace
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('两个后端行为一致', () => {
  it('同一串操作在 JSON 与 SQLite 上给出同样的结果', () => {
    const { json, sqlite } = backendPair()
    expect(runScript(json)).toEqual(runScript(sqlite))
    json.close()
    sqlite.close()
  })

  it('后端名分别是 json 与 sqlite', () => {
    const { json, sqlite } = backendPair()
    expect(json.name).toBe(JSON_BACKEND_NAME)
    expect(sqlite.name).toBe(SQLITE_BACKEND_NAME)
    json.close()
    sqlite.close()
  })

  it('同一个服务挂两个后端时，路由到哪一个就写进哪一个', () => {
    const { json, sqlite } = backendPair()
    const service = new StorageService({ backends: [json, sqlite], now: () => 1000 })
    service.put('note', 'a', { v: 1 })
    service.route('note', sqlite.name)
    service.put('note', 'b', { v: 2 })

    expect(json.list('note').map((record) => record.id)).toEqual(['a'])
    expect(sqlite.list('note').map((record) => record.id)).toEqual(['b'])

    service.route('note', json.name)
    expect(service.list('note').map((record) => record.id)).toEqual(['a'])
    json.close()
    sqlite.close()
  })

  it('两个后端各自都能撑住一整轮增删改', () => {
    const { json, sqlite } = backendPair()
    for (const backend of [json, sqlite]) {
      backend.put(makeRecord('x', 'k', 1, 10))
      backend.put(makeRecord('y', 'k', 2, 20))
      expect(backend.list('k').map((record) => record.id)).toEqual(['x', 'y'])
      expect(backend.remove('k', 'x')).toBe(true)
      expect(backend.list('k').map((record) => record.id)).toEqual(['y'])
      expect(backend.kinds()).toEqual(['k'])
    }
    json.close()
    sqlite.close()
  })
})
