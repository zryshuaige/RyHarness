/**
 * 用子代理跑后台任务。
 *
 * 这是本仓现成的「耗时活」原语：子代理有自己的上下文、能连着跑好几步、跑完交回一段
 * 结论。把它塞进后台任务里，主人就不用守着对话等——他派完活可以先去干别的，跑完
 * 通知会自己进会话。
 *
 * 取消也一并说清：任务被取消时 abort 的是**这趟活**自己的信号（不是发起那一轮的），
 * 所以取消能真的把子代理停下来，而那一轮收尾不会误伤后台任务。
 * @module @ryharness/jobs/subagent-executor
 */

import type { ToolContext } from '@ryharness/agent'
import type { SubagentRequest, SubagentResult } from '@ryharness/subagent'
import { summary } from './format.ts'
import type { JobExecutor, JobExecutorContext } from './types.ts'

/**
 * 派子代理的最小接口。
 *
 * 只要能派一次活就够——`SubagentService` 结构上满足它，测试里也能拿一个假实现顶上，
 * 不必为了测一个执行器而把整套模型运行时搭起来。
 */
export interface SubagentDelegate {
  /**
   * 派一次活。
   * @param request - 任务描述。
   * @param ctx - 工具执行上下文（signal 属于这趟活，取消时会被 abort）。
   * @returns 子代理的最终结果。
   */
  delegate(request: SubagentRequest, ctx: ToolContext): Promise<SubagentResult>
}

/**
 * 建一个「派子代理」的后台任务执行器。
 * @param subagents - 子代理服务（`@ryharness/subagent` 的 SubagentService 就满足这个接口）。
 * @returns 满足 `JobExecutor` 契约的执行器（kind 为 `subagent`）。
 */
export function createSubagentJobExecutor(subagents: SubagentDelegate): JobExecutor {
  return {
    kind: 'subagent',
    async run(ctx: JobExecutorContext): Promise<string> {
      ctx.beginStep(0)
      const result = await subagents.delegate({ task: ctx.job.task }, ctx.toolContext)
      if (result.status !== 'completed') {
        const why = result.error ?? `子代理没跑完（${result.status}）`
        ctx.failStep(0, why)
        throw new Error(why)
      }
      const text = result.text.trim()
      ctx.completeStep(0, summary(text, 120))
      return text
    },
  }
}
