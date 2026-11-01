/**
 * `/goal` 命令：不花模型一轮，人自己看与改。
 *
 * 这些用例盯的是命令这一面：**它是纯数据**（名字、说明、execute 函数），
 * 宿主能直接注册；它列出的状态与历史跟服务说的一致。
 */
import { describe, expect, it } from 'vitest'
import { createGoalCommand, GOAL_COMMAND_NAME, GoalService } from '../src/index.ts'

/** 建一个服务与它的命令。 */
function commandOf(sessionId: string | null = 'c1') {
  let tick = 1_000
  const service = new GoalService({
    now: () => {
      tick += 1_000
      return tick
    },
  })
  const command = createGoalCommand(service, {
    resolveSessionId: () => (sessionId === null ? undefined : sessionId),
  })
  return { service, command }
}

/** 跑一条命令。 */
async function run(command: ReturnType<typeof createGoalCommand>, input: string) {
  return command.execute({ input, raw: input, line: `/goal ${input}`.trim() })
}

describe('/goal 命令', () => {
  it('命令名是 goal，说明写清了它干什么', () => {
    const { command } = commandOf()
    expect(command.name).toBe(GOAL_COMMAND_NAME)
    expect(command.description).toContain('/goal')
  })

  it('不带参数时看现状：标题、状态、完成判据', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完', criteria: '周报发到群里' })
    const result = await run(command, '')
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('把周报写完')
    expect(result.text).toContain('进行中')
    expect(result.text).toContain('周报发到群里')
  })

  it('没有目标时说清怎么定', async () => {
    const { command } = commandOf()
    const result = await run(command, 'list')
    expect(result.text).toContain('/goal set')
  })

  it('set：定一个目标', async () => {
    const { service, command } = commandOf()
    const result = await run(command, 'set 把周报写完')
    expect(result.text).toContain('目标已定')
    expect(service.get('c1')?.title).toBe('把周报写完')
  })

  it('set：已经有目标时改标题而不是建第二个', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '旧标题' })
    const result = await run(command, 'set 新标题')
    expect(result.text).toContain('目标已改')
    expect(service.get('c1')?.title).toBe('新标题')
  })

  it('set：不给标题时说清用法', async () => {
    const { command } = commandOf()
    const result = await run(command, 'set')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('/goal set')
  })

  it('stop：暂停目标', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const result = await run(command, 'stop')
    expect(result.text).toContain('已暂停')
    expect(service.get('c1')?.status).toBe('paused')
  })

  it('resume：恢复目标', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    service.pause('c1')
    const result = await run(command, 'resume')
    expect(result.text).toContain('已恢复')
    expect(service.get('c1')?.status).toBe('active')
  })

  it('complete：标记完成', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const result = await run(command, 'complete')
    expect(result.text).toContain('已完成')
    expect(service.get('c1')?.status).toBe('completed')
  })

  it('clear：清掉目标，记录留在历史里', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    const result = await run(command, 'clear')
    expect(result.text).toContain('已清除')
    expect(service.history('c1')).toHaveLength(2)
  })

  it('看不出动作时给一份用法', async () => {
    const { command } = commandOf()
    const result = await run(command, 'fly')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('/goal')
  })

  it('没有会话上下文时说清为什么用不了', async () => {
    const { command } = commandOf(null)
    const result = await run(command, 'list')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('会话')
  })

  it('非法流转的报错是人话，不是英文异常', async () => {
    const { service, command } = commandOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    service.complete('c1')
    const result = await run(command, 'stop')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('已完成')
  })
})
