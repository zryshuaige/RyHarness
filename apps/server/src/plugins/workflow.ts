/**
 * 内置插件：编排。
 *
 * 助理可以写一段**编排脚本**，把活拆成几块派给子代理并行去做，最后把结论合起来。
 * 跟 `subagent` 那件工具的区别：`subagent` 是派一趟活，`workflow` 是派一批活并且
 * 由助理自己决定顺序与合并方式。
 *
 * 脚本跑在独立的子进程里（PTC 的 Node 后端），能碰哪些文件由**文件策略**说了算：
 * 策略由主控在组合根里按会话的工作区给，脚本想越界读写会被直接拒掉。
 * @module @ryharness/server/plugins/workflow
 */

import type { ToolContext } from '@ryharness/agent'
import type { LlmRuntime } from '@ryharness/llm'
import { NodePtcRuntime, type PtcFilePolicy } from '@ryharness/ptc'
import type { SessionStore } from '@ryharness/session'
import { SubagentService } from '@ryharness/subagent'
import type { ToolRegistry } from '@ryharness/tools'
import { createWorkflowTool, type WorkflowAgentExecutor, WorkflowEngine } from '@ryharness/workflow'
import type { PluginEntry } from './host.ts'

export const WORKFLOW_PLUGIN_ID = 'workflow'

/** 编排插件的依赖。 */
export interface WorkflowPluginOptions {
  /**
   * 子代理执行器：脚本派出去的活由它跑。
   *
   * 不填就用 `llm` / `tools` / `store` 自建一个子代理服务来接——那是本仓现成的
   * 「耗时活」原语（子代理有自己的上下文、能连着跑好几步）。
   */
  executor?: WorkflowAgentExecutor
  /** 模型运行时：自建子代理服务时用。 */
  llm?: LlmRuntime
  /** 工具注册表：自建子代理服务时用。 */
  tools?: ToolRegistry
  /** 会话存储：自建子代理服务时用它查发起者的模型路由。 */
  store?: SessionStore
  /** 文件策略：脚本能读哪些路径、能写哪些路径。缺省 = 进程当前目录。 */
  filePolicy?: PtcFilePolicy
  /** 一次编排的时限（毫秒）。 */
  timeoutMs?: number
  /** 一次编排最多派几个子代理。 */
  maxFanOut?: number
}

/**
 * 用子代理服务接一个编排执行器。
 *
 * 编排派出去的活**不共享**父对话的历史——跟 `subagent` 工具一个口径：脚本里写清
 * 任务，子代理只看得到那些字。
 * @param options - 模型运行时、工具表与会话存储。
 * @returns 执行器。
 */
function createSubagentExecutor(options: {
  llm?: LlmRuntime
  tools?: ToolRegistry
  store?: SessionStore
}): WorkflowAgentExecutor {
  const subagents = new SubagentService({
    llm: options.llm as LlmRuntime,
    tools: options.tools as ToolRegistry,
    route: { provider: '', model: '' },
    resolveRoute: (toolCtx) => {
      const agent = toolCtx.agentId === undefined ? undefined : options.store?.getAgent(toolCtx.agentId)
      return { provider: agent?.provider ?? '', model: agent?.model ?? '' }
    },
  })
  return {
    async run(request) {
      const context = request.context
      const toolContext: ToolContext = {
        workspaceRoot: context?.workspaceRoot ?? process.cwd(),
        ...(context?.conversationId === undefined ? {} : { conversationId: context.conversationId }),
        ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const result = await subagents.delegate({ task: request.task }, toolContext)
      if (result.status !== 'completed') {
        return { text: result.text, status: 'failed', error: result.error ?? '子代理没跑完' }
      }
      return { text: result.text, status: 'completed' }
    },
  }
}

/** 编排插件入口：把 `workflow` 工具注册进工具表。 */
export function workflowPlugin(options: WorkflowPluginOptions): PluginEntry {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: '编排',
    description: '让助理写一段编排脚本，把活派给几个子代理并行去做，再把结论合起来。',
    group: 'feature',
    capabilities: { tools: ['workflow'] },
    impact: '关闭后助理不能再写编排脚本扇出子代理；单趟派活（subagent 工具）不受影响。',
    inject: ['tools'],
    apply: (ctx) => {
      const runtime = new NodePtcRuntime()
      const executor = options.executor ?? createSubagentExecutor(options)
      const engine = new WorkflowEngine({
        runtime,
        executor,
        ...(options.filePolicy === undefined ? {} : { filePolicy: options.filePolicy }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxFanOut === undefined ? {} : { maxFanOut: options.maxFanOut }),
      })
      ctx.tools.register(createWorkflowTool({ engine }))
      // 插件卸了以后，编排留下的子进程要收干净：工具随 fiber 消失，
      // 后台还在跑的编排脚本不会自己消失。
      ctx.effect(() => {
        return () => {
          void engine.dispose()
          void runtime.dispose()
        }
      }, 'workflow.engine')
    },
  }
}
