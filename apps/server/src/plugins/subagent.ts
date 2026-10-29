/**
 * 内置插件：子代理。
 *
 * 助理可以把一个**独立**的任务派出去：子代理有自己的上下文（不继承这边的对话）、
 * 自己的工具调用，跑完把结果带回来。
 *
 * 路由跟着**发起委派的那位助理**走：不同助理可能用不同的供应商与模型，子代理
 * 跟着父代理的路由才不会突然换一家。
 * @module @ryharness/server/plugins/subagent
 */

import type { ToolContext } from '@ryharness/agent'
import type { LlmRuntime } from '@ryharness/llm'
import type { SessionStore } from '@ryharness/session'
import { SubagentService } from '@ryharness/subagent'
import type { ToolRegistry } from '@ryharness/tools'
import type { PluginEntry } from './host.ts'

export const SUBAGENT_PLUGIN_ID = 'subagent'

/** 子代理插件的依赖。 */
export interface SubagentPluginOptions {
  /** LLM 运行时：子代理的模型调用走它。 */
  llm: LlmRuntime
  /** 工具注册表：子代理拿到的工具从这里解析（且不含委派工具本身）。 */
  tools: ToolRegistry
  /** 会话存储：按 agentId 查发起者用的是哪条模型路由。 */
  store: SessionStore
}

/** 子代理插件入口：把 `subagent` 与 `subagent_list` 两个工具注册进工具表。 */
export function subagentPlugin(options: SubagentPluginOptions): PluginEntry {
  return {
    id: SUBAGENT_PLUGIN_ID,
    name: '子代理',
    description: '把一个独立任务派给子代理去做：子代理有自己的上下文，跑完把结果带回来。',
    group: 'feature',
    impact: '关闭后助理不能再把活派给子代理，其余能力不受影响；已派出去的任务会按超时收尾。',
    inject: ['tools'],
    apply: (ctx) => {
      const service = new SubagentService({
        llm: options.llm,
        tools: options.tools,
        // 缺省路由只是兜底：真正用的是 resolveRoute 按发起者查出来的那条。
        route: { provider: '', model: '' },
        resolveRoute: (toolCtx: ToolContext) => {
          const agent = toolCtx.agentId === undefined ? undefined : options.store.getAgent(toolCtx.agentId)
          return { provider: agent?.provider ?? '', model: agent?.model ?? '' }
        },
      })
      for (const tool of service.modelTools) ctx.tools.register(tool)
      // 子代理的进程/轮次要收干净：工具随 fiber 消失，在跑的子代理不会自己消失。
      ctx.effect(() => {
        return () => {
          void service.dispose()
        }
      }, 'subagent.service')
    },
  }
}
