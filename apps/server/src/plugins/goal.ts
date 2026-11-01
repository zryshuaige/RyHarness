/**
 * 内置插件：跨重启的目标。
 *
 * 一个会话要跨着做完的那件事，助理自己看得见（`get_goal` / `create_goal` / `update_goal`），
 * 人也随时查得到、改得动（`/goal` 命令）。目标落盘，所以关掉应用再打开，它还在。
 *
 * 存储与时钟由组合根注入：这个插件不自己决定「目标存在哪儿」——那是应用级的事，
 * 而且**必须只有一份**，两份存储各写各的，用户看到的清单会少一半。
 * @module @ryharness/server/plugins/goal
 */

import { createGoalTools, GOAL_TOOL_NAMES, type GoalService } from '@ryharness/goal'
import type { PluginEntry } from './host.ts'

export const GOAL_PLUGIN_ID = 'goal'

/** 目标插件的依赖。 */
export interface GoalPluginOptions {
  /**
   * 目标服务：由组合根创建并持有。
   *
   * 不在插件里 new 的原因同待办：目标要跨重启读回来，存储路径是应用级的事，
   * 而且同一时刻只能有一份在写——两份各写各的，用户会看到互相覆盖的目标。
   */
  service: GoalService
}

/** 目标插件入口：注册三件工具，随插件 fiber 装卸。 */
export function goalPlugin(options: GoalPluginOptions): PluginEntry {
  return {
    id: GOAL_PLUGIN_ID,
    name: '跨重启的目标',
    description: '让当前会话有一件跨着做完的事：助理能定、能改、能看状态，重启之后目标还在。',
    group: 'feature',
    capabilities: { tools: [...GOAL_TOOL_NAMES] },
    impact: '关闭后助理不再有目标工具（目标本身还留着，重新打开就能接着用）；用户也不能再通过 /goal 看与改目标。',
    inject: ['tools'],
    apply: (ctx) => {
      for (const tool of createGoalTools(options.service)) ctx.tools.register(tool)
    },
  }
}
