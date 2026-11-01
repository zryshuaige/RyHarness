/**
 * 后台任务四件工具的用例：起、查、取、取消。
 */

import { describe, expect, it } from 'vitest'
import {
  createJobCancelTool,
  createJobListTool,
  createJobResultTool,
  createJobStartTool,
  JobService,
} from '../src/index.ts'
import { failingExecutor, fixedExecutor, GatedExecutor, toolContext, waitUntil } from './helpers.ts'

describe('后台任务工具', () => {
  it('job_start：登记完就回话，任务在后台自己跑', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    const tool = createJobStartTool(service)

    const result = await tool.execute({ task: '跑一趟长活', steps: ['第一步'] }, toolContext({ agentId: 'a1' }))
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('job-1')
    expect(result.content).toContain('别在这儿等它')
    await waitUntil(() => gated.contexts.length === 1)
    expect(service.list({ agentId: 'a1' })[0]?.status).toBe('running')
  })

  it('job_start：参数不对时把原因说清楚', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const tool = createJobStartTool(service)

    const missing = await tool.execute({}, toolContext({ agentId: 'a1' }))
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('task')

    const unknownKind = await tool.execute({ task: '活', kind: '没人认领' }, toolContext({ agentId: 'a1' }))
    expect(unknownKind.isError).toBe(true)
    expect(unknownKind.content).toContain('执行器')
  })

  it('job_list：只列你自己的任务', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const start = createJobStartTool(service)
    const list = createJobListTool(service)

    await start.execute({ task: 'a1 的活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))

    const mine = await list.execute({}, toolContext({ agentId: 'a1', conversationId: 'c1' }))
    expect(mine.content).toContain('job-1')

    const other = await list.execute({}, toolContext({ agentId: 'a2', conversationId: 'c1' }))
    expect(other.content).toContain('还没有你起过的后台任务')
  })

  it('job_result：跑完给结果，还在跑就明说还在跑', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    const start = createJobStartTool(service)
    const result = createJobResultTool(service)
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })

    await start.execute({ task: '长活' }, ctx)
    await waitUntil(() => gated.contexts.length === 1)

    const running = await result.execute({ jobId: 'job-1' }, ctx)
    expect(running.isError).toBeUndefined()
    expect(running.content).toContain('还在跑')

    gated.release(0)
    await waitUntil(() => service.get('job-1', { agentId: 'a1' })?.status === 'succeeded')

    const done = await result.execute({ jobId: 'job-1' }, ctx)
    expect(done.content).toContain('放行了')
  })

  it('job_result：别人的任务查不到', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const start = createJobStartTool(service)
    const result = createJobResultTool(service)

    await start.execute({ task: 'a1 的活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))
    const denied = await result.execute({ jobId: 'job-1' }, toolContext({ agentId: 'a2', conversationId: 'c1' }))
    expect(denied.isError).toBe(true)
    expect(denied.content).toContain('没有这个任务')

    const noId = await result.execute({}, toolContext({ agentId: 'a1' }))
    expect(noId.isError).toBe(true)
    expect(noId.content).toContain('jobId')
  })

  it('job_result：没跑成的与被取消的都说清楚', async () => {
    const service = new JobService({ executors: [failingExecutor('bad', '子代理挂了')] })
    const start = createJobStartTool(service)
    const result = createJobResultTool(service)
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })

    await start.execute({ task: '会挂的活', kind: 'bad' }, ctx)
    await waitUntil(() => service.list({ agentId: 'a1' })[0]?.status === 'failed')
    const failed = await result.execute({ jobId: 'job-1' }, ctx)
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('子代理挂了')
  })

  it('job_result：被取消的任务没结果，但不算错', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    const start = createJobStartTool(service)
    const cancel = createJobCancelTool(service)
    const result = createJobResultTool(service)
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })

    await start.execute({ task: '长活' }, ctx)
    await waitUntil(() => gated.contexts.length === 1)
    await cancel.execute({ jobId: 'job-1' }, ctx)

    const cancelled = await result.execute({ jobId: 'job-1' }, ctx)
    expect(cancelled.isError).toBeUndefined()
    expect(cancelled.content).toContain('已被取消')
  })

  it('job_cancel：没给 jobId 时说清楚', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const cancel = createJobCancelTool(service)
    const result = await cancel.execute({}, toolContext({ agentId: 'a1' }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('jobId')
  })

  it('job_cancel：取消跑着的任务；已结束的取消不了', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    const start = createJobStartTool(service)
    const cancel = createJobCancelTool(service)
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })

    await start.execute({ task: '长活' }, ctx)
    await waitUntil(() => gated.contexts.length === 1)

    const cancelled = await cancel.execute({ jobId: 'job-1' }, ctx)
    expect(cancelled.isError).toBeUndefined()
    expect(cancelled.content).toContain('已取消')

    const again = await cancel.execute({ jobId: 'job-1' }, ctx)
    expect(again.content).toContain('已经收尾了')

    const missing = await cancel.execute({ jobId: 'job-9' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('没有这个任务')
  })
})
