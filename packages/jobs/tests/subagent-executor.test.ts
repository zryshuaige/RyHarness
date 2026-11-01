/**
 * 子代理执行器的用例：把后台任务接到本仓现成的「耗时活」原语上。
 */

import type { SubagentRequest } from '@ryharness/subagent'
import { describe, expect, it } from 'vitest'
import { createSubagentJobExecutor, JobService, type SubagentDelegate } from '../src/index.ts'
import { toolContext, waitUntil } from './helpers.ts'

describe('子代理执行器', () => {
  it('跑完交回子代理的结论', async () => {
    const requests: SubagentRequest[] = []
    const delegate: SubagentDelegate = {
      async delegate(request) {
        requests.push(request)
        return { id: 'sub-1', text: '结论：这么做', tools: [], steps: 1, status: 'completed' }
      },
    }
    const service = new JobService({ executors: [createSubagentJobExecutor(delegate)] })
    const job = service.start(
      { kind: 'subagent', task: '查清楚这个函数怎么用' },
      toolContext({ agentId: 'a1', conversationId: 'c1' }),
    )

    await waitUntil(() => service.get(job.id, { agentId: 'a1' })?.status === 'succeeded')
    const done = service.get(job.id, { agentId: 'a1' })
    expect(done?.result).toBe('结论：这么做')
    expect(done?.phases[0]?.summary).toBe('结论：这么做')
    expect(requests[0]?.task).toBe('查清楚这个函数怎么用')
  })

  it('子代理没跑完：后台任务跟着失败', async () => {
    const delegate: SubagentDelegate = {
      async delegate() {
        return { id: 'sub-2', text: '', tools: [], steps: 0, status: 'failed', error: '子代理挂了' }
      },
    }
    const service = new JobService({ executors: [createSubagentJobExecutor(delegate)] })
    const job = service.start({ kind: 'subagent', task: '会挂的活' }, toolContext({ agentId: 'a1' }))

    await waitUntil(() => service.get(job.id, { agentId: 'a1' })?.status === 'failed')
    const failed = service.get(job.id, { agentId: 'a1' })
    expect(failed?.error).toBe('子代理挂了')
    expect(failed?.phases[0]?.status).toBe('failed')
  })

  it('取消后台任务：子代理那边也会收到 abort', async () => {
    let seen: AbortSignal | undefined
    const delegate: SubagentDelegate = {
      async delegate(_request, ctx) {
        seen = ctx.signal
        await new Promise((resolve) => {
          setTimeout(resolve, 50)
        })
        return { id: 'sub-3', text: '迟到的结果', tools: [], steps: 1, status: 'completed' }
      },
    }
    const service = new JobService({ executors: [createSubagentJobExecutor(delegate)] })
    const job = service.start({ kind: 'subagent', task: '长活' }, toolContext({ agentId: 'a1' }))

    await waitUntil(() => seen !== undefined)
    service.cancel(job.id, { agentId: 'a1' })
    expect(seen?.aborted).toBe(true)
    // 迟到的结果不该把「已取消」改写成「成功」。
    await new Promise((resolve) => {
      setTimeout(resolve, 80)
    })
    expect(service.get(job.id, { agentId: 'a1' })?.status).toBe('cancelled')
  })
})
