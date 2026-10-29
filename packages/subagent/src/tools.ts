/**
 * 模型看得见的两件工具：`subagent`（派活）与 `subagent_list`（查这轮起过谁）。
 *
 * 这两个工具是子代理这一族对外的唯一入口。模型能提的要求只有两个：派什么活、
 * 用哪个模型；步数、时长、工具白名单都不归模型管——模型只要学会「派活」和
 * 「查进度」，剩下的复杂度留给服务。
 * @module @ryharness/subagent/tools
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import { summary } from './format.ts'
import type { SubagentRequest, SubagentResult, SubagentRunFilter, SubagentRunRecord } from './types.ts'

/** 委派工具的名字。 */
export const SUBAGENT_TOOL_NAME = 'subagent'

/** 列出子代理的工具名。 */
export const SUBAGENT_LIST_TOOL_NAME = 'subagent_list'

/** 工具用到的服务能力：只暴露工具真正要用的那两件。 */
export interface SubagentToolHost {
  /** 派一次活。 */
  delegate(request: SubagentRequest, ctx: ToolContext): Promise<SubagentResult>
  /** 查委派记录。 */
  listRuns(filter?: SubagentRunFilter): readonly SubagentRunRecord[]
}

/** 解析委派参数；参数不合法时返回 undefined。 */
function parseRequest(args: unknown): SubagentRequest | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const task = record.task
  if (typeof task !== 'string' || task.trim().length === 0) return undefined
  const model = record.model
  return {
    task: task.trim(),
    ...(typeof model === 'string' && model.trim().length > 0 ? { model: model.trim() } : {}),
  }
}

/** 委派结果给模型看的正文：结论在前，过程在后。 */
function renderResult(result: SubagentResult): string {
  const tools = result.tools.length === 0 ? '无' : result.tools.join('、')
  return [result.text, `（子代理 ${result.id}：${result.steps} 步，用了工具 ${tools}；子代理不能再起子代理）`].join(
    '\n',
  )
}

/**
 * 建 `subagent` 工具：把一段活交给子代理。
 * @param host - 服务（提供 delegate）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createSubagentTool(host: SubagentToolHost): Tool {
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      '把一段独立的活交给子代理去做。子代理有自己的上下文（看不到我们这边的对话历史），' +
      '拿一套工具自己跑完，最后把结论回给你。适合「翻很多文件」「长链路调查」这类你可以等一次的活。' +
      '参数 task 要写全——子代理看不到上下文，信息缺了它只能猜；model 可选，缺省跟你用同一个模型。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给子代理的任务描述；子代理看不到我们的对话历史，信息要写全。' },
        model: { type: 'string', description: '可选：子代理用的模型 id；缺省跟当前助理一样。' },
      },
      required: ['task'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const request = parseRequest(args)
      if (request === undefined) {
        return { content: '缺少 task 参数：子代理拿不到要做的事，什么也干不了。', isError: true }
      }
      const result = await host.delegate(request, ctx)
      if (result.status !== 'completed') {
        return { content: `子代理没有跑完：${result.error ?? result.status}`, isError: true }
      }
      return { content: renderResult(result) }
    },
  }
}

/** 一条记录给模型看的正文。 */
function renderRecord(run: SubagentRunRecord): string {
  const task = summary(run.task, 40)
  if (run.status === 'running') {
    const tools = run.tools.length === 0 ? '还没动过工具' : `已用工具 ${run.tools.join('、')}`
    return `${run.id} [running] 任务：${task} ｜ 还在跑：${tools}`
  }
  if (run.status === 'completed') {
    return `${run.id} [completed] 任务：${task} ｜ 结果：${summary(run.text, 80)}`
  }
  return `${run.id} [${run.status}] 任务：${task} ｜ 结果：${run.error ?? '没拿到结果'}`
}

/**
 * 建 `subagent_list` 工具：列出这次对话这一轮起过的子代理。
 *
 * 范围是「当前会话的当前轮」：父对话收尾时调 `endRound` 把轮次推进，下一轮再看
 * 这件工具，看到的就是这一轮新起的那几个，而不是上一次留下的。
 * @param host - 服务（提供 listRuns）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createSubagentListTool(host: SubagentToolHost): Tool {
  return {
    name: SUBAGENT_LIST_TOOL_NAME,
    description:
      '列出这次对话这一轮起过的子代理：id、状态、任务摘要、结果摘要。' +
      '用来确认刚才派出去的那趟活到底跑完没有、结果是什么。',
    parameters: { type: 'object', properties: {} },
    async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const runs = host.listRuns({
        ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
        round: 'current',
      })
      if (runs.length === 0) return { content: '这一轮还没有起过子代理。' }
      return { content: runs.map((run) => renderRecord(run)).join('\n') }
    },
  }
}
