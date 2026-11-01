/**
 * 模型看得见的三件工具：名字、参数、行为。
 *
 * 这些用例盯的是「模型怎么用它」：参数缺了给一句能照着改的话，
 * 没有会话上下文时不装作有（目标按会话归属），已有目标时别默默建第二个。
 */
import { describe, expect, it } from 'vitest'
import { createGoalTools, GOAL_TOOL_NAMES, GoalService } from '../src/index.ts'

/** 建一个服务与它的三件工具。 */
function toolsOf(): { service: GoalService; tools: ReturnType<typeof createGoalTools> } {
  let tick = 1_000
  const service = new GoalService({
    now: () => {
      tick += 1_000
      return tick
    },
  })
  return { service, tools: createGoalTools(service) }
}

/** 按名字取工具。 */
function toolOf(tools: ReturnType<typeof createGoalTools>, name: string) {
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

describe('目标的三件模型工具', () => {
  it('三件工具的名字就是上游那三个', () => {
    expect([...GOAL_TOOL_NAMES]).toEqual(['get_goal', 'create_goal', 'update_goal'])
  })

  it('get_goal：还没有目标时给一句人话，不报错', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'get_goal').execute({}, ctx('c1'))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('还没有目标')
  })

  it('get_goal：有目标时给出标题、状态与完成判据', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '把周报写完', criteria: '周报发到群里' })
    const result = await toolOf(tools, 'get_goal').execute({}, ctx('c1'))
    expect(result.content).toContain('把周报写完')
    expect(result.content).toContain('进行中')
    expect(result.content).toContain('周报发到群里')
  })

  it('create_goal：定完目标就说清楚它是什么', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'create_goal').execute(
      { title: '把周报写完', criteria: '周报发到群里' },
      ctx('c1'),
    )
    expect(result.content).toContain('把周报写完')
    expect(result.content).toContain('周报发到群里')
  })

  it('create_goal：缺 title 时给一条能照着改的话', async () => {
    const { tools } = toolsOf()
    const result = await toolOf(tools, 'create_goal').execute({}, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('title')
  })

  it('create_goal：已经有目标时提示改而不是建第二个', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '第一个目标' })
    const result = await toolOf(tools, 'create_goal').execute({ title: '第二个目标' }, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('第一个目标')
  })

  it('update_goal：改标题与完成判据都算数', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '旧标题' })
    const result = await toolOf(tools, 'update_goal').execute({ title: '新标题', criteria: '写完并发出' }, ctx('c1'))
    expect(result.content).toContain('新标题')
    expect(service.get('c1')?.criteria).toBe('写完并发出')
  })

  it('update_goal：换状态也认，非法状态给一句话', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const paused = await toolOf(tools, 'update_goal').execute({ status: 'paused' }, ctx('c1'))
    expect(paused.content).toContain('已暂停')
    expect(service.get('c1')?.status).toBe('paused')

    const bad = await toolOf(tools, 'update_goal').execute({ status: 'done' }, ctx('c1'))
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('status')
  })

  it('update_goal：什么都没传时说清楚要传什么', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const result = await toolOf(tools, 'update_goal').execute({}, ctx('c1'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('title')
  })

  it('没有会话上下文时三件工具都拒绝：目标按会话归属', async () => {
    const { tools } = toolsOf()
    for (const name of GOAL_TOOL_NAMES) {
      const result = await toolOf(tools, name).execute({ title: '没有会话' }, ctx())
      expect(result.isError).toBe(true)
      expect(result.content).toContain('会话')
    }
  })

  it('别的会话的目标看不见：get_goal 拿不到', async () => {
    const { service, tools } = toolsOf()
    service.create({ sessionId: 'c1', title: '只有 c1 的目标' })
    const result = await toolOf(tools, 'get_goal').execute({}, ctx('c2'))
    expect(result.content).toContain('还没有目标')
  })

  it('每件工具都带参数说明与名字', () => {
    const { tools } = toolsOf()
    for (const tool of tools) {
      expect(tool.name.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters.type).toBe('object')
    }
  })
})
