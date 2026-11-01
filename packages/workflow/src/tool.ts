/**
 * 模型看得见的那件工具：`workflow`。
 *
 * 模型用它写一段**编排脚本**：脚本里能派子代理、能等子代理，最后带回一个值。
 * 跟 `subagent` 那件工具的区别是——`subagent` 是「派一趟活」，`workflow` 是
 * 「派一批活、并把它们的结论合起来」，多步的活交给模型自己排顺序。
 *
 * 工具只做三件事：把参数parse成一次编排请求、跑、把结果整理成一段给模型看的文本。
 * @module @ryharness/workflow/tool
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { WorkflowEngine } from './engine.ts'
import type { WorkflowResult } from './types.ts'

/** 编排工具的名字。 */
export const WORKFLOW_TOOL_NAME = 'workflow'

/** 工具的构造参数。 */
export interface WorkflowToolOptions {
  /** 编排引擎。 */
  engine: WorkflowEngine
}

/**
 * 建 `workflow` 工具。
 * @param options - 编排引擎。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createWorkflowTool(options: WorkflowToolOptions): Tool {
  return {
    name: WORKFLOW_TOOL_NAME,
    description:
      '写一段编排脚本，把活派给子代理并行去做，最后拿回一个结果。' +
      '脚本里能用四个函数：spawnAgent(任务) 派一个、spawnAgents([任务…]) 一次派多个（并行）、' +
      'awaitAgent(id) 等一个、awaitAgents([id…]) 等一批（结果按传入顺序）。' +
      '这四个都是异步的，调用要 await（const id = await spawnAgent("查一下")）。' +
      '适合「同一件事拆成几块同时查」这类多步活；只是一趟活的话用 subagent 就够了。',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            '编排脚本（JavaScript）。可以 await 顶层调用；最后 return 一个值，那就是这次编排的结果。' +
            '脚本里调的函数都是异步的，要 await 才拿到结果。' +
            '子代理看不到我们的对话历史，任务描述要写全。',
        },
        description: {
          type: 'string',
          description: '可选：这次编排要干什么（一句话），记在运行记录里，方便回头查。',
        },
      },
      required: ['script'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const request = parseArgs(args)
      if (request === undefined) {
        return { content: '缺少 script 参数：没有脚本就没法编排。', isError: true }
      }
      const result = await options.engine.run({
        script: request.script,
        ...(request.description === undefined ? {} : { description: request.description }),
        context: ctx,
      })
      if (!result.ok) {
        return { content: `编排没跑完：${result.failure?.message ?? '原因不明'}`, isError: true }
      }
      return { content: renderWorkflowResult(result) }
    },
  }
}

/** 解析工具参数。 */
function parseArgs(args: unknown): { script: string; description?: string } | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const script = record.script
  if (typeof script !== 'string' || script.trim().length === 0) return undefined
  const description = record.description
  return {
    script: script.trim(),
    ...(typeof description === 'string' && description.trim().length > 0 ? { description: description.trim() } : {}),
  }
}

/**
 * 编排结果给模型看的正文。
 *
 * 三块：脚本的返回值（结论在前）、脚本打印的东西、派出去的子代理（谁、跑成什么样）。
 */
export function renderWorkflowResult(result: WorkflowResult): string {
  const lines: string[] = []
  if (result.value !== undefined) {
    lines.push(`结果：${formatValue(result.value)}`)
  } else {
    lines.push('结果：脚本没有返回值。')
  }
  if (result.output.length > 0) {
    lines.push('脚本输出：', ...result.output.map((line) => `  ${line}`))
  }
  if (result.agents.length > 0) {
    lines.push('子代理：')
    for (const agent of result.agents) {
      const label = agent.label === undefined ? '' : `（${agent.label}）`
      const detail = agent.status === 'completed' ? (agent.text ?? '') : (agent.error ?? agent.status)
      lines.push(`  ${agent.id}${label} [${agent.status}] ${detail}`)
    }
  }
  lines.push(`（这次编排用了 ${result.durationMs} 毫秒，派了 ${result.agents.length} 个子代理）`)
  return lines.join('\n')
}

/** 值怎么写给模型看。 */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
