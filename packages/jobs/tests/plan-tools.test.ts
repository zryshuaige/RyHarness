/**
 * 计划模式两件工具的用例：交计划、读状态。
 */

import { describe, expect, it } from 'vitest'
import { createPlanProposeTool, createPlanReadTool, PlanModeService } from '../src/index.ts'
import { toolContext } from './helpers.ts'

describe('计划模式工具', () => {
  it('plan_propose：交上去就是待批', async () => {
    const service = new PlanModeService()
    service.enable('c1')
    const tool = createPlanProposeTool(service)

    const result = await tool.execute(
      { title: '加个后台任务', steps: [{ title: '写执行器', detail: '先派子代理' }, '写通知'] },
      toolContext({ conversationId: 'c1' }),
    )
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('已提交，等人批')
    expect(result.content).toContain('1. 写执行器（先派子代理）')
    expect(result.content).toContain('2. 写通知')
    expect(service.status('c1')).toBe('proposed')
  })

  it('plan_propose：参数不对时把原因说清楚', async () => {
    const service = new PlanModeService()
    const tool = createPlanProposeTool(service)
    const ctx = toolContext({ conversationId: 'c1' })

    const noTitle = await tool.execute({ steps: [{ title: '一步' }] }, ctx)
    expect(noTitle.isError).toBe(true)
    expect(noTitle.content).toContain('title')

    const noSteps = await tool.execute({ title: '标题', steps: [] }, ctx)
    expect(noSteps.isError).toBe(true)
    expect(noSteps.content).toContain('title')
  })

  it('plan_propose：某一步没写标题时说清是哪一步', async () => {
    const service = new PlanModeService()
    const tool = createPlanProposeTool(service)
    const result = await tool.execute({ title: '标题', steps: ['   '] }, toolContext({ conversationId: 'c1' }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('标题')
  })

  it('plan_read：读得到计划、状态与被打回的反馈', async () => {
    const service = new PlanModeService()
    service.enable('c1')
    const propose = createPlanProposeTool(service)
    const read = createPlanReadTool(service)
    const ctx = toolContext({ conversationId: 'c1' })

    const empty = await read.execute({}, ctx)
    expect(empty.content).toContain('还没有计划')

    await propose.execute({ title: '标题', steps: [{ title: '一步' }] }, ctx)
    const pending = await read.execute({}, ctx)
    expect(pending.content).toContain('状态：proposed')
    expect(pending.content).toContain('等人批准')

    service.reject('c1', '换个别的方式')
    const rejected = await read.execute({}, ctx)
    expect(rejected.content).toContain('状态：rejected')
    expect(rejected.content).toContain('换个别的方式')

    service.approve('c1')
    const approved = await read.execute({}, ctx)
    expect(approved.content).toContain('状态：approved')
    expect(approved.content).toContain('现在可以动手了')
  })
})
