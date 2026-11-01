/**
 * 存取后端：内存的与文件的。
 *
 * 文件后端的两条底线：写坏了不能拖垮启动（半份 JSON 当没有），写一半崩了不能留下
 * 半份数据（临时文件 + rename）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSettingsStore, MemorySettingsStore } from '../src/index.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-settings-store-'))
  dirs.push(dir)
  return dir
}

describe('内存后端', () => {
  it('存进去再读出来是同一份', () => {
    const store = new MemorySettingsStore()
    store.save([{ pluginId: 'demo', values: { verbose: true }, revision: 2 }])
    expect(store.load()).toEqual([{ pluginId: 'demo', values: { verbose: true }, revision: 2 }])
  })

  it('读出来的副本改了不影响存的那份', () => {
    const store = new MemorySettingsStore()
    store.save([{ pluginId: 'demo', values: { verbose: true }, revision: 1 }])
    const loaded = store.load()
    const first = loaded[0]
    if (first === undefined) throw new Error('没有读到状态')
    first.values.verbose = false
    expect(store.load()[0]?.values.verbose).toBe(true)
  })
})

describe('文件后端', () => {
  it('文件不存在时读到空清单', () => {
    const dir = tempDir()
    const store = new FileSettingsStore({ filePath: join(dir, 'missing.json') })
    expect(store.load()).toEqual([])
  })

  it('存完读回来是同一份', () => {
    const dir = tempDir()
    const filePath = join(dir, 'nested', 'settings.json')
    const store = new FileSettingsStore({ filePath })
    store.save([{ pluginId: 'demo', values: { verbose: true, timeout: 10 }, revision: 3 }])
    expect(existsSync(filePath)).toBe(true)
    expect(store.load()).toEqual([{ pluginId: 'demo', values: { verbose: true, timeout: 10 }, revision: 3 }])
  })

  it('半份 JSON 当没有：坏文件不能拖垮启动', () => {
    const dir = tempDir()
    const filePath = join(dir, 'settings.json')
    writeFileSync(filePath, '{ "plugins": [', 'utf8')
    const store = new FileSettingsStore({ filePath })
    expect(store.load()).toEqual([])
  })

  it('文件里是 null 或缺 plugins 字段：都当没有', () => {
    const dir = tempDir()
    const nullPath = join(dir, 'null.json')
    writeFileSync(nullPath, 'null', 'utf8')
    expect(new FileSettingsStore({ filePath: nullPath }).load()).toEqual([])
    const emptyPath = join(dir, 'empty.json')
    writeFileSync(emptyPath, '{}', 'utf8')
    expect(new FileSettingsStore({ filePath: emptyPath }).load()).toEqual([])
  })

  it('写不进去时要报错，不能假装存上了', () => {
    const dir = tempDir()
    const target = join(dir, 'as-a-directory')
    mkdirSync(target, { recursive: true })
    const store = new FileSettingsStore({ filePath: target })
    expect(() => store.save([{ pluginId: 'demo', values: {}, revision: 0 }])).toThrowError()
  })

  it('缺字段的那条被丢掉，其余照旧', () => {
    const dir = tempDir()
    const filePath = join(dir, 'settings.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        plugins: [
          { pluginId: 'ok', values: { a: 1 }, revision: 1 },
          { values: { a: 1 }, revision: 1 },
          { pluginId: 'bad', values: { a: 1 } },
          { pluginId: 'bad2', values: { a: 1 }, revision: 'x' },
          { pluginId: 'bad3', values: '不是对象', revision: 1 },
          { pluginId: 'bad4', values: null, revision: 1 },
          '整条不是对象',
        ],
      }),
      'utf8',
    )
    const store = new FileSettingsStore({ filePath })
    expect(store.load()).toEqual([{ pluginId: 'ok', values: { a: 1 }, revision: 1 }])
  })

  it('写完不留临时文件', () => {
    const dir = tempDir()
    const filePath = join(dir, 'settings.json')
    const store = new FileSettingsStore({ filePath })
    store.save([{ pluginId: 'demo', values: {}, revision: 0 }])
    const contents = readFileSync(filePath, 'utf8')
    expect(contents).toContain('"pluginId": "demo"')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })
})
