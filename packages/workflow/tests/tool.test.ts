import type { ToolContext } from '@ryharness/agent'
import { NodePtcRuntime } from '@ryharness/ptc'
import {
  createInMemoryWorkflowExecutor,
  createWorkflowTool,
  renderWorkflowResult,
  WORKFLOW_TOOL_NAME,
  WorkflowEngine,
} from '@ryharness/workflow'
import { describe, expect, it } from 'vitest'

const CTX: ToolContext = { workspaceRoot: 'F:/workspace' }

/** 造一个工具（真运行时 + 内存执行器）。 */
function tool(): ReturnType<typeof createWorkflowTool> {
  return createWorkflowTool({
    engine: new WorkflowEngine({ runtime: new NodePtcRuntime(), executor: createInMemoryWorkflowExecutor() }),
  })
}

describe('workflow 工具', () => {
  it('工具名就是 workflow', () => {
    expect(WORKFLOW_TOOL_NAME).toBe('workflow')
    expect(tool().name).toBe('workflow')
  })

  it('工具描述里说明了脚本能用什么', () => {
    const description = tool().description
    expect(description).toContain('spawnAgent')
    expect(description).toContain('awaitAgents')
  })

  it('参数只有 script 与可选的 description', () => {
    const parameters = tool().parameters
    expect(parameters.required).toEqual(['script'])
    const properties = parameters.properties as Record<string, unknown>
    expect(Object.keys(properties).sort()).toEqual(['description', 'script'])
  })

  it('缺 script 时回一条错误结果，不抛异常', async () => {
    const result = await tool().execute({}, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少 script')
  })

  it('script 是空白时也当没给', async () => {
    const result = await tool().execute({ script: '   ' }, CTX)
    expect(result.isError).toBe(true)
  })

  it('跑完之后把结果整理成一段给模型看的文本', async () => {
    const result = await tool().execute({ script: 'return "拼好的结论"' }, CTX)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('拼好的结论')
  })

  it('脚本没返回值时也说得清楚', async () => {
    const result = await tool().execute({ script: 'const a = 1' }, CTX)
    expect(result.content).toContain('脚本没有返回值')
  })

  it('编排失败时回一条错误结果', async () => {
    const result = await tool().execute({ script: 'throw new Error("编排炸了")' }, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('编排没跑完')
  })

  it('description 参数不填也不影响', async () => {
    const result = await tool().execute({ script: 'return 1' }, CTX)
    expect(result.isError).toBeUndefined()
  })
})

describe('结果正文', () => {
  it('结论在前、子代理在后', () => {
    const text = renderWorkflowResult({
      ok: true,
      output: ['脚本打印的一句'],
      value: '结论',
      agents: [{ id: 'wf-1', task: '查甲', status: 'completed', text: '甲的结论', durationMs: 12 }],
      durationMs: 30,
    })
    expect(text.indexOf('结论：结论')).toBeLessThan(text.indexOf('子代理：'))
    expect(text).toContain('wf-1 [completed] 甲的结论')
    expect(text).toContain('脚本打印的一句')
  })

  it('派了零个子代理时也说得清楚', () => {
    const text = renderWorkflowResult({ ok: true, output: [], agents: [], durationMs: 5 })
    expect(text).toContain('派了 0 个子代理')
  })
})
