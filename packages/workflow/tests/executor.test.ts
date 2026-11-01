import { createInMemoryWorkflowExecutor } from '@ryharness/workflow'
import { describe, expect, it } from 'vitest'

describe('内存执行器', () => {
  it('缺省时把任务原样回一句', async () => {
    const executor = createInMemoryWorkflowExecutor()
    const result = await executor.run({ id: 'wf-1', task: '查一下那家店' })
    expect(result.status).toBe('completed')
    expect(result.text).toContain('查一下那家店')
  })

  it('handler 可以自己定结果', async () => {
    const executor = createInMemoryWorkflowExecutor({
      handler: (request) => {
        return `答复：${request.task}`
      },
    })
    const result = await executor.run({ id: 'wf-1', task: '那家店' })
    expect(result.text).toBe('答复：那家店')
  })

  it('handler 可以是异步的', async () => {
    const executor = createInMemoryWorkflowExecutor({
      handler: async (request) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })
        return `慢答复：${request.task}`
      },
    })
    const result = await executor.run({ id: 'wf-1', task: '那家店' })
    expect(result.text).toBe('慢答复：那家店')
  })

  it('delayMs 让每个任务先磨蹭一会儿', async () => {
    const executor = createInMemoryWorkflowExecutor({ delayMs: 40 })
    const started = Date.now()
    await executor.run({ id: 'wf-1', task: '慢活' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
  })

  it('标签与 id 原样递给 handler', async () => {
    let seen = ''
    const executor = createInMemoryWorkflowExecutor({
      handler: (request) => {
        seen = `${request.id}/${request.label ?? '无标签'}`
        return 'ok'
      },
    })
    await executor.run({ id: 'wf-7', task: '活', label: '第一批' })
    expect(seen).toBe('wf-7/第一批')
  })
})
