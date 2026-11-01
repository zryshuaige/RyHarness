/**
 * 服务：登记、读取、编辑、版本化、热生效与回滚。
 *
 * 这层最要紧的两条规矩各有各的用例：
 *   - 版本对不上要**报冲突**，不能静默盖掉别人刚改的东西；
 *   - `apply` 抛错要**回滚**，不能出现「界面显示新值、插件还跑着旧值」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSettingsStore,
  SettingsError,
  type SettingsSchema,
  SettingsService,
  type SettingsValues,
} from '../src/index.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-settings-'))
  dirs.push(dir)
  return dir
}

const schema: SettingsSchema = {
  type: 'object',
  properties: {
    verbose: { type: 'boolean', title: '调试日志', default: false },
    timeout: { type: 'number', title: '超时', default: 30_000, minimum: 1 },
    mode: { type: 'select', title: '模式', enum: ['fast', 'safe'], default: 'safe' },
  },
}

/** 建服务：顺带记下 apply 收到的值。 */
function serviceOf(options: { apply?: (id: string, values: SettingsValues) => void | Promise<void> } = {}) {
  const applied: { id: string; values: SettingsValues }[] = []
  const service = new SettingsService({
    apply: (id: string, values: SettingsValues) => {
      applied.push({ id, values })
      return options.apply?.(id, values)
    },
  })
  return { service, applied }
}

describe('登记与读取', () => {
  it('登记后能读到描述符、当前值与版本号', () => {
    const { service } = serviceOf()
    const view = service.register('demo', schema)
    expect(view.pluginId).toBe('demo')
    expect(view.descriptors.map((descriptor) => descriptor.key)).toEqual(['verbose', 'timeout', 'mode'])
    expect(view.values).toEqual({ verbose: false, timeout: 30_000, mode: 'safe' })
    expect(view.revision).toBe(0)
  })

  it('宿主给的值压过 schema 的默认值', () => {
    const { service } = serviceOf()
    const view = service.register('demo', schema, { verbose: true })
    expect(view.values.verbose).toBe(true)
    expect(view.values.timeout).toBe(30_000)
  })

  it('宿主给的值不合法就说清是哪个字段', () => {
    const { service } = serviceOf()
    try {
      service.register('demo', schema, { timeout: 'soon' })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof SettingsError).toBe(true)
      if (!(error instanceof SettingsError)) return
      expect(error.code).toBe('VALIDATION')
      expect(error.field).toBe('timeout')
    }
  })

  it('同一个插件登记两遍要报错', () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    expect(() => service.register('demo', schema)).toThrowError(/已经登记过/)
  })

  it('list 列出所有登记过的插件', () => {
    const { service } = serviceOf()
    service.register('a', schema)
    service.register('b', schema)
    expect(service.list().map((view) => view.pluginId)).toEqual(['a', 'b'])
  })

  it('取不存在的插件报 UNKNOWN_PLUGIN', () => {
    const { service } = serviceOf()
    expect(() => service.get('nope')).toThrowError(SettingsError)
  })
})

describe('编辑', () => {
  it('改完值变新、版本号 +1', async () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    const view = await service.update('demo', { values: { verbose: true } })
    expect(view.values.verbose).toBe(true)
    expect(view.values.timeout).toBe(30_000)
    expect(view.revision).toBe(1)
  })

  it('版本号对得上才放行', async () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    await service.update('demo', { values: { verbose: true }, revision: 0 })
    const view = await service.update('demo', { values: { timeout: 10 }, revision: 1 })
    expect(view.revision).toBe(2)
  })

  it('版本号对不上报冲突，并带上当前版本让界面重新拉', async () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    await service.update('demo', { values: { verbose: true } })
    try {
      await service.update('demo', { values: { timeout: 10 }, revision: 0 })
      expect.unreachable('应该报冲突')
    } catch (error) {
      expect(error instanceof SettingsError).toBe(true)
      if (!(error instanceof SettingsError)) return
      expect(error.code).toBe('CONFLICT')
      expect(error.revision).toBe(1)
    }
    // 冲突之后值没被动过：不能因为一次冲突就把别人的改动盖了。
    expect(service.get('demo').values.verbose).toBe(true)
  })

  it('值不合法时报出是哪个字段，且不改任何值', async () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    await expect(service.update('demo', { values: { mode: 'turbo' } })).rejects.toThrowError(/mode/)
    expect(service.get('demo').revision).toBe(0)
    expect(service.get('demo').values.mode).toBe('safe')
  })

  it('改一个没登记的插件要报错', async () => {
    const { service } = serviceOf()
    await expect(service.update('nope', { values: { verbose: true } })).rejects.toThrowError(/没有这个插件/)
  })

  it('改不存在的配置项要被拦下', async () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    await expect(service.update('demo', { values: { timout: 10 } })).rejects.toThrowError(/没有这个配置项/)
  })

  it('落盘失败时值回滚，并把旧值重新应用回去', async () => {
    const applied: SettingsValues[] = []
    const service = new SettingsService({
      apply: (_id, values) => {
        applied.push(values)
      },
      store: {
        load: () => [],
        save: () => {
          throw new Error('磁盘满了')
        },
      },
    })
    service.register('demo', schema)
    await expect(service.update('demo', { values: { verbose: true } })).rejects.toThrowError(/没保存下来/)
    const view = service.get('demo')
    expect(view.values.verbose).toBe(false)
    expect(view.revision).toBe(0)
    // 旧值要重新应用到活着的插件上：不然界面退回旧值、插件还跑着新值。
    expect(applied).toHaveLength(2)
    expect(applied[1]?.verbose).toBe(false)
  })

  it('落盘失败时没有 apply 回调也要回滚', async () => {
    const service = new SettingsService({
      store: {
        load: () => [],
        save: () => {
          throw new Error('磁盘满了')
        },
      },
    })
    service.register('demo', schema)
    await expect(service.update('demo', { values: { verbose: true } })).rejects.toThrowError(/没保存下来/)
    expect(service.get('demo').values.verbose).toBe(false)
    expect(service.get('demo').revision).toBe(0)
  })

  it('改完会调宿主的 apply 回调，把整份新值交出去', async () => {
    const { service, applied } = serviceOf()
    service.register('demo', schema)
    await service.update('demo', { values: { verbose: true } })
    expect(applied).toHaveLength(1)
    expect(applied[0]?.id).toBe('demo')
    expect(applied[0]?.values).toEqual({ verbose: true, timeout: 30_000, mode: 'safe' })
  })

  it('apply 抛错时值回滚：不留下「界面新值、插件旧值」', async () => {
    const { service } = serviceOf({
      apply: () => {
        throw new Error('插件不认这个值')
      },
    })
    service.register('demo', schema)
    await expect(service.update('demo', { values: { verbose: true } })).rejects.toThrowError(/没生效/)
    const view = service.get('demo')
    expect(view.values.verbose).toBe(false)
    expect(view.revision).toBe(0)
  })

  it('apply 抛错时错误码是 APPLY_FAILED', async () => {
    const { service } = serviceOf({
      apply: () => {
        throw new Error('炸了')
      },
    })
    service.register('demo', schema)
    try {
      await service.update('demo', { values: { verbose: true } })
      expect.unreachable('应该报错')
    } catch (error) {
      expect(error instanceof SettingsError ? error.code : '').toBe('APPLY_FAILED')
    }
  })

  it('注销插件后它就不在清单里了', () => {
    const { service } = serviceOf()
    service.register('demo', schema)
    expect(service.unregister('demo')).toBe(true)
    expect(service.list()).toEqual([])
    expect(service.unregister('demo')).toBe(false)
  })

  it('注销插件时落盘里的那份也一并清掉', async () => {
    const dir = tempDir()
    const filePath = join(dir, 'plugin-settings.json')
    const service = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    service.register('demo', schema)
    await service.update('demo', { values: { verbose: true } })
    service.unregister('demo')
    const store = new FileSettingsStore({ filePath })
    expect(store.load()).toEqual([])
  })
})

describe('落盘', () => {
  it('改过的值落盘，重启后读回来', async () => {
    const dir = tempDir()
    const filePath = join(dir, 'config', 'plugin-settings.json')
    const first = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    first.register('demo', schema)
    await first.update('demo', { values: { verbose: true } })

    const second = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    const view = second.register('demo', schema)
    expect(view.values.verbose).toBe(true)
    expect(view.revision).toBe(1)
    // 再改一次：这次落盘时，已登记的插件不能被旧状态盖掉。
    const updated = await second.update('demo', { values: { timeout: 9 }, revision: 1 })
    expect(updated.values.verbose).toBe(true)
    expect(updated.values.timeout).toBe(9)
    const third = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    expect(third.register('demo', schema).values.timeout).toBe(9)
  })

  it('落盘的值压过宿主给的初值：用户改过的算数', async () => {
    const dir = tempDir()
    const filePath = join(dir, 'plugin-settings.json')
    const first = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    first.register('demo', schema)
    await first.update('demo', { values: { timeout: 5 } })

    const second = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    const view = second.register('demo', schema, { timeout: 99 })
    expect(view.values.timeout).toBe(5)
  })

  it('schema 改过之后认不得的旧值会被丢掉，退回默认值', async () => {
    const dir = tempDir()
    const filePath = join(dir, 'plugin-settings.json')
    const first = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    first.register('demo', schema)
    await first.update('demo', { values: { timeout: 5 } })

    const second = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    const view = second.register('demo', {
      type: 'object',
      properties: { timeout: { type: 'string', title: '超时' } },
    })
    expect(view.values.timeout).toBeUndefined()
  })

  it('还没登记的插件，它的落盘状态不会被下一次保存抹掉', async () => {
    const dir = tempDir()
    const filePath = join(dir, 'plugin-settings.json')
    const first = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    first.register('demo', schema)
    await first.update('demo', { values: { verbose: true } })

    // 第二次启动时先登记的是别的插件：demo 的状态还在，只是暂时没人读。
    const second = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    second.register('other', schema)
    await second.update('other', { values: { timeout: 1 } })

    const third = new SettingsService({ store: new FileSettingsStore({ filePath }) })
    const view = third.register('demo', schema)
    expect(view.values.verbose).toBe(true)
  })
})
