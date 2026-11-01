/**
 * 计划模式的用例：待批、批准、打回、模式按会话。
 */

import { describe, expect, it } from 'vitest'
import { PlanModeService, type PlanSnapshot } from '../src/index.ts'

/** 一份两步的计划。 */
const DRAFT = {
  title: '把后台任务接进会话',
  steps: [
    { title: '加执行器', detail: '先派个子代理试试' },
    { title: '接通知', detail: '跑完写进对话' },
  ],
}

describe('PlanModeService', () => {
  it('交上去就是待批：没批之前不动手', () => {
    const service = new PlanModeService()
    service.enable('c1')

    const plan = service.propose('c1', DRAFT)
    expect(plan.status).toBe('proposed')
    expect(plan.version).toBe(1)
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.detail).toBe('先派个子代理试试')

    const gate = service.gate('c1')
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('等人批准')
  })

  it('批了才动手：批准之后闸门放行', () => {
    const service = new PlanModeService()
    service.enable('c1')
    service.propose('c1', DRAFT)

    const approved = service.approve('c1')
    expect(approved?.status).toBe('approved')
    expect(approved?.decidedAt).toBeGreaterThan(0)
    expect(service.gate('c1').allowed).toBe(true)
    expect(service.status('c1')).toBe('approved')
  })

  it('打回：反馈留着，改一版再交上来版本号会变', () => {
    const service = new PlanModeService()
    service.enable('c1')
    const first = service.propose('c1', DRAFT)
    expect(first.version).toBe(1)

    const rejected = service.reject('c1', '第二步先别接通知')
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.feedback).toBe('第二步先别接通知')
    expect(service.gate('c1').allowed).toBe(false)
    expect(service.gate('c1').reason).toContain('被打回')

    const second = service.propose('c1', { ...DRAFT, title: '只做第一步' })
    expect(second.version).toBe(2)
    expect(second.version).not.toBe(first.version)
    expect(second.status).toBe('proposed')
    // 改过的第二版又回到待批：要让人重新看一眼。
    expect(service.gate('c1').allowed).toBe(false)
  })

  it('模式按会话：一个会话开着，另一个照常', () => {
    const service = new PlanModeService()
    service.enable('c1')

    expect(service.isEnabled('c1')).toBe(true)
    expect(service.isEnabled('c2')).toBe(false)
    // 没开模式的会话不受这份计划影响。
    expect(service.gate('c2').allowed).toBe(true)

    service.disable('c1')
    expect(service.isEnabled('c1')).toBe(false)
    expect(service.gate('c1').allowed).toBe(true)
  })

  it('模式开着但还没有计划：先探索，别先动手', () => {
    const service = new PlanModeService()
    service.enable('c1')

    const gate = service.gate('c1')
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toContain('plan_propose')
    expect(service.current('c1')).toBeUndefined()
    expect(service.status('c1')).toBe('none')
  })

  it('状态变化时通知宿主', () => {
    const seen: PlanSnapshot[] = []
    const service = new PlanModeService({
      onChange: (plan) => {
        seen.push(plan)
      },
    })
    service.enable('c1')
    service.propose('c1', DRAFT)
    service.approve('c1')

    expect(seen.map((plan) => plan.status)).toEqual(['proposed', 'approved'])
  })

  it('宿主回调出错不该把计划带倒', () => {
    const service = new PlanModeService({
      onChange: () => {
        throw new Error('写会话失败了')
      },
    })
    service.enable('c1')
    service.propose('c1', DRAFT)
    expect(service.lastCallbackError).toBe('写会话失败了')
    expect(service.status('c1')).toBe('proposed')
  })

  it('宿主回调返回的 promise 挂了也不该把计划带倒', async () => {
    const service = new PlanModeService({
      onChange: () => Promise.reject(new Error('写会话失败了')),
    })
    service.enable('c1')
    service.propose('c1', DRAFT)
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    expect(service.lastCallbackError).toBe('写会话失败了')
    expect(service.status('c1')).toBe('proposed')
  })

  it('没有计划时批与打回都批不动', () => {
    const service = new PlanModeService()
    expect(service.approve('c1')).toBeUndefined()
    expect(service.reject('c1', '不批')).toBeUndefined()
  })

  it('计划不合法：交不上去', () => {
    const service = new PlanModeService()
    expect(() => service.propose('c1', { title: '  ', steps: DRAFT.steps })).toThrow(/标题/)
    expect(() => service.propose('c1', { title: '标题', steps: [] })).toThrow(/步骤/)
    expect(() => service.propose('c1', { title: '标题', steps: [{ title: ' ' }] })).toThrow(/标题/)
  })

  it('打回没写原因也留一句说明', () => {
    const service = new PlanModeService()
    service.enable('c1')
    service.propose('c1', DRAFT)
    const rejected = service.reject('c1', '   ')
    expect(rejected?.feedback).toBe('没写原因，但没批。')
  })
})
