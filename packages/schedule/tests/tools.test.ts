/**
 * 模型看得见的四件工具：名字、参数、行为，以及归属与删除确认。
 *
 * 这些用例盯的是「模型怎么用它」：参数缺了给一句能照着改的话，
 * 别的会话的提醒动不了，删除必须显式确认。
 */
import { describe, expect, it } from 'vitest'
import { createScheduleTools, SCHEDULE_TOOL_NAMES, ScheduleService } from '../src/index.ts'

/** 建一个服务与它的四件工具。 */
function toolsOf() {
  let tick = 1_000
  const service = new ScheduleService({
    now: () => {
      tick += 1_000
      return tick
    },
  })
  return { service, tools: createScheduleTools(service) }
}

/** 按名字取工具。 */
function toolOf(tools: ReturnType<typeof createScheduleTools>, name: string) {
  const found = tools.find((tool) => {
    return tool.name === name
  })
  if (found === undefined) throw new Error(`没有这件工具：${name}`)
  return found
}

/** 会话上下文。 */
function ctx(conversationId?: string): { conversationId?: string } {
  return conversationId === undefined ? {} : { conversationId }
}

describe('提醒的四件模型工具', () => {
  it('四件工具的名字就是上游那四个', () => {
    expect([...SCHEDULE_TOOL_NAMES]).toEqual(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
  })

  it('schedule_create：立一个每日提醒', async () => {
    const { service, tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_create').execute(
      { text: '该交周报了', kind: 'daily', time: '09:00' },
      ctx('c1'),
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('该交周报了')
    expect(service.list('c1')).toHaveLength(1)
  })

  it('schedule_create：五种触发方式都认', async () => {
    const { service, tools } = toolsOf()
    const create = toolOf(tools, 'schedule_create')
    await create.execute({ text: '一次性', kind: 'once', at: 9_000_000_000_000 }, ctx('c1'))
    await create.execute({ text: '每十分钟', kind: 'interval', every_minutes: 10 }, ctx('c1'))
    await create.execute({ text: '每天', kind: 'daily', time: '09:00' }, ctx('c1'))
    await create.execute({ text: '每周', kind: 'weekly', weekday: 3, time: '08:00' }, ctx('c1'))
    await create.execute({ text: 'cron', kind: 'cron', cron: '0 9 * * 1-5' }, ctx('c1'))
    expect(service.list('c1')).toHaveLength(5)
  })

  it('schedule_create：缺 text 时给一句能照着改的话', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_create').execute({ kind: 'daily', time: '09:00' }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('text')
  })

  it('schedule_create：缺 kind 时说清有哪几种', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_create').execute({ text: '提醒' }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('once')
  })

  it('schedule_create：kind 不认时报错', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_create').execute({ text: '提醒', kind: '每小时' }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('kind')
  })

  it('schedule_list：列出这个会话的提醒', async () => {
    const { service, tools } = toolsOf()
    service.create({ conversationId: 'c1', text: '该交周报了', trigger: { kind: 'daily', time: '09:00' } })
    const result = await toolOf(tools, 'schedule_list').execute({}, ctx('c1'))
    expect(result.content).toContain('该交周报了')
    expect(result.content).toContain('每天 09:00')
  })

  it('schedule_list：没有提醒时给一句人话', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_list').execute({}, ctx('c1'))
    expect(result.content).toContain('还没有提醒')
  })

  it('schedule_list：别的会话的提醒看不见', async () => {
    const { service, tools } = toolsOf()
    service.create({ conversationId: 'c1', text: '只有 c1 的', trigger: { kind: 'daily', time: '09:00' } })
    const result = await toolOf(tools, 'schedule_list').execute({}, ctx('c2'))
    expect(result.content).toContain('还没有提醒')
  })

  it('schedule_update：改内容与停用都算数', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const renamed = await toolOf(tools, 'schedule_update').execute({ id: task.id, text: '该交月报了' }, ctx('c1'))
    expect(renamed.content).toContain('该交月报了')
    expect(service.get(task.id)?.text).toBe('该交月报了')

    const off = await toolOf(tools, 'schedule_update').execute({ id: task.id, enabled: false }, ctx('c1'))
    expect(off.content).toContain('已停用')
    expect(service.get(task.id)?.status).toBe('disabled')
  })

  it('schedule_update：换触发方式会重排下一次', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '该交周报了',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const before = task.nextRunAt
    await toolOf(tools, 'schedule_update').execute(
      { id: task.id, kind: 'weekly', weekday: 3, time: '08:00' },
      ctx('c1'),
    )
    expect(service.get(task.id)?.nextRunAt).not.toBe(before)
  })

  it('schedule_update：缺 id 时让模型先去查', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'schedule_update').execute({ text: '改哪儿' }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('id')
  })

  it('schedule_update：别的会话的提醒改不动', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '只有 c1 的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const result = await toolOf(tools, 'schedule_update').execute({ id: task.id, text: '偷改' }, ctx('c2'))
    expect(result.isError).toBe(true)
    expect(service.get(task.id)?.text).toBe('只有 c1 的')
  })

  it('schedule_delete：没确认就不删', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '别误删',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const result = await toolOf(tools, 'schedule_delete').execute({ id: task.id }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('确认')
    expect(service.get(task.id)).toBeDefined()
  })

  it('schedule_delete：确认了就真删', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '确认删',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const result = await toolOf(tools, 'schedule_delete').execute({ id: task.id, confirmed: true }, ctx('c1'))
    expect(result.content).toContain('已删除')
    expect(service.get(task.id)).toBeUndefined()
  })

  it('schedule_delete：别的会话的提醒删不掉', async () => {
    const { service, tools } = toolsOf()
    const task = service.create({
      conversationId: 'c1',
      text: '只有 c1 的',
      trigger: { kind: 'daily', time: '09:00' },
    })
    const result = await toolOf(tools, 'schedule_delete').execute({ id: task.id, confirmed: true }, ctx('c2'))
    expect(result.isError).toBe(true)
    expect(service.get(task.id)).toBeDefined()
  })

  it('没有会话上下文时四件工具都拒绝：提醒按会话归属', async () => {
    const { tools } = toolsOf()
    for (const name of SCHEDULE_TOOL_NAMES) {
      const result = await toolOf(tools, name).execute({ text: '没有会话', kind: 'daily', time: '09:00' }, ctx())
      expect(result.isError).toBe(true)
      expect(result.content).toContain('会话')
    }
  })
})
