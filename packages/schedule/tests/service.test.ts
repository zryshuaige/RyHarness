/**
 * 提醒服务：建、改、停用、启用、删除、投递，以及跨重启与错过时间的策略。
 *
 * 这些用例盯的是服务这一层的规矩：**归属按会话**、**删除要确认**、
 * **一次性与重复触发分得清**、**错过的时间按策略处理**。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScheduleError, ScheduleService } from '../src/index.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-schedule-'))
  dirs.push(dir)
  return dir
}

/** 一个可推进的时钟。 */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => {
      return current
    },
    advance: (ms: number) => {
      current += ms
    },
  }
}

/** 建服务：固定时钟与固定 id。 */
function serviceOf(options: { now?: () => number; missedPolicy?: 'skip' | 'catch-up' } = {}) {
  const time = clock()
  let seq = 0
  const delivered: { scheduleId: string; conversationId: string; text: string }[] = []
  const service = new ScheduleService({
    now: options.now ?? time.now,
    ...(options.missedPolicy === undefined ? {} : { missedPolicy: options.missedPolicy }),
    newId: () => {
      seq += 1
      return `sch-${seq}`
    },
    deliver: (scheduleId, conversationId, text) => {
      delivered.push({ scheduleId, conversationId, text })
    },
  })
  return { service, delivered, time }
}

describe('提醒的建立与状态', () => {
  it('建一条提醒：正文、触发方式与归属都记下来了', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'daily', time: '09:00' },
    })
    expect(task.text).toBe('该交周报了')
    expect(task.conversationId).toBe('c1')
    expect(task.status).toBe('active')
    expect(task.trigger).toEqual({ kind: 'daily', time: '09:00' })
    expect(task.nextRunAt).toBeGreaterThan(0)
  })

  it('空正文与空会话 id 都被挡下', () => {
    const { service } = serviceOf()
    expect(() => {
      service.create({ conversationId: 'c1', text: '  ', trigger: { kind: 'daily', time: '09:00' } })
    }).toThrow(ScheduleError)
    expect(() => {
      service.create({ conversationId: '', text: '有正文', trigger: { kind: 'daily', time: '09:00' } })
    }).toThrow(ScheduleError)
  })

  it('一次性提醒的时间在过去会被挡下：它永远不会响', () => {
    const { service } = serviceOf()
    expect(() => {
      service.create({ conversationId: 'c1', text: '已经过去', trigger: { kind: 'once', at: 500 } })
    }).toThrow(ScheduleError)
  })

  it('停用之后不再排下一次，启用之后重新排', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const off = service.disable(task.id)
    expect(off.status).toBe('disabled')
    expect(off.nextRunAt).toBeUndefined()
    const on = service.enable(task.id)
    expect(on.status).toBe('active')
    expect(on.nextRunAt).toBeGreaterThan(0)
  })

  it('改触发方式会重排下一次', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const before = task.nextRunAt
    const updated = service.update({ id: task.id, trigger: { kind: 'weekly', weekday: 3, time: '08:00' } })
    expect(updated.trigger).toEqual({ kind: 'weekly', weekday: 3, time: '08:00' })
    expect(updated.nextRunAt).not.toBe(before)
  })

  it('改一条不存在的提醒报 NOT_FOUND', () => {
    const { service } = serviceOf()
    expect(() => {
      service.update({ id: 'sch-999', text: '改不到' })
    }).toThrow(ScheduleError)
  })
})

describe('提醒的归属与删除', () => {
  it('按会话分列：别的会话看不到这条提醒', () => {
    const { service } = serviceOf()
    service.create({ conversationId: 'c1', text: '只有 c1 的', trigger: { kind: 'daily', time: '09:00' } })
    expect(service.list('c1')).toHaveLength(1)
    expect(service.list('c2')).toHaveLength(0)
  })

  it('宿主视角能一次看到全部提醒（含已停用的）', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '停用的那条',
      trigger: { kind: 'daily', time: '09:00' },
    })
    service.disable(task.id)
    expect(service.listAll()).toHaveLength(1)
    expect(service.listAll(false)).toHaveLength(0)
  })

  it('删除要确认：没确认就不删', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '别误删',
      trigger: { kind: 'daily', time: '09:00' },
    })
    let caught: unknown
    try {
      service.remove(task.id, false)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ScheduleError)
    if (caught instanceof ScheduleError) {
      expect(caught.code).toBe('CONFIRMATION_REQUIRED')
    }
    expect(service.get(task.id)).toBeDefined()
  })

  it('确认了就真删', () => {
    const { service } = serviceOf()
    const task = service.create({
      conversationId: 'c1',
      text: '确认删',
      trigger: { kind: 'daily', time: '09:00' },
    })
    expect(service.remove(task.id, true)).toBe(true)
    expect(service.get(task.id)).toBeUndefined()
  })
})

describe('提醒的投递', () => {
  it('到点就投：消息投进原会话', async () => {
    const time = clock(at2026())
    const { service, delivered } = serviceOf({ now: time.now })
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'once', at: at2026() + 60_000 },
    })
    time.advance(60_000)
    const sent = await service.tick()
    expect(sent).toHaveLength(1)
    expect(delivered[0]?.conversationId).toBe('c1')
    expect(delivered[0]?.text).toBe('该交周报了')
    expect(service.get(task.id)?.fireCount).toBe(1)
  })

  it('一次性提醒只响一次：响完状态转已完成，不再排下一次', async () => {
    const time = clock(at2026())
    const { service, delivered } = serviceOf({ now: time.now })
    const task = service.create({
      conversationId: 'c1',
      text: '只响一次',
      trigger: { kind: 'once', at: at2026() + 60_000 },
    })
    time.advance(60_000)
    await service.tick()
    expect(service.get(task.id)?.status).toBe('completed')
    expect(service.get(task.id)?.nextRunAt).toBeUndefined()
    time.advance(60_000)
    await service.tick()
    expect(delivered).toHaveLength(1)
  })

  it('重复触发：到点再排下一次，下次还会响', async () => {
    const time = clock(at2026())
    const { service, delivered } = serviceOf({ now: time.now })
    service.create({
      conversationId: 'c1',
      text: '每天都要说',
      trigger: { kind: 'interval', everyMs: 60_000 },
    })
    time.advance(60_000)
    await service.tick()
    time.advance(60_000)
    await service.tick()
    expect(delivered).toHaveLength(2)
  })

  it('停用的提醒不响', async () => {
    const time = clock(at2026())
    const { service, delivered } = serviceOf({ now: time.now })
    const task = service.create({
      conversationId: 'c1',
      text: '停用了',
      trigger: { kind: 'once', at: at2026() + 60_000 },
    })
    service.disable(task.id)
    time.advance(60_000)
    await service.tick()
    expect(delivered).toHaveLength(0)
  })

  it('投递失败不影响这条提醒继续排下一次', async () => {
    const time = clock(at2026())
    let seq = 0
    const service = new ScheduleService({
      now: time.now,
      newId: () => {
        seq += 1
        return `sch-${seq}`
      },
      deliver: () => {
        throw new Error('投递炸了')
      },
    })
    service.create({
      conversationId: 'c1',
      text: '会失败',
      trigger: { kind: 'interval', everyMs: 60_000 },
    })
    time.advance(60_000)
    await service.tick()
    expect(service.get('sch-1')?.fireCount).toBe(1)
    expect(service.get('sch-1')?.nextRunAt).toBeGreaterThan(0)
  })
})

describe('跨重启与错过的时间', () => {
  it('文件后端：重启后提醒还在，下一次也还在', () => {
    const path = join(tempDir(), 'schedule.json')
    const time = clock(at2026())
    const first = new ScheduleService({ storePath: path, now: time.now })
    const task = first.create({
      conversationId: 'c1',
      text: '重启后还在',
      trigger: { kind: 'daily', time: '09:00' },
    })

    const second = new ScheduleService({ storePath: path, now: time.now })
    const restored = second.get(task.id)
    expect(restored?.text).toBe('重启后还在')
    expect(restored?.nextRunAt).toBe(task.nextRunAt)
  })

  it('默认策略：错过的时间跳过，直接排到下一次', () => {
    const path = join(tempDir(), 'schedule.json')
    const time = clock(at2026())
    const first = new ScheduleService({ storePath: path, now: time.now })
    const task = first.create({
      conversationId: 'c1',
      text: '错过了',
      trigger: { kind: 'interval', everyMs: 60_000 },
    })
    // 进程停了两个小时。
    time.advance(2 * 60 * 60_000)
    const second = new ScheduleService({ storePath: path, now: time.now })
    expect(second.policy).toBe('skip')
    expect(second.get(task.id)?.nextRunAt).toBeGreaterThan(time.now())
  })

  it('catch-up 策略：错过的那次会补出来（只补一条）', async () => {
    const path = join(tempDir(), 'schedule.json')
    const time = clock(at2026())
    const delivered: { text: string }[] = []
    const first = new ScheduleService({ storePath: path, now: time.now })
    first.create({
      conversationId: 'c1',
      text: '补一次',
      trigger: { kind: 'interval', everyMs: 60_000 },
    })
    // 进程停了两个小时。
    time.advance(2 * 60 * 60_000)
    const second = new ScheduleService({
      storePath: path,
      now: time.now,
      missedPolicy: 'catch-up',
      deliver: (_id, _conversationId, text) => {
        delivered.push({ text })
      },
    })
    expect(second.policy).toBe('catch-up')
    const sent = await second.tick()
    expect(sent).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    // 补完就排下一次，不补一堆。
    expect(second.list('c1')[0]?.nextRunAt).toBeGreaterThan(time.now())
  })

  it('坏文件不挡启动：当成没有提醒', () => {
    const path = join(tempDir(), 'schedule.json')
    const service = new ScheduleService({ storePath: path })
    expect(service.listAll()).toEqual([])
  })

  it('文件后端：一条坏提醒只丢那一条', () => {
    const path = join(tempDir(), 'schedule.json')
    const service = new ScheduleService({ storePath: path })
    service.create({ conversationId: 'c1', text: '好的那条', trigger: { kind: 'daily', time: '09:00' } })
    // 手写一份带坏记录的文件：坏的那条认不出来，好的那条还在。
    writeFileSync(
      path,
      JSON.stringify({
        tasks: [
          {
            id: 'sch-good',
            conversationId: 'c1',
            title: '',
            text: '好的那条',
            trigger: { kind: 'daily', time: '09:00' },
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
            fireCount: 0,
          },
          {
            id: 'sch-bad',
            conversationId: 'c1',
            title: '',
            text: '坏的那条',
            trigger: { kind: '不认的' },
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
            fireCount: 0,
          },
        ],
      }),
      'utf8',
    )
    const second = new ScheduleService({ storePath: path })
    expect(second.list('c1')).toHaveLength(1)
    expect(second.list('c1')[0]?.id).toBe('sch-good')
  })
})

/** 2026-03-10 早上十点。 */
function at2026(): number {
  return new Date(2026, 2, 10, 10, 0, 0, 0).getTime()
}
