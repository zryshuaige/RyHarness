/**
 * 目标服务的状态机、归属与历史。
 *
 * 这些用例盯的是三件事：**一个会话一个目标**、**状态只能按规定流转**、
 * **每次改动都留下一笔**。少一样，主人回头就看不出「这事儿现在到哪一步了」。
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED_TRANSITIONS, GOAL_STATUS_LABELS, GoalError, GoalService } from '../src/index.ts'

/** 建一个服务：时钟固定，id 递增。 */
function serviceOf(): GoalService {
  let tick = 1_000
  let seq = 0
  return new GoalService({
    now: () => {
      tick += 1_000
      return tick
    },
    newId: () => {
      seq += 1
      return `goal-${seq}`
    },
  })
}

/** 断言某个动作抛出目标错误，并返回那条错误。 */
function expectGoalError(action: () => unknown, code: string): GoalError {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(GoalError)
  const goalError = caught
  if (!(goalError instanceof GoalError)) throw new Error('不是 GoalError')
  expect(goalError.code).toBe(code)
  return goalError
}

describe('目标的状态机', () => {
  it('新建的目标是进行中，标题、描述与完成判据都记下来了', () => {
    const service = serviceOf()
    const goal = service.create({
      sessionId: 'c1',
      title: '把周报写完',
      description: '含本周进展与下周计划',
      criteria: '周报发到群里',
    })
    expect(goal.status).toBe('active')
    expect(goal.title).toBe('把周报写完')
    expect(goal.description).toBe('含本周进展与下周计划')
    expect(goal.criteria).toBe('周报发到群里')
    expect(goal.sessionId).toBe('c1')
    expect(goal.updatedAt).toBeGreaterThanOrEqual(goal.createdAt)
  })

  it('一个会话至多一个目标：再建一个会报错，提示改用 update', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '第一个目标' })
    const error = expectGoalError(() => {
      service.create({ sessionId: 'c1', title: '第二个目标' })
    }, 'ALREADY_EXISTS')
    expect(error.message).toContain('第一个目标')
  })

  it('暂停 → 恢复 → 完成：每一次都换了状态', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    expect(service.pause('c1').status).toBe('paused')
    expect(service.resume('c1').status).toBe('active')
    expect(service.complete('c1').status).toBe('completed')
  })

  it('卡住也能恢复：blocked 回 active 是允许的流转', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '等接口' })
    expect(service.block('c1').status).toBe('blocked')
    expect(service.resume('c1').status).toBe('active')
  })

  it('完成是终态：不能再从完成跳回进行中', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    service.complete('c1')
    const error = expectGoalError(() => {
      service.resume('c1')
    }, 'INVALID_TRANSITION')
    expect(error.message).toContain(GOAL_STATUS_LABELS.completed)
  })

  it('清除之后可以重新定一个目标', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '旧目标' })
    expect(service.clear('c1').status).toBe('cleared')
    const fresh = service.create({ sessionId: 'c1', title: '新目标' })
    expect(fresh.title).toBe('新目标')
    expect(fresh.status).toBe('active')
  })

  it('终态目标不许再改文案', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    service.complete('c1')
    expectGoalError(() => {
      service.update({ sessionId: 'c1', title: '换个说法' })
    }, 'INVALID_TRANSITION')
  })

  it('没有目标时改不动：报 NOT_FOUND', () => {
    const service = serviceOf()
    expectGoalError(() => {
      service.update({ sessionId: 'c1', title: '改一下' })
    }, 'NOT_FOUND')
  })

  it('空标题与空会话 id 都被挡下', () => {
    const service = serviceOf()
    expectGoalError(() => {
      service.create({ sessionId: 'c1', title: '   ' })
    }, 'INVALID_INPUT')
    expectGoalError(() => {
      service.create({ sessionId: '', title: '有标题' })
    }, 'INVALID_INPUT')
  })

  it('流转表是显式的：完成只能被清除，清除之后哪儿也去不了', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual(['cleared'])
    expect(ALLOWED_TRANSITIONS.cleared).toEqual([])
    expect(ALLOWED_TRANSITIONS.active).toContain('paused')
  })
})

describe('目标的归属与历史', () => {
  it('别的会话的目标看不见也动不了', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '只有 c1 能看见' })
    expect(service.get('c2')).toBeUndefined()
    expectGoalError(() => {
      service.update({ sessionId: 'c2', title: '偷改' })
    }, 'NOT_FOUND')
  })

  it('每次改动都留下一笔：建、改、暂停、完成各一笔', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    service.update({ sessionId: 'c1', criteria: '周报发到群里' })
    service.pause('c1')
    service.complete('c1')
    const history = service.history('c1')
    expect(
      history.map((change) => {
        return change.action
      }),
    ).toEqual(['created', 'updated', 'paused', 'completed'])
    expect(history[0]?.summary).toContain('把周报写完')
    expect(history[1]?.summary).toContain('完成判据')
    expect(history[2]?.from).toBe('active')
    expect(history[2]?.to).toBe('paused')
  })

  it('改了标题也记一笔，而且与状态变更分开记', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '旧标题' })
    service.update({ sessionId: 'c1', title: '新标题', status: 'paused' })
    const history = service.history('c1')
    expect(history).toHaveLength(3)
    expect(history[1]?.action).toBe('paused')
    expect(history[2]?.action).toBe('updated')
    expect(history[2]?.summary).toContain('标题')
  })

  it('历史里的每一条都带着时刻与目标 id', () => {
    const service = serviceOf()
    const goal = service.create({ sessionId: 'c1', title: '把周报写完' })
    const history = service.history('c1')
    expect(history[0]?.goalId).toBe(goal.id)
    expect(history[0]?.at).toBeGreaterThan(0)
  })

  it('清掉目标之后，历史还在：清掉的是这件事，不是这段经历', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '做过又不要了' })
    service.clear('c1')
    expect(service.get('c1')?.status).toBe('cleared')
    expect(service.history('c1')).toHaveLength(2)
    expect(service.history('c1')[0]?.summary).toContain('做过又不要了')
  })

  it('换个会话看，历史是空的', () => {
    const service = serviceOf()
    service.create({ sessionId: 'c1', title: '把周报写完' })
    expect(service.history('c2')).toEqual([])
  })
})
