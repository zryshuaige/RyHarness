/**
 * 引用的落盘：重启之后配置里写的那个引用 id 还得对得上。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialRegistry, FileCredentialStore, MemoryCredentialStore } from '../src/index.ts'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 造一个临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-credentials-'))
  dirs.push(dir)
  return dir
}

/** 建一个只用来存引用的注册表。 */
function registryOf(store: FileCredentialStore | MemoryCredentialStore) {
  return new CredentialRegistry({
    requestApproval: async () => ({ approved: true }),
    resolveSecret: async (ref) => `secret-for-${ref.id}`,
    store,
    now: () => 1_000,
    newId: () => 'cred-1',
  })
}

describe('内存后端', () => {
  it('存进去再读出来是同一份', () => {
    const store = new MemoryCredentialStore()
    const registry = registryOf(store)
    registry.register({ providerId: 'github', label: 'GitHub' })
    expect(store.load()).toHaveLength(1)
    expect(store.load()[0]?.ref.id).toBe('cred-1')
  })
})

describe('文件后端', () => {
  it('登记的引用落盘，重启后读回来', () => {
    const dir = tempDir()
    const filePath = join(dir, 'config', 'credentials.json')
    const first = registryOf(new FileCredentialStore({ filePath }))
    first.register({ providerId: 'github', label: 'GitHub 主账号', hint: '...1234' })

    const second = registryOf(new FileCredentialStore({ filePath }))
    expect(second.list().map((ref) => ref.label)).toEqual(['GitHub 主账号'])
    expect(second.list()[0]?.hint).toBe('...1234')
  })

  it('落盘的是引用，不是密钥', () => {
    const dir = tempDir()
    const filePath = join(dir, 'credentials.json')
    const registry = registryOf(new FileCredentialStore({ filePath }))
    registry.register({ providerId: 'github', label: 'GitHub' })
    const contents = readFileSync(filePath, 'utf8')
    expect(contents).toContain('"providerId": "github"')
    expect(contents).not.toContain('secret-for-')
  })

  it('吊销的状态也落盘', () => {
    const dir = tempDir()
    const filePath = join(dir, 'credentials.json')
    const first = registryOf(new FileCredentialStore({ filePath }))
    first.register({ providerId: 'github', label: 'GitHub' })
    first.revoke('cred-1')

    const second = registryOf(new FileCredentialStore({ filePath }))
    expect(second.list()).toEqual([])
    expect(second.list({ includeRevoked: true })).toHaveLength(1)
  })

  it('半份 JSON 当没有：坏文件不能拖垮启动', () => {
    const dir = tempDir()
    const filePath = join(dir, 'credentials.json')
    writeFileSync(filePath, '{ "credentials": [', 'utf8')
    const registry = registryOf(new FileCredentialStore({ filePath }))
    expect(registry.list()).toEqual([])
  })

  it('文件里是 null 或缺 credentials 字段：都当没有', () => {
    const dir = tempDir()
    const nullPath = join(dir, 'null.json')
    writeFileSync(nullPath, 'null', 'utf8')
    expect(new FileCredentialStore({ filePath: nullPath }).load()).toEqual([])
    const emptyPath = join(dir, 'empty.json')
    writeFileSync(emptyPath, '{}', 'utf8')
    expect(new FileCredentialStore({ filePath: emptyPath }).load()).toEqual([])
  })

  it('写不进去时要报错，不能假装存上了', () => {
    const dir = tempDir()
    const target = join(dir, 'as-a-directory')
    mkdirSync(target, { recursive: true })
    const store = new FileCredentialStore({ filePath: target })
    expect(() =>
      store.save([{ ref: { id: 'cred-1', providerId: 'github', label: 'GitHub', createdAt: 1 }, revoked: false }]),
    ).toThrowError()
  })

  it('缺字段的那条被丢掉', () => {
    const dir = tempDir()
    const filePath = join(dir, 'credentials.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        credentials: [
          { ref: { id: 'ok', providerId: 'github', label: 'GitHub', createdAt: 1 }, revoked: false },
          { ref: { providerId: 'github', label: '缺 id', createdAt: 1 }, revoked: false },
          { ref: { id: 'x', label: '缺供应商', createdAt: 1 }, revoked: false },
          { ref: { id: 'y', providerId: 'github', createdAt: 1 }, revoked: false },
          { ref: { id: 'z', providerId: 'github', label: '时间不对', createdAt: 'x' }, revoked: false },
          { ref: '不是对象', revoked: false },
          '整条不是对象',
        ],
      }),
      'utf8',
    )
    const registry = registryOf(new FileCredentialStore({ filePath }))
    expect(registry.list().map((ref) => ref.id)).toEqual(['ok'])
  })
})
