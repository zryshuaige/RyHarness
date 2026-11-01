import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DomainShape,
  JsonBackend,
  SqliteBackend,
  type StorageChangeEvent,
  StorageService,
  type StorageServiceOptions,
  StorageValidationError,
} from '@ryharness/storage'
import { describe, expect, it } from 'vitest'

const roots: string[] = []
const services: StorageService[] = []

/** 建一个服务并记下来：收尾时统一关掉，不然 Windows 上文件还开着删不掉。 */
function makeService(options: StorageServiceOptions): StorageService {
  const service = new StorageService(options)
  services.push(service)
  return service
}

/** 一个干净的临时目录当后端根目录。 */
function backendRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-storage-svc-'))
  roots.push(root)
  return root
}

/** 每次调用走 10ms 的钟：时间戳好断言。 */
function steppingClock(start = 1000): () => number {
  let at = start
  return () => {
    at += 10
    return at
  }
}

/** 工作区记录的形状声明。 */
const workspaceShape: DomainShape = {
  fields: {
    name: { type: 'string' },
    rootPath: { type: 'string' },
    sessions: { type: 'array', required: false },
  },
}

function cleanup(): void {
  while (services.length > 0) {
    const service = services.pop()
    if (service === undefined) continue
    service.close()
  }
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

describe('存储服务的时间戳', () => {
  it('第一次写 createdAt 与 updatedAt 相同', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const record = service.put('note', 'a', { x: 1 })
    expect(record.createdAt).toBe(1010)
    expect(record.updatedAt).toBe(1010)
    cleanup()
  })

  it('再写一次：createdAt 不动，updatedAt 往前推', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const first = service.put('note', 'a', { x: 1 })
    const second = service.put('note', 'a', { x: 2 })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
    expect(second.data).toEqual({ x: 2 })
    cleanup()
  })
})

describe('存储服务的变更通知', () => {
  it('新建、修改、删除分别发三种事件', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const events: StorageChangeEvent[] = []
    service.subscribe((event) => events.push(event))

    service.put('note', 'a', { x: 1 })
    service.put('note', 'a', { x: 2 })
    service.remove('note', 'a')

    expect(events.map((event) => event.type)).toEqual(['created', 'updated', 'deleted'])
    expect(events[0]?.kind).toBe('note')
    expect(events[0]?.id).toBe('a')
    expect(events[0]?.record?.data).toEqual({ x: 1 })
    expect(events[1]?.record?.data).toEqual({ x: 2 })
    expect(events[2]?.record).toBeUndefined()
    cleanup()
  })

  it('删一条不存在的记录不发事件', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const events: StorageChangeEvent[] = []
    service.subscribe((event) => events.push(event))
    expect(service.remove('note', '从来没有过')).toBe(false)
    expect(events).toEqual([])
    cleanup()
  })

  it('退订之后不再收到通知', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const events: StorageChangeEvent[] = []
    const unsubscribe = service.subscribe((event) => events.push(event))
    service.put('note', 'a', 1)
    unsubscribe()
    service.put('note', 'b', 2)
    expect(events.map((event) => event.id)).toEqual(['a'])
    cleanup()
  })

  it('订阅期间新加的订阅者也收得到后面的事件', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const events: StorageChangeEvent[] = []
    service.subscribe((event) => events.push(event))
    service.put('note', 'a', 1)
    expect(events).toHaveLength(1)
    cleanup()
  })
})

describe('存储服务的形状校验', () => {
  it('缺必填字段时报错，并说清是哪个字段', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    service.domain('workspace', workspaceShape)
    let caught: unknown
    try {
      service.put('workspace', 'w1', { name: '项目' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StorageValidationError)
    const failure = caught as StorageValidationError
    expect(failure.kind).toBe('workspace')
    expect(failure.field).toBe('rootPath')
    expect(failure.reason).toBe('缺少必填字段')
    cleanup()
  })

  it('形状里没声明的字段也要拒', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    service.domain('workspace', workspaceShape)
    expect(() => service.put('workspace', 'w1', { name: '项目', rootPath: '/x', 拼错: 1 })).toThrow(
      /形状里没有声明这个字段/u,
    )
    cleanup()
  })

  it('类型不对时报错，并说清实际是什么类型', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    service.domain('workspace', workspaceShape)
    expect(() => service.put('workspace', 'w1', { name: 42, rootPath: '/x' })).toThrow(/应当是 string，实际是 number/u)
    cleanup()
  })

  it('标了 required: false 的字段可以不给', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    service.domain('workspace', workspaceShape)
    const record = service.put('workspace', 'w1', { name: '项目', rootPath: '/x' })
    expect(record.data).toEqual({ name: '项目', rootPath: '/x' })
    cleanup()
  })

  it('绕过视图直接写也照样被拦（校验在服务这一层）', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    service.domain('workspace', workspaceShape)
    expect(() => service.put('workspace', 'w1', { 乱写: true })).toThrow(StorageValidationError)
    cleanup()
  })

  it('没声明形状的 kind 不做校验', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.put('free', 'a', { 随便: true })).not.toThrow()
    cleanup()
  })
})

describe('存储服务的参数检查', () => {
  it('kind 空串要报错', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.put('', 'a', 1)).toThrow(/kind 不能是空串/u)
    cleanup()
  })

  it('id 空串要报错', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.put('note', '', 1)).toThrow(/id 不能是空串/u)
    cleanup()
  })

  it('取一条不存在的记录时给 undefined', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(service.get('note', 'a')).toBeUndefined()
    cleanup()
  })

  it('构造时给的路由表生效', () => {
    const json = new JsonBackend({ root: backendRoot() })
    const sqlite = new SqliteBackend({ file: join(backendRoot(), 'records.db') })
    const service = makeService({ backends: [json, sqlite], routes: { big: sqlite.name }, now: steppingClock(1000) })
    service.put('big', 'a', 1)
    expect(sqlite.list('big')).toHaveLength(1)
    expect(json.list('big')).toHaveLength(0)
    cleanup()
  })
})

describe('存储服务的后端路由', () => {
  it('没路由过的 kind 走第一个注册的后端', () => {
    const json = new JsonBackend({ root: backendRoot() })
    const sqlite = new SqliteBackend({ file: join(backendRoot(), 'records.db') })
    const service = makeService({ backends: [json, sqlite], now: steppingClock(1000) })
    service.put('note', 'a', 1)
    expect(json.list('note')).toHaveLength(1)
    expect(sqlite.list('note')).toHaveLength(0)
    cleanup()
  })

  it('路由过的 kind 落到指定后端', () => {
    const json = new JsonBackend({ root: backendRoot() })
    const sqlite = new SqliteBackend({ file: join(backendRoot(), 'records.db') })
    const service = makeService({ backends: [json, sqlite], now: steppingClock(1000) })
    service.route('big', sqlite.name)
    service.put('big', 'a', 1)
    expect(json.list('big')).toHaveLength(0)
    expect(sqlite.list('big')).toHaveLength(1)
    cleanup()
  })

  it('kinds 把所有后端的分组合起来', () => {
    const json = new JsonBackend({ root: backendRoot() })
    const sqlite = new SqliteBackend({ file: join(backendRoot(), 'records.db') })
    const service = makeService({ backends: [json, sqlite], now: steppingClock(1000) })
    service.put('alpha', 'a', 1)
    service.put('zeta', 'b', 2)
    service.route('mid', sqlite.name)
    service.put('mid', 'c', 3)
    expect(service.kinds()).toEqual(['alpha', 'mid', 'zeta'])
    cleanup()
  })

  it('同名后端不许注册两次', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.register(new JsonBackend({ root: backendRoot() }))).toThrow(/后端名重复/u)
    cleanup()
  })

  it('路由到不存在的后端要报错', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.route('note', '根本没有这个后端')).toThrow(/存储后端不存在/u)
    cleanup()
  })

  it('一个后端都没有时取记录要报错', () => {
    const service = makeService({ now: steppingClock(1000) })
    expect(() => service.get('note', 'a')).toThrow(/还没有任何后端/u)
    cleanup()
  })

  it('close 会把每个后端都关掉', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    expect(() => service.close()).not.toThrow()
    cleanup()
  })
})

describe('领域视图', () => {
  it('视图的读写落在同一个 kind 上', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const domain = service.domain<{ name: string }>('workspace', { fields: { name: { type: 'string' } } })
    domain.put('w1', { name: '项目' })
    expect(domain.get('w1')?.data).toEqual({ name: '项目' })
    expect(service.list('workspace')).toHaveLength(1)
    expect(domain.remove('w1')).toBe(true)
    expect(domain.list()).toEqual([])
    cleanup()
  })

  it('视图的订阅只收自己 kind 的事件', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const domain = service.domain<{ name: string }>('workspace', { fields: { name: { type: 'string' } } })
    const seen: string[] = []
    domain.subscribe((event) => seen.push(`${event.kind}/${event.id}`))
    service.put('workspace', 'w1', { name: '项目' })
    service.put('config', 'c1', { 别的: true })
    expect(seen).toEqual(['workspace/w1'])
    cleanup()
  })

  it('视图的 put 也会走形状校验', () => {
    const service = makeService({ backends: [new JsonBackend({ root: backendRoot() })], now: steppingClock(1000) })
    const domain = service.domain<Record<string, unknown>>('workspace', { fields: { name: { type: 'string' } } })
    expect(() => domain.put('w1', { name: 42 })).toThrow(StorageValidationError)
    cleanup()
  })
})
