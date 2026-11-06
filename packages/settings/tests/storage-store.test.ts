/**
 * 配置的存储后端：新后端（storage）与老文件之间的迁移。
 *
 * 这一族盯的是「用户改过的配置不能丢」：搬一次、搬对了、搬完老文件留底、
 * 新后端已经有数据时**不再搬**（否则会把用户改过的盖回旧值）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonBackend, StorageService } from '@ryharness/storage'
import { afterEach, describe, expect, it } from 'vitest'
import { MigratingSettingsStore, StorageSettingsStore } from '../src/index.ts'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-setstore-'))
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

/** 造一份老格式的配置文件。 */
function writeLegacy(dir: string, plugins: unknown[]): string {
  const path = join(dir, 'plugin-settings.json')
  writeFileSync(path, JSON.stringify({ plugins }), 'utf8')
  return path
}

describe('配置的 storage 后端', () => {
  it('写进去读得回来，每个插件一条记录', () => {
    const service = makeService()
    const store = new StorageSettingsStore(service)
    store.save([
      { pluginId: 'web', values: { backend: 'x' }, revision: 3 },
      { pluginId: 'lsp', values: { enabled: true }, revision: 1 },
    ])
    const loaded = store.load()
    expect(loaded).toHaveLength(2)
    const web = loaded.find((snapshot) => snapshot.pluginId === 'web')
    expect(web?.values).toEqual({ backend: 'x' })
    expect(web?.revision).toBe(3)
  })

  it('整体覆盖：这次没有的插件要被删掉', () => {
    const service = makeService()
    const store = new StorageSettingsStore(service)
    store.save([
      { pluginId: 'a', values: { v: 1 }, revision: 1 },
      { pluginId: 'b', values: { v: 2 }, revision: 1 },
    ])
    store.save([{ pluginId: 'a', values: { v: 9 }, revision: 2 }])
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('a')
  })

  it('没有配置时读出空列表，不报错', () => {
    const store = new StorageSettingsStore(makeService())
    expect(store.load()).toEqual([])
  })

  it('坏记录被丢掉，不把整个配置带崩', () => {
    const service = makeService()
    // 塞三条坏数据进去：不是对象、版本号不是数、值不是对象。
    service.put('plugin-settings', 'bad-1', '这不是对象')
    service.put('plugin-settings', 'bad-2', { revision: '不是数', values: {} })
    service.put('plugin-settings', 'bad-3', { revision: 1, values: '不是对象' })
    service.put('plugin-settings', 'good', { revision: 2, values: { a: 1 } })

    const loaded = new StorageSettingsStore(service).load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('good')
  })

  it('值里不是布尔/字符串/数字的键被丢掉', () => {
    const service = makeService()
    service.put('plugin-settings', 'mixed', {
      revision: 1,
      values: { good: '行', bad: { nested: true }, alsoBad: null },
    })
    const loaded = new StorageSettingsStore(service).load()
    expect(loaded[0]?.values).toEqual({ good: '行' })
  })
})

describe('从老文件迁移', () => {
  it('老文件在的时候搬过去，并且老文件改名留底（不删）', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [{ pluginId: 'web', values: { backend: 'x' }, revision: 2 }])
    const service = makeService()
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(service),
      legacyFilePath: legacyPath,
    })

    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('web')
    expect(loaded[0]?.revision).toBe(2)
    // 老文件改名留底：数据还在，但不再是会被再搬一次的那个。
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true)
  })

  it('老文件的内容真搬进了新后端（不是只在内存里）', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [{ pluginId: 'web', values: { backend: 'x' }, revision: 2 }])
    const root = tempDir()
    const service = new StorageService({ backends: [new JsonBackend({ root })] })
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(service),
      legacyFilePath: legacyPath,
    })
    store.load()

    // 换一个服务实例读同一个后端：数据还在。
    const reopened = new StorageService({ backends: [new JsonBackend({ root })] })
    const loaded = new StorageSettingsStore(reopened).load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('web')
  })

  it('新后端已经有数据时**不再搬**：用户改过的配置不能被旧值盖掉', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [{ pluginId: 'web', values: { backend: '旧值' }, revision: 1 }])
    const service = makeService()
    const target = new StorageSettingsStore(service)
    // 用户已经在新后端里改过了。
    target.save([{ pluginId: 'web', values: { backend: '新值' }, revision: 9 }])

    const store = new MigratingSettingsStore({ target, legacyFilePath: legacyPath })
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.values).toEqual({ backend: '新值' })
    expect(loaded[0]?.revision).toBe(9)
    // 老文件也别动：没搬就不该改名。
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('老文件坏了就当没有：读得出空列表，不让启动失败', () => {
    const dir = tempDir()
    const legacyPath = join(dir, 'plugin-settings.json')
    writeFileSync(legacyPath, '{ 这不是 JSON', 'utf8')
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(makeService()),
      legacyFilePath: legacyPath,
    })
    expect(store.load()).toEqual([])
  })

  it('没有老文件就直接用新后端', () => {
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(makeService()),
      legacyFilePath: join(tempDir(), 'not-there.json'),
    })
    expect(store.load()).toEqual([])
  })

  it('老文件里的坏行被丢掉，好行照样搬', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [
      { pluginId: 'good', values: { a: 1 }, revision: 1 },
      { pluginId: '', values: {}, revision: 1 },
      { pluginId: 'no-revision', values: {} },
      'not-an-object',
    ])
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(makeService()),
      legacyFilePath: legacyPath,
    })
    const loaded = store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('good')
    // 搬完老文件是留底（改名），内容不变。
    expect(readFileSync(`${legacyPath}.migrated`, 'utf8')).toContain('good')
  })
})

/**
 * 老文件的几种「读得出来但不是配置」的样子。
 *
 * 这些分支以前没人走过，于是「老文件是坏的」这件事只有一种坏法（不是 JSON）。
 * 用户手改过这个文件、他人的同步工具写进去过、别的程序占用过——出来的形状不止一种，
 * 哪一种都不该让应用开不了机。
 */
describe('老文件读不出来的那几种形状', () => {
  /** 造一份内容不是数组的老文件，返回它的路径。 */
  function writeRaw(dir: string, content: string): string {
    const path = join(dir, 'plugin-settings.json')
    writeFileSync(path, content, 'utf8')
    return path
  }

  /** 建一个迁移存储，老文件在指定路径。 */
  function makeStore(legacyPath: string): MigratingSettingsStore {
    return new MigratingSettingsStore({
      target: new StorageSettingsStore(makeService()),
      legacyFilePath: legacyPath,
    })
  }

  it('老文件整个不是对象：当成没有', () => {
    const path = writeRaw(tempDir(), '123')
    expect(makeStore(path).load()).toEqual([])
  })

  it('老文件是 null：当成没有', () => {
    const path = writeRaw(tempDir(), 'null')
    expect(makeStore(path).load()).toEqual([])
  })

  it('老文件里没有 plugins 这一段：当成没有', () => {
    const path = writeRaw(tempDir(), '{"别的":1}')
    expect(makeStore(path).load()).toEqual([])
  })

  it('plugins 不是数组：当成没有', () => {
    const path = writeRaw(tempDir(), '{"plugins":{"web":{}}}')
    expect(makeStore(path).load()).toEqual([])
  })

  it('某条记录的值不是对象：这条被丢掉，其它照搬', () => {
    const path = writeRaw(
      tempDir(),
      JSON.stringify({
        plugins: [
          { pluginId: 'good', values: { a: 1 }, revision: 1 },
          { pluginId: 'bad', values: '不是对象', revision: 1 },
        ],
      }),
    )
    const loaded = makeStore(path).load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.pluginId).toBe('good')
  })

  it('值里不是布尔/字符串/数字的键被丢掉', () => {
    const path = writeRaw(
      tempDir(),
      JSON.stringify({
        plugins: [{ pluginId: 'web', values: { good: '行', bad: { nested: 1 }, worse: null }, revision: 1 }],
      }),
    )
    const loaded = makeStore(path).load()
    expect(loaded[0]?.values).toEqual({ good: '行' })
  })
})

describe('迁移搬不动的时候', () => {
  it('新后端写失败就当没搬：老文件留着，下次启动再试', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [{ pluginId: 'web', values: { backend: 'x' }, revision: 2 }])
    const failing = {
      load: () => [],
      save: () => {
        throw new Error('后端不可写')
      },
    }
    const store = new MigratingSettingsStore({ target: failing, legacyFilePath: legacyPath })
    expect(store.load()).toEqual([])
    // 没搬成，就不该改名：老文件还在原处。
    expect(existsSync(legacyPath)).toBe(true)
    expect(existsSync(`${legacyPath}.migrated`)).toBe(false)
  })

  it('搬的时候老文件已经没了：留底那一步直接跳过，不报错', () => {
    const dir = tempDir()
    const legacyPath = writeLegacy(dir, [{ pluginId: 'web', values: { backend: 'x' }, revision: 2 }])
    // 搬过去的瞬间把老文件删掉——留底那一步就撞上「文件已经不在」。
    const removing = {
      load: () => [],
      save: (snapshots: readonly { pluginId: string; values: Record<string, unknown>; revision: number }[]) => {
        rmSync(legacyPath, { force: true })
        void snapshots
      },
    }
    const store = new MigratingSettingsStore({ target: removing, legacyFilePath: legacyPath })
    expect(store.load()).toHaveLength(1)
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.migrated`)).toBe(false)
  })

  it('迁移存储自己也能存：写进去的就是新后端那份', () => {
    const service = makeService()
    const store = new MigratingSettingsStore({
      target: new StorageSettingsStore(service),
      legacyFilePath: join(tempDir(), 'not-there.json'),
    })
    store.save([{ pluginId: 'web', values: { backend: 'x' }, revision: 1 }])
    expect(new StorageSettingsStore(service).load()).toHaveLength(1)
  })
})
