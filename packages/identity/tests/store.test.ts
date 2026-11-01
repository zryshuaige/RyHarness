import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDataDir, IDENTITY_FILE_NAME, IdentityStore } from '@ryharness/identity'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

/** 一个干净的数据目录。 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-id-'))
  roots.push(dir)
  return dir
}

/** 一个固定 id 的存储：id 随机的话没法断言。 */
function storeWith(dir: string, id: string): IdentityStore {
  return new IdentityStore({ dataDir: dir, newId: () => id, now: () => 1_700_000_000_000 })
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root === undefined) continue
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('身份存储的读写', () => {
  it('文件不在时 read 给 undefined', () => {
    const dir = dataDir()
    expect(storeWith(dir, 'a'.repeat(32)).read()).toBeUndefined()
  })

  it('ensure 会把 id 落进数据目录', () => {
    const dir = dataDir()
    const store = storeWith(dir, 'a'.repeat(32))
    const identity = store.ensure()
    expect(identity.id).toBe('a'.repeat(32))
    expect(existsSync(join(dir, IDENTITY_FILE_NAME))).toBe(true)
  })

  it('反复 ensure 拿到的是同一个 id', () => {
    const dir = dataDir()
    const store = storeWith(dir, 'a'.repeat(32))
    const first = store.ensure()
    const second = store.ensure()
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('换个存储实例读同一个目录，还是同一个 id', () => {
    const dir = dataDir()
    storeWith(dir, 'b'.repeat(32)).ensure()
    expect(storeWith(dir, 'c'.repeat(32)).read()?.id).toBe('b'.repeat(32))
  })

  it('文件里只有 id 与生成时间，没有别的', () => {
    const dir = dataDir()
    storeWith(dir, 'a'.repeat(32)).ensure()
    const payload = JSON.parse(readFileSync(join(dir, IDENTITY_FILE_NAME), 'utf8')) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['createdAt', 'id', 'version'])
    expect(payload['id']).toBe('a'.repeat(32))
    expect(payload['createdAt']).toBe(1_700_000_000_000)
  })

  it('生成时间是数字，反复读不变', () => {
    const dir = dataDir()
    const store = storeWith(dir, 'a'.repeat(32))
    const created = store.ensure().createdAt
    expect(typeof created).toBe('number')
    expect(store.read()?.createdAt).toBe(created)
  })

  it('不注入生成器时也能自己生成一个', () => {
    const dir = dataDir()
    const store = new IdentityStore({ dataDir: dir })
    const identity = store.ensure()
    expect(identity.id).toHaveLength(32)
    expect(store.ensure().id).toBe(identity.id)
  })
})

describe('删掉文件就是一次新安装', () => {
  it('文件被删后 ensure 生成一个不同的 id', () => {
    const dir = dataDir()
    const first = storeWith(dir, 'a'.repeat(32)).ensure()
    rmSync(join(dir, IDENTITY_FILE_NAME), { force: true })
    const second = storeWith(dir, 'b'.repeat(32)).ensure()
    expect(second.id).not.toBe(first.id)
    expect(second.id).toBe('b'.repeat(32))
  })

  it('reset 删掉文件并生成新 id', () => {
    const dir = dataDir()
    const store = storeWith(dir, 'a'.repeat(32))
    const first = store.ensure()
    const second = store.reset()
    expect(second.id).toBe('a'.repeat(32))
    expect(second.createdAt).toBe(1_700_000_000_000)
    expect(store.read()?.id).toBe('a'.repeat(32))
    expect(first.id).toBe('a'.repeat(32))
  })
})

describe('坏掉的 id 文件', () => {
  it('不是合法 JSON 时当成没有，重新生成一个', () => {
    const dir = dataDir()
    writeFileSync(join(dir, IDENTITY_FILE_NAME), '{ 写了一半', 'utf8')
    const store = storeWith(dir, 'd'.repeat(32))
    expect(store.read()).toBeUndefined()
    expect(store.ensure().id).toBe('d'.repeat(32))
  })

  it('id 不合法时当成没有', () => {
    const dir = dataDir()
    writeFileSync(join(dir, IDENTITY_FILE_NAME), JSON.stringify({ version: 1, id: '太短', createdAt: 1 }), 'utf8')
    const store = storeWith(dir, 'e'.repeat(32))
    expect(store.read()).toBeUndefined()
    expect(store.ensure().id).toBe('e'.repeat(32))
  })

  it('缺生成时间时当成没有', () => {
    const dir = dataDir()
    writeFileSync(join(dir, IDENTITY_FILE_NAME), JSON.stringify({ version: 1, id: 'f'.repeat(32) }), 'utf8')
    expect(storeWith(dir, 'g'.repeat(32)).read()).toBeUndefined()
  })

  it('内容不是一份身份时当成没有', () => {
    const dir = dataDir()
    writeFileSync(join(dir, IDENTITY_FILE_NAME), '[]', 'utf8')
    expect(storeWith(dir, 'h'.repeat(32)).read()).toBeUndefined()
  })

  it('写坏了时临时文件被清掉，不留半份记录', () => {
    const dir = dataDir()
    // 先把目标位置占成一个目录：rename 覆盖到已存在的目录会失败。
    mkdirSync(join(dir, IDENTITY_FILE_NAME))
    const store = storeWith(dir, 'i'.repeat(32))
    expect(() => store.ensure()).toThrow()
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
  })
})

describe('数据目录', () => {
  it('Windows 下落在 %APPDATA% 里', () => {
    const dir = defaultDataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'C:\\Users\\x', 'win32')
    expect(dir).toBe('C:\\Users\\x\\AppData\\Roaming\\RyHarness')
  })

  it('Windows 下没有 APPDATA 时退回主目录', () => {
    const dir = defaultDataDir({}, 'C:\\Users\\x', 'win32')
    expect(dir).toBe('C:\\Users\\x\\AppData\\Roaming\\RyHarness')
  })

  it('macOS 下落在 Application Support 里', () => {
    const dir = defaultDataDir({}, '/Users/x', 'darwin')
    expect(dir).toBe('/Users/x/Library/Application Support/RyHarness')
  })

  it('Linux 下用 XDG_DATA_HOME', () => {
    const dir = defaultDataDir({ XDG_DATA_HOME: '/home/x/.local/share' }, '/home/x', 'linux')
    expect(dir).toBe('/home/x/.local/share/RyHarness')
  })

  it('Linux 下没有 XDG_DATA_HOME 时退回 ~/.local/share', () => {
    const dir = defaultDataDir({}, '/home/x', 'linux')
    expect(dir).toBe('/home/x/.local/share/RyHarness')
  })

  it('id 文件就在数据目录下面', () => {
    const dir = dataDir()
    const store = new IdentityStore({ dataDir: dir })
    expect(store.path).toBe(join(dir, IDENTITY_FILE_NAME))
  })
})
