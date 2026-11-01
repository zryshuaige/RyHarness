/**
 * 内置插件：后台任务与计划模式。
 *
 * 两件事：
 * - **后台任务**：助理把一件耗时的活派出去，跑完通知自己进会话——主人不用守着
 *   对话等，模型也不用轮询。
 * - **计划模式**：开会话时先探索设计、交一份计划上去**等人批**，批了才动手。
 *
 * 通知怎么回到会话里是宿主的事（{@link JobsPluginDeps.deliver}）：这个插件只负责
 * 「发生了什么」，落库与推送由组合根做。
 * @module @ryharness/server/plugins/jobs
 */

import type { Context } from '@ryharness/cordis'
import type { LlmRuntime } from '@ryharness/llm'
import type { SessionStore } from '@ryharness/session'
import {
  createSubagentJobExecutor,
  JobService,
  JOB_TOOL_NAMES,
  PlanModeService,
  PLAN_TOOL_NAMES,
  renderJobNotice,
  renderPlanNotice,
} from '@ryharness/jobs'
import { SubagentService } from '@ryharness/subagent'
import type { ToolRegistry } from '@ryharness/tools'
import { HttpRequestError, json } from '../router.ts'
import type { PluginEntry } from './host.ts'
import type { RouteRegistry } from './routes.ts'

export const JOBS_PLUGIN_ID = 'jobs'

/** 后台任务插件的依赖。 */
export interface JobsPluginDeps {
  /** 模型运行时：后台任务里的子代理要走它。 */
  llm: LlmRuntime
  /** 工具注册表：子代理拿到的工具从这里解析。 */
  tools: ToolRegistry
  /** 会话存储：按 agentId 查发起者用的是哪条模型路由。 */
  store: SessionStore
  /**
   * 把一条通知写进会话（落库 + 推界面）。
   *
   * 插件不自己落库：消息落库、WS 推送、轮次序号这些都是组合根的事，做两遍就会
   * 出现「界面上一条、库里两条」这种对不上的情况。
   */
  deliver: (input: { conversationId: string; agentId: string; text: string }) => void
  /** 会话存在性校验（路由用它拒绝不存在的会话）。 */
  conversationExists: (conversationId: string) => boolean
}

/** 后台任务插件入口：六件工具 + 三条计划路由，全部随插件 fiber 装卸。 */
export function jobsPlugin(deps: JobsPluginDeps): PluginEntry {
  return {
    id: JOBS_PLUGIN_ID,
    name: '后台任务与计划',
    description:
      '让助理把耗时的活派到后台去跑，跑完通知自己进会话；开会话时还能先交一份计划等人批，批了才动手。',
    group: 'feature',
    capabilities: {
      tools: [...JOB_TOOL_NAMES, ...PLAN_TOOL_NAMES],
      routes: ['GET /api/plans/:id', 'POST /api/plans/:id/approve', 'POST /api/plans/:id/reject'],
    },
    impact:
      '关闭后助理不能再派后台任务、也不能再交计划等人批；已在后台跑的任务会按各自的取消信号收尾，已提交的计划保留在内存里。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      /**
       * 后台任务用的子代理服务。
       *
       * 它跟「子代理」插件里那个不是同一个实例——那边是**这一轮**里的委派，这边是
       * 脱离这一轮继续跑的活。两者的生命周期不同，混成一个会让后台任务在对话收尾时
       * 被一起 abort 掉。
       */
      const subagents = new SubagentService({
        llm: deps.llm,
        tools: deps.tools,
        route: { provider: '', model: '' },
        resolveRoute: (toolCtx) => {
          const agent = toolCtx.agentId === undefined ? undefined : deps.store.getAgent(toolCtx.agentId)
          return { provider: agent?.provider ?? '', model: agent?.model ?? '' }
        },
      })
      const jobs = new JobService({
        executors: [createSubagentJobExecutor(subagents)],
        onComplete: (notice) => {
          const conversationId = notice.conversationId
          if (conversationId === undefined) return
          deps.deliver({
            conversationId,
            agentId: notice.ownerAgentId,
            text: renderJobNotice(notice.job),
          })
        },
      })
      const plans = new PlanModeService({
        onChange: (plan) => {
          // 计划是谁交的谁署名：没记着 agent id 就先不写通知（写一条没有主人的消息
          // 只会让人以为是谁干的都不知道）。
          const agentId = plan.agentId
          if (agentId === undefined) return
          deps.deliver({
            conversationId: plan.conversationId,
            agentId,
            text: renderPlanNotice(plan),
          })
        },
      })
      for (const tool of [...jobs.modelTools, ...plans.modelTools]) ctx.tools.register(tool)

      const router = ctx.routes
      registerPlanRoutes(router, {
        plans,
        conversationExists: deps.conversationExists,
      })

      // 插件关掉时，后台跑的活要收干净：工具随 fiber 消失，在跑的子代理不会自己消失。
      ctx.effect(() => {
        return () => {
          void subagents.dispose()
        }
      }, 'jobs.subagents')
    },
  }
}

/** 计划路由的依赖。 */
interface PlanRoutesDeps {
  plans: PlanModeService
  conversationExists: (conversationId: string) => boolean
}

/**
 * 计划的三条路由：读当前计划、批、打回。
 *
 * 批与打回是**人**的动作（助理不能自己批自己的计划），所以它们只走 HTTP，不给模型
 * 工具——模型有 `plan_propose` 与 `plan_read`，没有「自己批自己」的那件。
 */
function registerPlanRoutes(routes: RouteRegistry, deps: PlanRoutesDeps): void {
  const requireConversation = (conversationId: string): string => {
    if (conversationId.length === 0) {
      throw new HttpRequestError(400, '会话 id 是必填的', 'PLAN_BAD_REQUEST')
    }
    if (!deps.conversationExists(conversationId)) {
      throw new HttpRequestError(404, `没有这个会话：${conversationId}`, 'PLAN_UNKNOWN_CONVERSATION')
    }
    return conversationId
  }

  routes.register('GET', '/api/plans/:id', async (req, res) => {
    const conversationId = requireConversation(req.params.id ?? '')
    const plan = deps.plans.current(conversationId)
    json(res, 200, {
      conversationId,
      enabled: deps.plans.isEnabled(conversationId),
      status: deps.plans.status(conversationId),
      plan: plan ?? null,
    })
  })

  routes.register('POST', '/api/plans/:id/approve', async (req, res) => {
    const conversationId = requireConversation(req.params.id ?? '')
    const plan = deps.plans.approve(conversationId)
    if (plan === undefined) {
      throw new HttpRequestError(404, '这个会话没有待批的计划', 'PLAN_NOT_FOUND')
    }
    json(res, 200, { conversationId, plan })
  })

  routes.register('POST', '/api/plans/:id/reject', async (req, res) => {
    const conversationId = requireConversation(req.params.id ?? '')
    const body = (await req.body()) as { feedback?: unknown }
    const feedback =
      typeof body === 'object' && body !== null && typeof body.feedback === 'string' ? body.feedback : ''
    const plan = deps.plans.reject(conversationId, feedback)
    if (plan === undefined) {
      throw new HttpRequestError(404, '这个会话没有待批的计划', 'PLAN_NOT_FOUND')
    }
    json(res, 200, { conversationId, plan })
  })
}
