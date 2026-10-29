/**
 * 子代理服务：记录、轮次、回收与 provider 注册。
 *
 * 这一份盯的是「父代理看不见的那一面」：谁在跑、跑了多久、这一轮结束时有没有被
 * 收回来。委派本身的行为在 subagent.test.ts 里。
 */
import type { SubagentProvider } from '@ryharness/subagent'
import { SubagentService } from '@ryharness/subagent'
import { describe, expect, it } from 'vitest'
import { CHILD_SYSTEM, isChildRequest, makeRuntime, ScriptedAdapter, textChunks, waitUntil } from './helpers.ts'

/** 建一个服务：路由与子代理提示词都定死。 */
function serviceOf(llm: Awaited<ReturnType<typeof makeRuntime>>): SubagentService {
  return new SubagentService({
    llm,
    route: { provider: 'mock', model: 'mock-model' },
    systemPrompt: CHILD_SYSTEM,
    timeoutMs: 5000,
  })
}

/** 挂到信号被 abort 才结束的脚本：模拟一个不响应的供应商。 */
async function hangUntilAbort(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('子代理的记录与列表', () => {
  it('subagent_list 列出这一轮起过的子代理：id、状态、任务摘要、结果摘要', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('子代理结论：共 42 个文件。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    await service.delegate({ task: '统计仓库里的文件数' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })

    const listed = await service.modelTools[1]?.execute({}, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    expect(listed?.content).toContain('sub-1')
    expect(listed?.content).toContain('[completed]')
    expect(listed?.content).toContain('统计仓库里的文件数')
    expect(listed?.content).toContain('共 42 个文件')
  })

  it('还没起过子代理时，列表工具给一句人话', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const listed = await service.modelTools[1]?.execute({}, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    expect(listed?.content).toBe('这一轮还没有起过子代理。')
  })

  it('model 参数覆盖路由：不填就跟父代理同一个模型', async () => {
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      return textChunks('没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    await service.delegate(
      { task: '统计文件数', model: 'other-model' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    const childRequest = adapter.requests.find((request) => isChildRequest(request))
    expect(childRequest?.model).toBe('other-model')
    expect(service.listRuns()[0]?.route).toEqual({ provider: 'mock', model: 'other-model' })
  })
})

describe('子代理的生命周期', () => {
  it('这一轮结束时，没跑完的子代理被回收；下一轮只看得到新起的那些', async () => {
    let childCalls = 0
    const adapter = new ScriptedAdapter(async (options) => {
      if (isChildRequest(options)) {
        childCalls += 1
        // 只有第一趟挂住不响应：第二趟是下一轮的活，得能正常跑完。
        if (childCalls === 1) {
          await hangUntilAbort(options.signal)
          return [
            {
              type: 'finish',
              reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
            },
          ]
        }
        return textChunks('子代理结论：下一轮做完了。')
      }
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
      // 超时给得很大：这一轮是被 endRound 收掉的，不是被超时收掉的。
      timeoutMs: 30_000,
    })

    const pending = service.delegate({ task: '一个跑很久的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    // 等子代理真的把请求发出去了：这时它正挂在供应商那边等回复。
    await waitUntil(() => {
      return adapter.requests.some((request) => isChildRequest(request))
    })
    expect(service.listRuns()[0]?.status).toBe('running')

    await service.endRound('c1')
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.error).toContain('取消')
    expect(service.listRuns()[0]?.status).toBe('failed')

    // 轮次推进了：这一轮起过的子代理不再出现在「当前轮」里。
    expect(service.listRuns({ conversationId: 'c1', round: 'current' })).toHaveLength(0)
    expect(service.listRuns({ conversationId: 'c1', round: 'all' })).toHaveLength(1)

    // 下一轮起的新子代理进的是新的一轮。
    await service.delegate({ task: '下一轮的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    const current = service.listRuns({ conversationId: 'c1', round: 'current' })
    expect(current).toHaveLength(1)
    expect(current[0]?.id).toBe('sub-2')
    expect(current[0]?.round).toBe(2)
  })

  it('dispose 回收所有会话的子代理', async () => {
    const adapter = new ScriptedAdapter(async (options) => {
      if (isChildRequest(options)) {
        await hangUntilAbort(options.signal)
        return [
          {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
          },
        ]
      }
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const pending = service.delegate({ task: '一个跑很久的活' }, { workspaceRoot: process.cwd(), conversationId: 'c2' })
    await waitUntil(() => {
      return service.listRuns().length === 1
    })
    await service.dispose()
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.error).toContain('取消')
  })
})

describe('子代理 provider 注册表', () => {
  it('注册进来的 provider 能被点名使用；没登记的 provider 给出可读的错误', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const fake: SubagentProvider = {
      id: 'fake',
      async run(input) {
        return { id: input.id, text: '假 provider 的结论', tools: [], steps: 1, status: 'completed' }
      },
    }
    service.registerProvider(fake)
    expect(service.listProviders().map((provider) => provider.id)).toContain('fake')

    const result = await service.delegate(
      { task: '交给假 provider', provider: 'fake' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    expect(result.text).toBe('假 provider 的结论')
    expect(result.status).toBe('completed')

    const missing = await service.delegate(
      { task: '交给不存在的 provider', provider: 'nope' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    expect(missing.status).toBe('failed')
    expect(missing.error).toContain('没有可用的子代理 provider')
  })
})
