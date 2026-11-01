/**
 * 进程范围：一组进程归谁管。
 *
 * 「归谁管」的责任是可测的：整组终止之后，组里每个进程都该是 terminated，
 * 一个都不该还活着。
 */
import { describe, expect, it } from 'vitest'
import { createProcessRange, SubprocessService, spawnManaged } from '../src/index.ts'

/** 起一个会一直睡着的进程。 */
function sleeper(): ReturnType<typeof spawnManaged> {
  return spawnManaged({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    resolve: false,
  })
}

describe('进程范围', () => {
  it('新范围是空的，档位默认是模拟托管', () => {
    const range = createProcessRange({ label: '测试组' })

    expect(range.list()).toEqual([])
    expect(range.alive()).toEqual([])
    expect(range.support).toBe('emulated')
    expect(range.label).toBe('测试组')
  })

  it('add / remove / list 都按预期', async () => {
    const range = createProcessRange()
    const proc = sleeper()
    try {
      range.add(proc)
      expect(range.list()).toHaveLength(1)
      expect(range.alive()).toHaveLength(1)

      range.remove(proc)
      expect(range.list()).toHaveLength(0)
      expect(range.alive()).toHaveLength(0)
    } finally {
      await proc.kill('清理')
    }
  })

  it('整体终止：组里所有进程都被收掉', async () => {
    const range = createProcessRange()
    const first = sleeper()
    const second = sleeper()
    range.add(first)
    range.add(second)

    await range.terminate('整组收')

    expect((await first.done).status).toBe('terminated')
    expect((await second.done).status).toBe('terminated')
    expect(range.alive()).toHaveLength(0)
  })

  it('结束了的进程不算「还活着」', async () => {
    const range = createProcessRange()
    const proc = spawnManaged({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      resolve: false,
    })
    range.add(proc)
    await proc.done

    expect(range.list()).toHaveLength(1)
    expect(range.alive()).toHaveLength(0)
  })

  it('服务建的范围跟着 provider 的能力走：没有原生托管就是模拟', () => {
    const service = new SubprocessService()
    const range = service.createRange('一组任务')

    expect(range.support).toBe('emulated')
    expect(range.notes.length).toBeGreaterThan(0)
    expect(range.notes.join(' ')).toMatch(/taskkill|cgroup/)
  })

  it('服务按 rangeId 把进程归到范围里', async () => {
    const service = new SubprocessService()
    const range = service.createRange('一组任务')
    const proc = service.spawn({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      rangeId: range.id,
      resolve: false,
    })

    try {
      expect(range.list()).toHaveLength(1)
      expect(range.alive()).toHaveLength(1)
    } finally {
      await proc.kill('清理')
    }
  })

  it('给了没建过的 rangeId：现建一个范围并把进程放进去', async () => {
    const service = new SubprocessService()
    const proc = service.spawn({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      rangeId: '临时组',
      resolve: false,
    })

    try {
      const range = service.getRange('临时组')
      expect(range).toBeDefined()
      expect(range?.list()).toHaveLength(1)
      expect(range?.support).toBe('emulated')
    } finally {
      await proc.kill('清理')
    }
  })

  it('没给名字的范围：叫「未命名范围」', () => {
    const service = new SubprocessService()
    const range = service.createRange()

    expect(range.label).toBe('未命名范围')
  })
})
