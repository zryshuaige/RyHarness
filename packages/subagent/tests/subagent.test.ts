/**
 * 子代理：委派、上下文隔离、禁嵌套、失败与超时。
 *
 * 用真实的 cordis 上下文 + 真的 LlmRuntime + 假适配器：子代理这一族的价值全在
 * 「父代理拿到的是不是子代理真跑出来的结论」，只在桩上断言那个字符串等于什么都没验。
 */
import { SubagentService } from '@ryharness/subagent'
import { describe, expect, it } from 'vitest'
import {
  CHILD_SYSTEM,
  echoTool,
  isChildRequest,
  lastAssistantText,
  makeRuntime,
  requestText,
  runParent,
  ScriptedAdapter,
  textChunks,
  toolCallChunks,
  toolResultTexts,
} from './helpers.ts'

/** 建一个服务：路由、子代理提示词都定死，测试里只看行为。 */
function serviceOf(llm: Awaited<ReturnType<typeof makeRuntime>>): SubagentService {
  return new SubagentService({
    llm,
    route: { provider: 'mock', model: 'mock-model' },
    systemPrompt: CHILD_SYSTEM,
    timeoutMs: 5000,
  })
}

describe('子代理委派', () => {
  it('父代理拿到子代理的最终文本，以及跑了几步、用了哪些工具', async () => {
    let parentCalls = 0
    let childCalls = 0
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) {
        childCalls += 1
        // 子代理先用一个自己的工具，再给结论：两步，且工具记录要能看出来。
        return childCalls === 1 ? toolCallChunks('echo', { text: '统计' }) : textChunks('子代理结论：共 42 个文件。')
      }
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到：共 42 个文件。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const events = await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const results = toolResultTexts(events)
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('子代理结论：共 42 个文件。')
    expect(results[0]).toContain('用了工具 echo')
    expect(results[0]).toContain('子代理不能再起子代理')
    // 父代理自己那轮也拿到了结论。
    expect(lastAssistantText(events)).toContain('共 42 个文件')

    const runs = service.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'sub-1',
      status: 'completed',
      steps: 2,
      tools: ['echo'],
      conversationId: 'c1',
    })
    expect(runs[0]?.text).toBe('子代理结论：共 42 个文件。')
    expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('子代理只看到任务描述，看不到父对话的历史', async () => {
    let parentCalls = 0
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const childRequests = adapter.requests.filter((request) => isChildRequest(request))
    expect(childRequests.length).toBeGreaterThan(0)
    const first = childRequests[0]
    if (first === undefined) throw new Error('子代理没有发起请求')
    expect(requestText(first)).toContain('子任务：统计仓库里的文件数')
    // 父对话的历史一个字都不许漏进子代理的上下文。
    expect(requestText(first)).not.toContain('父代理的原始问题')
    expect(first.messages).toHaveLength(1)
  })

  it('子代理起不了子代理：委派工具根本不在它的工具集里', async () => {
    let parentCalls = 0
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    // 把父代理的工具集原样交给子代理：服务自己得把委派工具裁掉。
    service.setTools([echoTool, ...service.modelTools])
    await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const childRequests = adapter.requests.filter((request) => isChildRequest(request))
    const names = (childRequests[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('echo')
    expect(names).not.toContain('subagent')
    expect(names).not.toContain('subagent_list')
  })

  it('子代理幻觉出来的委派调用会被挡回去', async () => {
    // 模型硬要把 subagent 塞进来：子代理的工具集里没有它，循环按「未知工具」回错误。
    let childCalls = 0
    let parentCalls = 0
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) {
        childCalls += 1
        return childCalls === 1
          ? toolCallChunks('subagent', { task: '再派一层' })
          : textChunks('子代理结论：我自己干完了。')
      }
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const runs = service.listRuns()
    expect(runs[0]?.status).toBe('completed')
    const childRequests = adapter.requests.filter((request) => isChildRequest(request))
    // 子代理一个工具都没拿到：那一次幻觉调用落到「未知工具」上。
    expect(childRequests[0]?.tools ?? []).toHaveLength(0)
    const second = childRequests[1]
    if (second === undefined) throw new Error('子代理没有跑第二步')
    expect(requestText(second)).toContain('unknown tool "subagent"')
  })
})

describe('子代理的失败与超时', () => {
  it('子代理跑挂时，父代理拿到一句读得懂的中文错误', async () => {
    let parentCalls = 0
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) throw new Error('供应商连接断了')
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const events = await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const results = toolResultTexts(events)
    expect(results[0]).toContain('子代理没有跑完')
    expect(results[0]).toContain('失败')
    expect(service.listRuns()[0]?.status).toBe('failed')
  })

  it('子代理卡住时，超时把它收回来', async () => {
    let parentCalls = 0
    const adapter = new ScriptedAdapter(async (options) => {
      if (isChildRequest(options)) {
        // 挂住不动，直到信号被 abort：真实的供应商不回应就是这个形状。
        await new Promise<void>((resolve) => {
          const signal = options.signal
          if (signal === undefined) return
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return [
          {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } },
          },
        ]
      }
      parentCalls += 1
      return parentCalls === 1
        ? toolCallChunks('subagent', { task: '子任务：统计仓库里的文件数' })
        : textChunks('父代理收到。')
    })
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
      timeoutMs: 80,
    })
    const events = await runParent(llm, service.modelTools, '父代理的原始问题：统计仓库文件数')

    const results = toolResultTexts(events)
    expect(results[0]).toContain('超时')
    expect(results[0]).toContain('可以把任务拆小一点再派一次')
    const runs = service.listRuns()
    expect(runs[0]?.status).toBe('timeout')
  })

  it('任务描述是空的，直接回错误，不起子代理', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const result = await service.modelTools[0]?.execute({ task: '   ' }, { workspaceRoot: process.cwd() })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('缺少 task 参数')
    expect(service.listRuns()).toHaveLength(0)
  })
})
