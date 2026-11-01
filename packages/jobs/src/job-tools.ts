/**
 * 模型看得见的四件工具：起一个后台任务、查任务、取结果、取消。
 *
 * 四件工具是后台任务这一族对外的唯一入口。模型能提的要求只有四个，剩下的复杂度
 * （排队、并发、归属、通知）全在服务里——尤其是通知：**模型不必轮询**，任务跑完
 * 宿主会把它写进会话。
 * @module @ryharness/jobs/job-tools
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import { renderJob } from './format.ts'
import type { JobFilter, JobScope, JobSnapshot, JobStartInput, JobStatus } from './types.ts'

/** 合法的任务状态：模型传别的值就当没传。 */
const JOB_STATUSES: readonly JobStatus[] = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

/** 起后台任务的工具名。 */
export const JOB_START_TOOL_NAME = 'job_start'

/** 列任务的工具名。 */
export const JOB_LIST_TOOL_NAME = 'job_list'

/** 取结果的工具名。 */
export const JOB_RESULT_TOOL_NAME = 'job_result'

/** 取消任务的工具名。 */
export const JOB_CANCEL_TOOL_NAME = 'job_cancel'

/** 工具用到的服务能力：只暴露工具真正要用的那几件。 */
export interface JobToolHost {
  /** 起一个后台任务。 */
  start(input: JobStartInput, ctx: ToolContext): JobSnapshot
  /** 查任务列表。 */
  list(filter: JobFilter): readonly JobSnapshot[]
  /** 按 id 查一个任务（归属对不上就是查不到）。 */
  get(id: string, scope: JobScope): JobSnapshot | undefined
  /** 取消一个任务。 */
  cancel(id: string, scope: JobScope): JobSnapshot | undefined
}

/** 从工具上下文推出查询范围：谁在查、查哪个会话。 */
function scopeOf(ctx: ToolContext): JobScope {
  return {
    ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
    ...(ctx.conversationId === undefined ? {} : { conversationId: ctx.conversationId }),
  }
}

/** 解析起任务的参数；参数不合法时返回 undefined。 */
function parseStart(args: unknown): JobStartInput | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const task = record.task
  if (typeof task !== 'string' || task.trim().length === 0) return undefined
  const kind = record.kind
  const steps = record.steps
  const stepList: string[] = []
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (typeof step !== 'string') continue
      const text = step.trim()
      if (text.length === 0) continue
      stepList.push(text)
    }
  }
  return {
    task: task.trim(),
    ...(typeof kind === 'string' && kind.trim().length > 0 ? { kind: kind.trim() } : {}),
    ...(stepList.length === 0 ? {} : { steps: stepList }),
  }
}

/** 从参数里取任务 id。 */
function parseJobId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const id = record.jobId
  if (typeof id !== 'string' || id.trim().length === 0) return undefined
  return id.trim()
}

/**
 * 建 `job_start` 工具：起一个后台任务。
 *
 * 这件工具**不等**活跑完：登记完立刻回话，模型接着干别的。
 * @param host - 服务（提供 start）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createJobStartTool(host: JobToolHost): Tool {
  return {
    name: JOB_START_TOOL_NAME,
    description:
      '起一个后台任务：这趟活可能要跑很久，你不会被卡在这儿。' +
      '登记完就继续干别的——跑完了会有人通知你，不用一遍遍去问。' +
      '参数 task 要写全（后台没有对话历史可看）；steps 可选，写清打算走的几步，跑完能看出哪一步慢。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '这趟活要干什么——写全，后台看不到我们的对话历史。' },
        kind: { type: 'string', description: '可选：任务类型，决定交给哪种执行器去跑；缺省用默认类型。' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：打算走的几步，每步一句说明。',
        },
      },
      required: ['task'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = parseStart(args)
      if (input === undefined) {
        return { content: '缺少 task 参数：后台没有上下文可看，说清要干什么才能起得了。', isError: true }
      }
      try {
        const job = host.start(input, ctx)
        const where = job.status === 'queued' ? '排队中' : '已经在跑'
        return {
          content:
            `已起后台任务 ${job.id}（${where}）。别在这儿等它——继续干别的，` +
            `跑完会通知你；想提前看进度就用 job_list。`,
        }
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : '起后台任务失败了。',
          isError: true,
        }
      }
    },
  }
}

/**
 * 建 `job_list` 工具：列出**你**起的那些后台任务。
 *
 * 范围是「当前会话、当前 agent」：别人的任务你看不到，跨会话的也看不到。
 * @param host - 服务（提供 list）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createJobListTool(host: JobToolHost): Tool {
  return {
    name: JOB_LIST_TOOL_NAME,
    description:
      '列出你在这次对话里起过的后台任务：id、状态、跑了多久、结果摘要。' + '用来确认刚才派出去的那趟活跑完没有。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: '可选：只看某个状态的任务（queued / running / succeeded / failed / cancelled）。',
        },
      },
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const wanted = record.status
      const status = typeof wanted === 'string' ? JOB_STATUSES.find((item) => item === wanted) : undefined
      const filter: JobFilter = {
        ...scopeOf(ctx),
        ...(status === undefined ? {} : { status }),
      }
      const jobs = host.list(filter)
      if (jobs.length === 0) return { content: '这次对话里还没有你起过的后台任务。' }
      return { content: jobs.map((job) => renderJob(job)).join('\n') }
    },
  }
}

/**
 * 建 `job_result` 工具：取一个后台任务的结果。
 *
 * 任务还在跑时它只说「还在跑」——**不用它轮询**，通知会自己到。
 * @param host - 服务（提供 get）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createJobResultTool(host: JobToolHost): Tool {
  return {
    name: JOB_RESULT_TOOL_NAME,
    description: '取一个后台任务的结果与每一步的耗时。任务还在跑就告诉你还在跑。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id（job_list 能看到）。' },
      },
      required: ['jobId'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const id = parseJobId(args)
      if (id === undefined) {
        return { content: '缺少 jobId 参数：不知道要取哪个任务的结果。', isError: true }
      }
      const job = host.get(id, scopeOf(ctx))
      if (job === undefined) {
        return { content: `没有这个任务（${id}）：它可能不存在，也可能不是你起的。`, isError: true }
      }
      if (job.status === 'succeeded') {
        const steps = job.phases.map((phase) => `· ${phase.label}：${phase.summary ?? '没写结果'}`).join('\n')
        return {
          content: [`${job.id} 跑完了：${job.result ?? '（没有结果摘要）'}`, steps]
            .filter((line) => line.length > 0)
            .join('\n'),
        }
      }
      if (job.status === 'failed') {
        return { content: `${job.id} 没跑成：${job.error ?? '没拿到结果'}`, isError: true }
      }
      if (job.status === 'cancelled') {
        return { content: `${job.id} 已被取消，没拿到结果。` }
      }
      return {
        content: `${job.id} 还在跑（${job.status === 'queued' ? '排队中' : '跑着呢'}）。跑完会通知你，不用一直问。`,
      }
    },
  }
}

/**
 * 建 `job_cancel` 工具：取消一个后台任务。
 * @param host - 服务（提供 cancel）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createJobCancelTool(host: JobToolHost): Tool {
  return {
    name: JOB_CANCEL_TOOL_NAME,
    description: '取消一个还在跑的后台任务。已经结束的任务取消不了。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '要取消的任务 id。' },
      },
      required: ['jobId'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const id = parseJobId(args)
      if (id === undefined) {
        return { content: '缺少 jobId 参数：不知道要取消哪个任务。', isError: true }
      }
      const cancelled = host.cancel(id, scopeOf(ctx))
      if (cancelled === undefined) {
        const job = host.get(id, scopeOf(ctx))
        if (job === undefined) {
          return { content: `没有这个任务（${id}）：它可能不存在，也可能不是你起的。`, isError: true }
        }
        return { content: `${job.id} 已经收尾了（${job.status}），取消不了。` }
      }
      return { content: `${cancelled.id} 已取消。` }
    },
  }
}
