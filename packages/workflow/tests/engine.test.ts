import { NodePtcRuntime } from '@ryharness/ptc'
import type { WorkflowAgentExecutor, WorkflowAgentRequest } from '@ryharness/workflow'
import { createInMemoryWorkflowExecutor, DEFAULT_WORKFLOW_MAX_FAN_OUT, WorkflowEngine } from '@ryharness/workflow'
import { describe, expect, it } from 'vitest'

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 造一个引擎（用真的 PTC 运行时 + 内存执行器）。 */
function engine(executor: WorkflowAgentExecutor, maxFanOut?: number): WorkflowEngine {
  return new WorkflowEngine({
    runtime: new NodePtcRuntime(),
    executor,
    ...(maxFanOut === undefined ? {} : { maxFanOut }),
  })
}

describe('编排脚本', () => {
  it('脚本的返回值回到结果里', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'return { done: 3 }' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ done: 3 })
    await run.dispose()
  })

  it('脚本打印的内容回到 output', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'console.log("第一步"); console.log("第二步"); return "ok"' })
    expect(result.output).toEqual(['第一步', '第二步'])
    await run.dispose()
  })

  it('空脚本是一条失败，不抛异常', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: '   ' })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('syntax')
    await run.dispose()
  })

  it('引擎收摊之后不再接活', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    await run.dispose()
    const result = await run.run({ script: 'return 1' })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('已经关掉了')
  })
})

describe('扇出', () => {
  it('一次派多个子代理，它们是并行跑的', async () => {
    const events: string[] = []
    const executor = createInMemoryWorkflowExecutor({
      handler: async (request: WorkflowAgentRequest) => {
        events.push(`start:${request.id}`)
        await sleep(60)
        events.push(`end:${request.id}`)
        return `结论：${request.task}`
      },
    })
    const run = engine(executor)
    const result = await run.run({
      script: 'const ids = await spawnAgents(["查甲", "查乙", "查丙"]); return await awaitAgents(ids)',
    })
    expect(result.ok).toBe(true)
    // 三个都先开始、再各自结束：串行的话第一个 end 会排在第二个 start 前面。
    expect(
      events.slice(0, 3).every((event) => {
        return event.startsWith('start:')
      }),
    ).toBe(true)
    await run.dispose()
  })

  it('结果按派出的顺序收集，不按跑完的顺序', async () => {
    const executor = createInMemoryWorkflowExecutor({
      handler: async (request: WorkflowAgentRequest) => {
        await sleep(request.task === '慢的' ? 120 : 10)
        return `结论：${request.task}`
      },
    })
    const run = engine(executor)
    const result = await run.run({
      script: 'const ids = await spawnAgents(["慢的", "快的"]); return await awaitAgents(ids)',
    })
    expect(result.value).toEqual(['结论：慢的', '结论：快的'])
    await run.dispose()
  })

  it('派出去的子代理按顺序留下记录', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({
      script: 'spawnAgents(["甲", "乙"]); await awaitAgents(["wf-1", "wf-2"]); return "ok"',
    })
    expect(
      result.agents.map((agent) => {
        return agent.task
      }),
    ).toEqual(['甲', '乙'])
    expect(result.agents[0]?.status).toBe('completed')
    await run.dispose()
  })

  it('超过扇出上限就不派了，编排失败并说清原因', async () => {
    const executor = createInMemoryWorkflowExecutor()
    const run = engine(executor, 2)
    const result = await run.run({
      script: 'spawnAgents(["一", "二", "三"]); return "派完了"',
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('limit')
    expect(result.failure?.message).toContain('一次最多派 2 个子代理')
    expect(result.agents.length).toBe(2)
    await run.dispose()
  })

  it('默认的扇出上限是 8', () => {
    expect(DEFAULT_WORKFLOW_MAX_FAN_OUT).toBe(8)
  })

  it('上限之内可以派满', async () => {
    const run = engine(createInMemoryWorkflowExecutor(), 3)
    const result = await run.run({ script: 'const ids = await spawnAgents(["一", "二", "三"]); return ids.length' })
    expect(result.ok).toBe(true)
    expect(result.value).toBe(3)
    await run.dispose()
  })

  it('任务描述不是字符串时说得清楚', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'return await spawnAgent(42)' })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('任务描述')
    await run.dispose()
  })

  it('spawnAgents 要的是数组', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'return await spawnAgents("不是一个数组")' })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('任务数组')
    await run.dispose()
  })

  it('等一个不存在的子代理会说清楚', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'return await awaitAgent("wf-999")' })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('没有这个子代理')
    await run.dispose()
  })

  it('awaitAgents 要的是 id 数组', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'return await awaitAgents("不是一个数组")' })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('id 数组')
    await run.dispose()
  })

  it('标签能传给执行器，也记在记录里', async () => {
    const seen: string[] = []
    const executor = createInMemoryWorkflowExecutor({
      handler: (request) => {
        seen.push(request.label ?? '无标签')
        return 'ok'
      },
    })
    const run = engine(executor)
    const result = await run.run({
      script: 'const id = await spawnAgent("带标签的活", "第一批"); await awaitAgent(id); return "ok"',
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['第一批'])
    expect(result.agents[0]?.label).toBe('第一批')
    await run.dispose()
  })
})

describe('子代理失败', () => {
  it('脚本能接住（try/catch）', async () => {
    const executor: WorkflowAgentExecutor = {
      async run() {
        return { text: '', status: 'failed', error: '子代理跑挂了' }
      },
    }
    const run = engine(executor)
    const result = await run.run({
      script:
        'try { const id = await spawnAgent("会失败"); await awaitAgent(id) } catch (error) { return "接住了：" + error.message }',
    })
    expect(result.ok).toBe(true)
    expect(String(result.value)).toContain('接住了')
    await run.dispose()
  })

  it('没接住就是这次编排的失败', async () => {
    const executor: WorkflowAgentExecutor = {
      async run() {
        return { text: '', status: 'failed', error: '子代理跑挂了' }
      },
    }
    const run = engine(executor)
    const result = await run.run({
      script: 'const id = await spawnAgent("会失败"); return await awaitAgent(id)',
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('子代理跑挂了')
    expect(result.agents[0]?.status).toBe('failed')
    await run.dispose()
  })

  it('子代理超时也按失败算', async () => {
    const executor: WorkflowAgentExecutor = {
      async run() {
        return { text: '', status: 'timeout', error: '子代理超时了' }
      },
    }
    const run = engine(executor)
    const result = await run.run({
      script: 'const id = await spawnAgent("会超时"); return await awaitAgent(id)',
    })
    expect(result.ok).toBe(false)
    expect(result.failure?.message).toContain('子代理超时了')
    expect(result.agents[0]?.status).toBe('timeout')
    await run.dispose()
  })

  it('执行器自己抛错也算失败，脚本接得住', async () => {
    const executor: WorkflowAgentExecutor = {
      async run(): Promise<never> {
        throw new Error('执行器炸了')
      },
    }
    const run = engine(executor)
    const result = await run.run({
      script:
        'try { const id = await spawnAgent("会炸"); await awaitAgent(id) } catch (error) { return "接住了：" + error.message }',
    })
    expect(result.ok).toBe(true)
    expect(String(result.value)).toContain('接住了')
    await run.dispose()
  })
})

describe('时限与收尾', () => {
  it('脚本跑太久就是一次超时失败', async () => {
    const run = engine(createInMemoryWorkflowExecutor())
    const result = await run.run({ script: 'while (true) {}', timeoutMs: 400 })
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('timeout')
    await run.dispose()
  })

  it('编排收摊时，没被脚本收走的子代理会被中止', async () => {
    let aborted = false
    const executor: WorkflowAgentExecutor = {
      run(request: WorkflowAgentRequest): Promise<{ text: string; status: 'completed' }> {
        return new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ text: '被中止了', status: 'completed' })
          })
        })
      },
    }
    const run = engine(executor)
    const result = await run.run({ script: 'const id = await spawnAgent("没人等它"); return "跑完了"' })
    expect(result.ok).toBe(true)
    expect(aborted).toBe(true)
    await run.dispose()
  })
})
