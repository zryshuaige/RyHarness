/**
 * 提醒这一族的边界：坏数据、缺省构造、cron 的边角、工具的失败路径。
 *
 * 这些用例盯的是「出岔子的时候」：坏文件会不会挡住启动、cron 的怪写法会不会
 * 死循环、工具遇到非法输入给的是不是人话。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createScheduleTools,
  cronHasFuture,
  describeCron,
  describeTrigger,
  FileScheduleStore,
  formatTimeOfDay,
  MemoryScheduleStore,
  parseCron,
  parseTimeOfDay,
  ScheduleError,
  ScheduleService,
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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-schedule-edge-'))
  dirs.push(dir)
  return dir
}

/** 一条完整的提醒记录（用来手写坏文件）。 */
function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sch-1',
    conversationId: 'c1',
    title: '',
    text: '好的那条',
    trigger: { kind: 'daily', time: '09:00' },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    fireCount: 0,
    ...overrides,
  }
}

describe('提醒的缺省构造', () => {
  it('不给任何参数也能用：走内存后端', () => {
    const service = new ScheduleService()
    const task = service.create({
      conversationId: 'c1',
      text: '缺省也能立',
      trigger: { kind: 'daily', time: '09:00' },
    })
    expect(task.text).toBe('缺省也能立')
  })

  it('内存后端可以显式给', () => {
    const store = new MemoryScheduleStore()
    const service = new ScheduleService({ store })
    service.create({ conversationId: 'c1', text: '显式内存', trigger: { kind: 'daily', time: '09:00' } })
    expect(store.load()).toHaveLength(1)
  })

  it('文件后端可以显式给', () => {
    const path = join(tempDir(), 'schedule.json')
    const store = new FileScheduleStore({ filePath: path })
    const service = new ScheduleService({ store })
    service.create({ conversationId: 'c1', text: '显式文件', trigger: { kind: 'daily', time: '09:00' } })
    expect(new FileScheduleStore({ filePath: path }).load()).toHaveLength(1)
  })
})

describe('提醒存储的坏数据', () => {
  it('文件里不是对象时当没有提醒', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, '"不是对象"', 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('文件里缺 tasks 段时当没有提醒', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, '{"别的":1}', 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('触发方式不认时那条提醒丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ id: 'bad', trigger: { kind: '不认的' } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('状态不认时那条提醒丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ status: '不认的' })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('少字段时那条提醒丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [{ id: 'bad' }] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('一次性提醒的时间不合法时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'once', at: '不是数字' } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('间隔不合法时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'interval', everyMs: 0 } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('每日提醒缺 time 时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'daily' } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('每周提醒缺 weekday 或 time 时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'weekly', time: '09:00' } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'weekly', weekday: 1 } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('cron 提醒缺表达式时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ trigger: { kind: 'cron' } })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('不是对象的条目丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: ['不是对象'] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })

  it('缺 id / 会话 id / 正文 / 计数的条目丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    for (const overrides of [
      { id: '' },
      { conversationId: '' },
      { text: 42 },
      { fireCount: '不是数字' },
      { createdAt: '不是数字' },
      { updatedAt: Number.NaN },
    ]) {
      writeFileSync(path, JSON.stringify({ tasks: [rawTask(overrides)] }), 'utf8')
      expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
    }
  })

  it('标题不是字符串时那条丢掉', () => {
    const path = join(tempDir(), 'schedule.json')
    writeFileSync(path, JSON.stringify({ tasks: [rawTask({ title: 42 })] }), 'utf8')
    expect(new ScheduleService({ storePath: path }).listAll()).toEqual([])
  })
})

describe('cron 的边角', () => {
  it('列表里有空项时报错', () => {
    expect(() => {
      parseCron('1,,2 * * * *')
    }).toThrow(ScheduleError)
  })

  it('步长那一段反着时报错', () => {
    expect(() => {
      parseCron('30-10/5 * * * *')
    }).toThrow(ScheduleError)
  })

  it('cronHasFuture：还命得起就是 true', () => {
    const spec = parseCron('0 9 * * *')
    expect(cronHasFuture(spec, new Date(2026, 2, 10, 0, 0).getTime())).toBe(true)
  })

  it('cronHasFuture：永远不命中的计划是 false', () => {
    const spec = parseCron('0 9 30 2 *')
    expect(cronHasFuture(spec, new Date(2026, 2, 10, 0, 0).getTime())).toBe(false)
  })

  it('cron 的中文摘要', () => {
    expect(describeCron(parseCron('0 9 * * 1-5'))).toContain('0 分')
    expect(describeCron(parseCron('0 9 * * 1-5'))).toContain('9 时')
  })

  it('触发方式的中文说明：五种各说各的', () => {
    expect(describeTrigger({ kind: 'once', at: new Date(2026, 2, 10, 15, 0).getTime() })).toContain('一次性')
    expect(describeTrigger({ kind: 'interval', everyMs: 30 * 60_000 })).toContain('每 30 分钟')
    expect(describeTrigger({ kind: 'daily', time: '09:00' })).toBe('每天 09:00')
    expect(describeTrigger({ kind: 'weekly', weekday: 3, time: '08:00' })).toBe('每周三 08:00')
    expect(describeTrigger({ kind: 'cron', expression: '0 9 * * *' })).toBe('cron：0 9 * * *')
  })
})

describe('提醒的边角', () => {
  it('钟点渲染成两位数', () => {
    expect(formatTimeOfDay(parseTimeOfDay('9:05'))).toBe('09:05')
  })

  it('list 不带停用的那些时按状态过滤', () => {
    const service = new ScheduleService()
    const task = service.create({
      conversationId: 'c1',
      text: '停用的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    service.disable(task.id)
    expect(service.list('c1')).toHaveLength(1)
    expect(service.list('c1', false)).toHaveLength(0)
  })

  it('改标题也算一次改动', () => {
    const service = new ScheduleService()
    const task = service.create({
      conversationId: 'c1',
      text: '原来的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const updated = service.update({ id: task.id, title: '新标题' })
    expect(updated.title).toBe('新标题')
  })

  it('空的正文在改的时候也被挡下', () => {
    const service = new ScheduleService()
    const task = service.create({
      conversationId: 'c1',
      text: '原来的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    expect(() => {
      service.update({ id: task.id, text: '  ' })
    }).toThrow(ScheduleError)
  })

  it('停用的提醒在重启后仍停用：不会莫名响起来', () => {
    const path = join(tempDir(), 'schedule.json')
    const first = new ScheduleService({ storePath: path })
    const task = first.create({
      conversationId: 'c1',
      text: '停用的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    first.disable(task.id)
    const second = new ScheduleService({ storePath: path })
    expect(second.get(task.id)?.status).toBe('disabled')
  })

  it('已响过的一次性提醒在重启后不会补响', () => {
    const path = join(tempDir(), 'schedule.json')
    const first = new ScheduleService({ storePath: path })
    const task = first.create({
      conversationId: 'c1',
      text: '只响一次',
      trigger: { kind: 'once', at: Date.now() + 60_000 },
    })
    first.disable(task.id)
    const second = new ScheduleService({ storePath: path })
    expect(second.get(task.id)?.status).toBe('disabled')
  })
})

describe('提醒工具的失败路径', () => {
  it('schedule_update：kind 不认时报错', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const task = service.create({
      conversationId: 'c1',
      text: '提醒',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const update = tools.find((tool) => {
      return tool.name === 'schedule_update'
    })
    if (update === undefined) throw new Error('没有 schedule_update')
    const result = await update.execute({ id: task.id, kind: '每小时' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('kind')
  })

  it('schedule_delete：删不存在的提醒给出提示', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const remove = tools.find((tool) => {
      return tool.name === 'schedule_delete'
    })
    if (remove === undefined) throw new Error('没有 schedule_delete')
    const result = await remove.execute({ id: 'sch-999', confirmed: true }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('sch-999')
  })

  it('schedule_create：一次性提醒缺 at 时说清要什么', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const create = tools.find((tool) => {
      return tool.name === 'schedule_create'
    })
    if (create === undefined) throw new Error('没有 schedule_create')
    const result = await create.execute({ text: '提醒', kind: 'once' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('at')
  })

  it('schedule_create：固定间隔缺 every_minutes 时说清要什么', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const create = tools.find((tool) => {
      return tool.name === 'schedule_create'
    })
    if (create === undefined) throw new Error('没有 schedule_create')
    const result = await create.execute({ text: '提醒', kind: 'interval' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('every_minutes')
  })

  it('schedule_create：每周提醒缺 time 或 weekday 时说清要什么', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const create = tools.find((tool) => {
      return tool.name === 'schedule_create'
    })
    if (create === undefined) throw new Error('没有 schedule_create')
    const noTime = await create.execute({ text: '提醒', kind: 'weekly', weekday: 1 }, { conversationId: 'c1' })
    expect(noTime.isError).toBe(true)
    expect(noTime.content).toContain('time')
    const noWeekday = await create.execute({ text: '提醒', kind: 'weekly', time: '09:00' }, { conversationId: 'c1' })
    expect(noWeekday.isError).toBe(true)
    expect(noWeekday.content).toContain('weekday')
  })

  it('schedule_create：每日提醒缺 time 时说清要什么', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const create = tools.find((tool) => {
      return tool.name === 'schedule_create'
    })
    if (create === undefined) throw new Error('没有 schedule_create')
    const result = await create.execute({ text: '提醒', kind: 'daily' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('time')
  })

  it('schedule_create：cron 提醒缺表达式时说清要什么', async () => {
    const service = new ScheduleService()
    const tools = createScheduleTools(service)
    const create = tools.find((tool) => {
      return tool.name === 'schedule_create'
    })
    if (create === undefined) throw new Error('没有 schedule_create')
    const result = await create.execute({ text: '提醒', kind: 'cron' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cron')
  })
})
