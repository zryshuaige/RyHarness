/**
 * 边界：参数不合法、查询条件、provider 抛错、工具集裁剪。
 *
 * 主路径在 subagent.test.ts 与 service.test.ts 里；这一份盯那些「不该发生但要
 * 说清楚」的分支——它们平时没人碰，出问题时父代理拿到的是一句看不懂的话。
 */
import type { SubagentProvider } from '@ryharness/subagent'
import { SubagentService } from '@ryharness/subagent'
import { describe, expect, it } from 'vitest'
import {
  CHILD_SYSTEM,
  echoTool,
  isChildRequest,
  makeRuntime,
  ScriptedAdapter,
  textChunks,
  toolCallChunks,
  waitUntil,
} from './helpers.ts'

/** 建一个服务：路由与子代理提示词都定死。 */
function serviceOf(llm: Awaited<ReturnType<typeof makeRuntime>>): SubagentService {
  return new SubagentService({
    llm,
    route: { provider: 'mock', model: 'mock-model' },
    systemPrompt: CHILD_SYSTEM,
    timeoutMs: 5000,
  })
}

describe('委派参数与查询', () => {
  it('任务描述是空的：服务自己就拒绝，不起子代理', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
    })
    const result = await service.delegate({ task: '   ' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('任务描述是空的')
    expect(service.listRuns()).toHaveLength(0)
  })

  it('参数根本不是一个对象时，工具回错误而不是抛异常', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
    })
    const result = await service.modelTools[0]?.execute('不是对象', { workspaceRoot: process.cwd() })
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('缺少 task 参数')
  })

  it('记录按会话与状态过滤；查不到的 id 给 undefined', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('子代理结论：做完了。'))
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
    })
    await service.delegate({ task: '一号的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    await service.delegate({ task: '二号的活' }, { workspaceRoot: process.cwd(), conversationId: 'c2' })

    expect(service.listRuns({ conversationId: 'c1' })).toHaveLength(1)
    expect(service.listRuns({ conversationId: 'c9' })).toHaveLength(0)
    expect(service.listRuns({ status: 'completed' })).toHaveLength(2)
    expect(service.listRuns({ status: 'failed' })).toHaveLength(0)
    expect(service.getRun('sub-1')?.task).toBe('一号的活')
    expect(service.getRun('sub-404')).toBeUndefined()
  })

  it('resolveRoute 按上下文换路由：宿主一行会话多个 agent 时用', async () => {
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'default-model' },
      resolveRoute: (ctx) => {
        return { provider: 'mock', model: ctx.agentId === 'a1' ? 'model-a' : 'model-b' }
      },
      systemPrompt: CHILD_SYSTEM,
    })
    await service.delegate({ task: '按 agent 换模型' }, { workspaceRoot: process.cwd(), agentId: 'a1' })
    expect(service.listRuns()[0]?.route.model).toBe('model-a')
  })

  it('工具集可以整体换掉，也可以只给一份白名单', async () => {
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      return toolCallChunks('subagent', { task: '一号的活' })
    })
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
    })
    service.setTools([echoTool], ['echo', 'subagent'])
    await service.delegate({ task: '一号的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    const childRequest = adapter.requests.find((request) => isChildRequest(request))
    // 白名单里写了 subagent 也没用：委派工具照样被裁掉。
    expect((childRequest?.tools ?? []).map((tool) => tool.name)).toEqual(['echo'])
  })
})

describe('provider 出错', () => {
  it('provider 抛的不是 Error 时，父代理也拿到一句读得懂的话', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
    })
    const broken: SubagentProvider = {
      id: 'broken',
      async run() {
        throw '连接断了'
      },
    }
    service.registerProvider(broken)
    const result = await service.delegate(
      { task: '交给会炸的 provider', provider: 'broken' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('子代理失败')
    expect(result.error).toContain('连接断了')
  })

  it('provider 抛的是 Error 时，父代理拿到的是那句错误消息', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const broken: SubagentProvider = {
      id: 'broken',
      async run() {
        throw new Error('供应商熔断了')
      },
    }
    service.registerProvider(broken)
    const result = await service.delegate(
      { task: '交给会炸的 provider', provider: 'broken' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    expect(result.error).toContain('供应商熔断了')
  })

  it('provider 说失败却没给原因时，工具里落的是状态名', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const blunt: SubagentProvider = {
      id: 'blunt',
      async run(input) {
        return { id: input.id, text: '', tools: [], steps: 1, status: 'failed' }
      },
    }
    // 只装这一个 provider：模型看不见 provider 这个参数，委派走的是默认那一个。
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
      providers: [blunt],
    })
    const result = await service.modelTools[0]?.execute(
      { task: '交给一个话少的 provider' },
      { workspaceRoot: process.cwd(), conversationId: 'c1' },
    )
    expect(result?.isError).toBe(true)
    expect(result?.content).toContain('failed')
  })
})

describe('列表工具看到的三种状态', () => {
  it('父对话被打断时，子代理跟着停', async () => {
    const adapter = new ScriptedAdapter(async (options) => {
      if (isChildRequest(options)) {
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
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const controller = new AbortController()
    const pending = service.delegate(
      { task: '一个跑很久的活' },
      { workspaceRoot: process.cwd(), conversationId: 'c1', signal: controller.signal },
    )
    await waitUntil(() => {
      return adapter.requests.some((request) => isChildRequest(request))
    })
    controller.abort()
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.error).toContain('取消')
  })

  it('一个 provider 都没装时，委派给出可读的错误', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('不该被问到。'))
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
      systemPrompt: CHILD_SYSTEM,
      providers: [],
    })
    const result = await service.delegate({ task: '没 provider 的活' }, { workspaceRoot: process.cwd() })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('没有可用的子代理 provider')
  })

  it('不配系统提示时，子代理用的是包内那段内置提示', async () => {
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) return textChunks('子代理结论：做完了。')
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = new SubagentService({
      llm,
      route: { provider: 'mock', model: 'mock-model' },
    })
    await service.delegate({ task: '一号的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    const childRequest = adapter.requests.find((request) => (request.system ?? '').includes('你是子代理'))
    expect(childRequest?.system).toContain('你也不能再把活派给别的子代理')
  })

  it('还在跑的时候，列表里看得到它跑到哪儿了', async () => {
    const adapter = new ScriptedAdapter(async (options) => {
      if (isChildRequest(options)) {
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
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const pending = service.delegate({ task: '一个跑很久的活' }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    await waitUntil(() => {
      return adapter.requests.some((request) => isChildRequest(request))
    })
    const listed = await service.modelTools[1]?.execute({}, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    expect(listed?.content).toContain('[running]')
    expect(listed?.content).toContain('还没动过工具')

    await service.endRound('c1')
    await pending
  })

  it('跑挂之后，列表里写的是失败原因；任务太长时摘要会截断', async () => {
    const adapter = new ScriptedAdapter((options) => {
      if (isChildRequest(options)) throw new Error('供应商连接断了')
      return textChunks('父代理没派活。')
    })
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    const longTask = `查清楚 ${'每个目录都翻一遍 '.repeat(6)}`
    await service.delegate({ task: longTask }, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    const listed = await service.modelTools[1]?.execute({}, { workspaceRoot: process.cwd(), conversationId: 'c1' })
    expect(listed?.content).toContain('[failed]')
    expect(listed?.content).toContain('供应商连接断了')
    expect(listed?.content).toContain('…')
  })

  it('没有会话 id 时，列表把全部记录都列出来', async () => {
    const adapter = new ScriptedAdapter(() => textChunks('子代理结论：做完了。'))
    const llm = await makeRuntime(adapter)
    const service = serviceOf(llm)
    await service.delegate({ task: '一号的活' }, { workspaceRoot: process.cwd() })
    const listed = await service.modelTools[1]?.execute({}, { workspaceRoot: process.cwd() })
    expect(listed?.content).toContain('sub-1')
  })
})
