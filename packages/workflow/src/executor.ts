/**
 * 内存执行器：不接真的子代理，只按一句规则把活干完。
 *
 * 它有两个用处：
 * - **测试**：编排引擎的并发、限流、结果顺序都能拿它测，不用起真的模型。
 * - **干跑**：宿主想看看「这段编排脚本会派几个活」时，用它跑一遍不花钱。
 *
 * 真要接本仓的子代理（`@ryharness/subagent`），写一个同形状的执行器就行——
 * {@link WorkflowAgentExecutor} 只有 `run` 一个方法。
 * @module @ryharness/workflow/executor
 */

import type { WorkflowAgentExecutor, WorkflowAgentRequest } from './types.ts'

/** 内存执行器的构造参数。 */
export interface InMemoryWorkflowExecutorOptions {
  /** 每个任务怎么处理；缺省时把任务原样回一句。 */
  handler?: (request: WorkflowAgentRequest) => string | Promise<string>
  /** 每个任务先磨蹭多久（毫秒），用来模拟快慢不一的子代理。 */
  delayMs?: number
}

/**
 * 造一个内存执行器。
 *
 * @param options - 处理规则与模拟耗时。
 * @returns 子代理执行器。
 */
export function createInMemoryWorkflowExecutor(options: InMemoryWorkflowExecutorOptions = {}): WorkflowAgentExecutor {
  return {
    async run(request: WorkflowAgentRequest): Promise<{ text: string; status: 'completed'; error?: string }> {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, options.delayMs)
        })
      }
      if (options.handler !== undefined) {
        const text = await options.handler(request)
        return { text, status: 'completed' }
      }
      return { text: `（内存执行器）已处理：${request.task}`, status: 'completed' }
    },
  }
}
