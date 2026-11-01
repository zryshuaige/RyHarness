/**
 * 目标这一族的边界：缺省构造、坏数据、工具的失败路径。
 *
 * 这些用例盯的是「出岔子的时候」：缺省构造能不能用、坏文件会不会挡住启动、
 * 工具遇到非法输入给的是不是人话。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGoalTools, FileGoalStore, GoalService, MemoryGoalStore, renderGoal } from '../src/index.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-goal-edge-'))
  dirs.push(dir)
  return dir
}

describe('目标的缺省构造', () => {
  it('不给任何参数也能用：时钟与 id 走缺省', () => {
    const service = new GoalService()
    const goal = service.create({ sessionId: 'c1', title: '缺省也能定' })
    expect(goal.title).toBe('缺省也能定')
    expect(goal.id.length).toBeGreaterThan(0)
    expect(goal.createdAt).toBeGreaterThan(0)
  })

  it('内存后端可以显式给', () => {
    const store = new MemoryGoalStore()
    const service = new GoalService({ store })
    service.create({ sessionId: 'c1', title: '显式内存' })
    expect(store.load('c1')?.goal?.title).toBe('显式内存')
  })

  it('文件后端可以显式给', () => {
    const path = join(tempDir(), 'goals.json')
    const store = new FileGoalStore({ filePath: path })
    const service = new GoalService({ store })
    service.create({ sessionId: 'c1', title: '显式文件' })
    expect(new FileGoalStore({ filePath: path }).load('c1')?.goal?.title).toBe('显式文件')
  })
})

describe('目标存储的坏数据', () => {
  it('文件里不是对象时当没有目标', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(path, '[]', 'utf8')
    const service = new GoalService({ storePath: path })
    expect(service.get('c1')).toBeUndefined()
  })

  it('文件里缺 sessions 段时当没有目标', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(path, '{"别的":1}', 'utf8')
    const service = new GoalService({ storePath: path })
    expect(service.get('c1')).toBeUndefined()
  })

  it('目标缺字段时只丢那一条', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessions: {
          c1: { goal: { id: 'g1', sessionId: 'c1', title: '缺字段' }, history: [] },
        },
      }),
      'utf8',
    )
    const service = new GoalService({ storePath: path })
    expect(service.get('c1')).toBeUndefined()
  })

  it('变更记录缺字段时只丢那一条，目标还在', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessions: {
          c1: {
            goal: {
              id: 'g1',
              sessionId: 'c1',
              title: '好的目标',
              description: '',
              criteria: '',
              status: 'active',
              createdAt: 1,
              updatedAt: 1,
            },
            history: [{ at: 1, action: '不认的动作', goalId: 'g1', summary: '坏记录' }],
          },
        },
      }),
      'utf8',
    )
    const service = new GoalService({ storePath: path })
    expect(service.get('c1')?.title).toBe('好的目标')
    expect(service.history('c1')).toEqual([])
  })

  it('文件后端能列出有档案的会话', () => {
    const path = join(tempDir(), 'goals.json')
    const store = new FileGoalStore({ filePath: path })
    const service = new GoalService({ store })
    service.create({ sessionId: 'c1', title: '一' })
    service.create({ sessionId: 'c2', title: '二' })
    expect([...store.listSessions()].sort()).toEqual(['c1', 'c2'])
  })

  it('目标缺各种字段时都只丢那一条', () => {
    const path = join(tempDir(), 'goals.json')
    const good = {
      id: 'g1',
      sessionId: 'c1',
      title: '好的目标',
      description: '',
      criteria: '',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    const broken = [
      { ...good, id: '' },
      { ...good, sessionId: '' },
      { ...good, title: 42 },
      { ...good, description: 42 },
      { ...good, criteria: 42 },
      { ...good, status: '不认的' },
      { ...good, createdAt: '不是数字' },
      { ...good, updatedAt: Number.NaN },
    ]
    for (const goal of broken) {
      writeFileSync(path, JSON.stringify({ sessions: { c1: { goal, history: [] } } }), 'utf8')
      const service = new GoalService({ storePath: path })
      expect(service.get('c1')).toBeUndefined()
    }
  })

  it('变更记录缺字段时只丢那一条', () => {
    const path = join(tempDir(), 'goals.json')
    const good = {
      id: 'g1',
      sessionId: 'c1',
      title: '好的目标',
      description: '',
      criteria: '',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    const broken = [
      { at: '不是数字', action: 'created', goalId: 'g1', summary: 'x' },
      { at: 1, action: 'created', goalId: '', summary: 'x' },
      { at: 1, action: 'created', goalId: 'g1', summary: 42 },
    ]
    for (const change of broken) {
      writeFileSync(path, JSON.stringify({ sessions: { c1: { goal: good, history: [change] } } }), 'utf8')
      const service = new GoalService({ storePath: path })
      expect(service.get('c1')?.title).toBe('好的目标')
      expect(service.history('c1')).toEqual([])
    }
  })

  it('档案本身不是对象时那一条丢掉', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(path, JSON.stringify({ sessions: { c1: '不是对象' } }), 'utf8')
    const service = new GoalService({ storePath: path })
    expect(service.get('c1')).toBeUndefined()
  })

  it('变更记录带前后状态时读得回来', () => {
    const path = join(tempDir(), 'goals.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessions: {
          c1: {
            history: [{ at: 1, action: 'paused', goalId: 'g1', summary: '暂停了', from: 'active', to: 'paused' }],
          },
        },
      }),
      'utf8',
    )
    const service = new GoalService({ storePath: path })
    expect(service.history('c1')[0]?.from).toBe('active')
    expect(service.history('c1')[0]?.to).toBe('paused')
  })
})

describe('目标工具的失败路径', () => {
  it('改一个不存在的目标时给一句人话', async () => {
    const service = new GoalService()
    const tools = createGoalTools(service)
    const update = tools.find((tool) => {
      return tool.name === 'update_goal'
    })
    if (update === undefined) throw new Error('没有 update_goal')
    const result = await update.execute({ title: '改不到' }, { conversationId: 'c1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('create_goal')
  })

  it('渲染目标时：没有描述就不写描述那一行', () => {
    const service = new GoalService()
    const goal = service.create({ sessionId: 'c1', title: '只有标题' })
    const text = renderGoal(goal)
    expect(text).toContain('只有标题')
    expect(text).not.toContain('说明：')
    expect(text).not.toContain('完成判据：')
  })

  it('渲染目标时：有描述与判据就都写上', () => {
    const service = new GoalService()
    const goal = service.create({
      sessionId: 'c1',
      title: '有细节',
      description: '细节在这儿',
      criteria: '这样算完',
    })
    const text = renderGoal(goal)
    expect(text).toContain('说明：细节在这儿')
    expect(text).toContain('完成判据：这样算完')
  })

  it('改描述也算一次改动', () => {
    const service = new GoalService()
    service.create({ sessionId: 'c1', title: '原目标' })
    service.update({ sessionId: 'c1', description: '新的说明' })
    const history = service.history('c1')
    expect(history[1]?.action).toBe('updated')
    expect(history[1]?.summary).toContain('描述')
    expect(service.get('c1')?.description).toBe('新的说明')
  })

  it('改成一样的描述不算改动，不留历史', () => {
    const service = new GoalService()
    service.create({ sessionId: 'c1', title: '原目标', description: '一样的说明' })
    service.update({ sessionId: 'c1', description: '一样的说明' })
    expect(service.history('c1')).toHaveLength(1)
  })
})
