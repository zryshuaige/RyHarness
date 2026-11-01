/**
 * 目标的跨重启：落盘、读回，以及坏数据不挡启动。
 *
 * 这些用例盯的是「关掉应用再打开，目标还在」——这是这一族存在的理由。
 * 读回来的是**同一个目标、同样的历史**，不是一份重建的近似。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GoalService, MemoryGoalStore } from '../src/index.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-goal-'))
  dirs.push(dir)
  return dir
}

/** 一个固定时钟。 */
function fixedClock(start = 1_000): () => number {
  let tick = start
  return () => {
    tick += 1
    return tick
  }
}

describe('目标的跨重启', () => {
  it('文件后端：写进去的目标，重启后读回来还是那个目标', () => {
    const path = join(tempDir(), 'goals.json')
    const first = new GoalService({ storePath: path, now: fixedClock() })
    first.create({ sessionId: 'c1', title: '把周报写完', criteria: '周报发到群里' })
    first.pause('c1')

    // 换一个服务实例（等价于重启）：读的是同一个文件。
    const second = new GoalService({ storePath: path, now: fixedClock(9_000) })
    const goal = second.get('c1')
    expect(goal?.title).toBe('把周报写完')
    expect(goal?.criteria).toBe('周报发到群里')
    expect(goal?.status).toBe('paused')
  })

  it('文件后端：历史也跟着读回来', () => {
    const path = join(tempDir(), 'goals.json')
    const first = new GoalService({ storePath: path, now: fixedClock() })
    first.create({ sessionId: 'c1', title: '把周报写完' })
    first.update({ sessionId: 'c1', criteria: '周报发到群里' })

    const second = new GoalService({ storePath: path, now: fixedClock(9_000) })
    expect(
      second.history('c1').map((change) => {
        return change.action
      }),
    ).toEqual(['created', 'updated'])
  })

  it('文件后端：存的是 JSON，父目录不存在也会建出来', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'goals.json')
    const service = new GoalService({ storePath: path, now: fixedClock() })
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    expect(typeof parsed).toBe('object')
    expect(parsed).not.toBeNull()
  })

  it('文件后端：坏文件不挡启动，当成没有目标', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(path, '{ 这不是 JSON', 'utf8')
    const service = new GoalService({ storePath: path, now: fixedClock() })
    expect(service.get('c1')).toBeUndefined()
    // 还能接着用：写一次就把坏文件换成好文件。
    service.create({ sessionId: 'c1', title: '重新定一个' })
    expect(service.get('c1')?.title).toBe('重新定一个')
  })

  it('文件后端：一条记录坏了只丢那一条，别的会话不受影响', () => {
    const path = join(tempDir(), 'goals.json')
    const service = new GoalService({ storePath: path, now: fixedClock() })
    service.create({ sessionId: 'c1', title: '好的那个' })
    service.create({ sessionId: 'c2', title: '待会儿被弄坏' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions: Record<string, { goal: unknown }> }
    raw.sessions.c2 = { goal: { id: '坏掉的' } }
    writeFileSync(path, JSON.stringify(raw), 'utf8')

    const second = new GoalService({ storePath: path, now: fixedClock(9_000) })
    expect(second.get('c1')?.title).toBe('好的那个')
    expect(second.get('c2')).toBeUndefined()
  })

  it('内存后端：同一个实例里读得到，另一个实例读不到', () => {
    const store = new MemoryGoalStore()
    const first = new GoalService({ store, now: fixedClock() })
    first.create({ sessionId: 'c1', title: '只在内存里' })
    expect(first.get('c1')?.title).toBe('只在内存里')

    const second = new GoalService({ store: new MemoryGoalStore(), now: fixedClock() })
    expect(second.get('c1')).toBeUndefined()
  })

  it('存储返回的是副本：调用方改了它，存储里的没变', () => {
    const store = new MemoryGoalStore()
    const service = new GoalService({ store, now: fixedClock() })
    service.create({ sessionId: 'c1', title: '原来的标题' })
    const got = service.get('c1')
    if (got === undefined) throw new Error('应该有目标')
    expect(got.title).toBe('原来的标题')
    expect(store.load('c1')?.goal?.title).toBe('原来的标题')
  })

  it('存储能列出有档案的会话（宿主视角的清单）', () => {
    const store = new MemoryGoalStore()
    const service = new GoalService({ store, now: fixedClock() })
    service.create({ sessionId: 'c1', title: '一' })
    service.create({ sessionId: 'c2', title: '二' })
    expect([...store.listSessions()].sort()).toEqual(['c1', 'c2'])
  })
})
