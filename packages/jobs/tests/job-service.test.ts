/**
 * 后台任务服务的用例：状态流转、完成通知、取消、归属。
 */

import { describe, expect, it } from 'vitest'
import { type JobCompletionNotice, JobService } from '../src/index.ts'
import { failingExecutor, fixedExecutor, GatedExecutor, toolContext, waitUntil } from './helpers.ts'

describe('JobService', () => {
  it('排队 → 运行 → 成功：槽位满了后来的那个在排队', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated], maxConcurrency: 1 })
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })

    const first = service.start({ kind: 'gated', task: '第一趟活' }, ctx)
    const second = service.start({ kind: 'gated', task: '第二趟活' }, ctx)

    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')
    // 排队那个还没开始跑，耗时与起始时刻都还没开始记。
    expect(second.startedAt).toBeUndefined()

    gated.release(0)
    await waitUntil(() => service.get(first.id, { agentId: 'a1' })?.status === 'succeeded')

    const done = service.get(first.id, { agentId: 'a1' })
    expect(done?.status).toBe('succeeded')
    expect(done?.result).toBe('放行了')
    expect(done?.durationMs).toBeGreaterThanOrEqual(0)
    expect(done?.finishedAt).toBeGreaterThanOrEqual(done?.createdAt ?? 0)
    // 时间线上留得住每一步的耗时与结果摘要。
    expect(done?.phases[0]?.label).toBe('执行任务')
    expect(done?.phases[0]?.status).toBe('succeeded')
    expect(done?.phases[0]?.summary).toBe('放行了')
    expect(done?.phases[0]?.durationMs).toBeGreaterThanOrEqual(0)

    // 第一个腾出槽位，第二个接着跑。
    await waitUntil(() => service.get(second.id, { agentId: 'a1' })?.status === 'running')
    expect(service.get(second.id, { agentId: 'a1' })?.queuedMs).toBeGreaterThanOrEqual(0)
  })

  it('跑完通知宿主：通知里带最终状态、结果与该写进哪个会话', async () => {
    const notices: JobCompletionNotice[] = []
    const service = new JobService({
      executors: [fixedExecutor('quick', '结论在这儿')],
      onComplete: (notice) => {
        notices.push(notice)
      },
    })
    service.start(
      { kind: 'quick', task: '查一件事', steps: ['翻一遍', '写结论'] },
      toolContext({ agentId: 'a1', conversationId: 'c1' }),
    )

    await waitUntil(() => notices.length === 1)
    const notice = notices[0]
    expect(notice?.job.status).toBe('succeeded')
    expect(notice?.job.result).toBe('结论在这儿')
    expect(notice?.conversationId).toBe('c1')
    expect(notice?.ownerAgentId).toBe('a1')
    // 两步都记上了：没单独报告的那一步算「没走到」，不是失败。
    expect(notice?.job.phases.map((phase) => phase.status)).toEqual(['succeeded', 'skipped'])
  })

  it('任务失败：状态是失败，通知里带着原因', async () => {
    const notices: JobCompletionNotice[] = []
    const service = new JobService({
      executors: [failingExecutor('bad', '子代理挂了')],
      onComplete: (notice) => {
        notices.push(notice)
      },
    })
    service.start({ kind: 'bad', task: '会挂的活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))

    await waitUntil(() => notices.length === 1)
    expect(notices[0]?.job.status).toBe('failed')
    expect(notices[0]?.job.error).toBe('子代理挂了')
    expect(notices[0]?.job.phases[0]?.status).toBe('failed')
  })

  it('取消跑着的任务：立刻变成已取消，并且 abort 掉那趟活', async () => {
    const gated = new GatedExecutor()
    const notices: JobCompletionNotice[] = []
    const service = new JobService({
      executors: [gated],
      onComplete: (notice) => {
        notices.push(notice)
      },
    })
    service.start({ kind: 'gated', task: '长活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))
    await waitUntil(() => gated.contexts.length === 1)

    const cancelled = service.cancel('job-1', { agentId: 'a1', conversationId: 'c1' })
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.error).toContain('取消')
    // 取消信号真的发出去了：执行器那边能看见 aborted。
    expect(gated.contexts[0]?.toolContext.signal?.aborted).toBe(true)
    await waitUntil(() => notices.length === 1)
    expect(notices[0]?.job.status).toBe('cancelled')
  })

  it('取消排队的任务：它不会再开跑', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated], maxConcurrency: 1 })
    const ctx = toolContext({ agentId: 'a1', conversationId: 'c1' })
    service.start({ kind: 'gated', task: '第一趟' }, ctx)
    const queued = service.start({ kind: 'gated', task: '第二趟' }, ctx)
    expect(queued.status).toBe('queued')

    const cancelled = service.cancel(queued.id, { agentId: 'a1', conversationId: 'c1' })
    expect(cancelled?.status).toBe('cancelled')
    gated.release(0)
    await waitUntil(() => gated.contexts.length === 1)
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    // 取消掉的那个从没开跑过。
    expect(gated.contexts.length).toBe(1)
    expect(service.get(queued.id, { agentId: 'a1' })?.status).toBe('cancelled')
  })

  it('别的 agent 看不到别人的任务：查不到，也取消不了', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    service.start({ kind: 'gated', task: 'a1 的活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))
    await waitUntil(() => gated.contexts.length === 1)

    expect(service.list({ agentId: 'a2' })).toHaveLength(0)
    expect(service.get('job-1', { agentId: 'a2' })).toBeUndefined()
    expect(service.cancel('job-1', { agentId: 'a2' })).toBeUndefined()
    // 取消不掉：a1 的活还在跑。
    expect(service.get('job-1', { agentId: 'a1' })?.status).toBe('running')
  })

  it('跨会话不可见：同一个 agent 在另一个会话里看不到自己的那趟活', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    service.start({ kind: 'quick', task: '会话一的活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))

    expect(service.list({ agentId: 'a1', conversationId: 'c2' })).toHaveLength(0)
    expect(service.get('job-1', { agentId: 'a1', conversationId: 'c2' })).toBeUndefined()
    // 宿主按会话查得到。
    expect(service.list({ conversationId: 'c1' })).toHaveLength(1)
  })

  it('起任务时的入参不合法：起不了', () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const ctx = toolContext({ agentId: 'a1' })
    expect(() => service.start({ kind: 'quick', task: '  ' }, ctx)).toThrow(/任务描述/)
    expect(() => service.start({ kind: '没人认领', task: '活' }, ctx)).toThrow(/执行器/)
    // 一台机器上什么执行器都没注册时，起不了任务。
    const bare = new JobService()
    expect(() => bare.start({ task: '活' }, ctx)).toThrow(/任务类型/)
  })

  it('不写任务类型时用已注册的执行器；宿主配了默认类型就用默认那个', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '好了')] })
    const job = service.start({ task: '活' }, toolContext({ agentId: 'a1' }))
    expect(job.kind).toBe('quick')

    const withDefault = new JobService({
      executors: [fixedExecutor('a', 'A'), fixedExecutor('b', 'B')],
      defaultKind: 'b',
    })
    const picked = withDefault.start({ task: '活' }, toolContext({ agentId: 'a1' }))
    expect(picked.kind).toBe('b')
    await waitUntil(() => withDefault.get(picked.id, { agentId: 'a1' })?.status === 'succeeded')
  })

  it('宿主回调出错不该把任务带倒', async () => {
    const service = new JobService({
      executors: [fixedExecutor('quick', '好了')],
      onComplete: () => {
        throw new Error('写会话失败了')
      },
    })
    service.start({ kind: 'quick', task: '活' }, toolContext({ agentId: 'a1' }))
    await waitUntil(() => service.lastCallbackError !== undefined)
    expect(service.lastCallbackError).toBe('写会话失败了')
    expect(service.list({ agentId: 'a1' })[0]?.status).toBe('succeeded')
  })

  it('宿主回调返回的 promise 挂了也不该把任务带倒', async () => {
    const service = new JobService({
      executors: [fixedExecutor('quick', '好了')],
      onComplete: () => Promise.reject(new Error('写会话失败了')),
    })
    service.start({ kind: 'quick', task: '活' }, toolContext({ agentId: 'a1' }))
    await waitUntil(() => service.lastCallbackError !== undefined)
    expect(service.lastCallbackError).toBe('写会话失败了')
    expect(service.list({ agentId: 'a1' })[0]?.status).toBe('succeeded')
  })

  it('dispose：没跑完的任务全部停掉', async () => {
    const gated = new GatedExecutor()
    const service = new JobService({ executors: [gated] })
    service.start({ kind: 'gated', task: '长活' }, toolContext({ agentId: 'a1', conversationId: 'c1' }))
    await waitUntil(() => gated.contexts.length === 1)

    await service.dispose()
    expect(service.list({ agentId: 'a1' })[0]?.status).toBe('cancelled')
    expect(gated.contexts[0]?.toolContext.signal?.aborted).toBe(true)
  })

  it('注册执行器：同名覆盖后起任务走新的那个', async () => {
    const service = new JobService({ executors: [fixedExecutor('quick', '第一个')] })
    service.registerExecutor(fixedExecutor('quick', '第二个'))
    const job = service.start({ kind: 'quick', task: '活' }, toolContext({ agentId: 'a1' }))
    await waitUntil(() => service.get(job.id, { agentId: 'a1' })?.status === 'succeeded')
    expect(service.get(job.id, { agentId: 'a1' })?.result).toBe('第二个')
    expect(service.listExecutors()).toHaveLength(1)
  })
})
