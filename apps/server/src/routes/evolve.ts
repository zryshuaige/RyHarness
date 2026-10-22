/**
 * 自我进化路由：反馈闭环、经验手册、巩固触发，以及可观测性
 * （进化轮次指标 / 单条 playbook 条目的证据链）。
 * @module @ryharness/server/routes/evolve
 */

import type { EvolveService } from '@ryharness/evolve'
import type { SessionStore } from '@ryharness/session'
import { json, type Router, strField } from '../router.ts'

/** 巩固一跑的结论（runUntilIdle 的口径：整轮跑完，不是第一片）。 */
export interface ConsolidationRun {
  ok: boolean
  result?: Awaited<ReturnType<EvolveService['runUntilIdle']>>
}

/** 进化路由的依赖。 */
export interface EvolveRoutes {
  store: SessionStore
  /** undefined = 进化系统关闭。 */
  evolutionService: EvolveService | undefined
  /** 跑完整一轮巩固（周期调度与手动触发共用同一入口）。 */
  consolidate: () => Promise<ConsolidationRun>
}

/** 进化闭环与可观测性的路由。 */
export function registerEvolveRoutes(router: Router, deps: EvolveRoutes): void {
  const { store } = deps
  const evolutionService = (): EvolveService | undefined => {
    return deps.evolutionService
  }

  /**
   * 用户反馈：👎 即时反思 + 归因 harmful；👍 归因 helpful。
   *
   * 防刷：同一消息（messageId）同一信号重复提交时幂等返回（recorded:false），
   * 不再写进化事件、也不再动亲密度。亲密度 bump 内联在这里做——反馈被接受
   * 才涨（渲染层因此不再单独调 /api/agents/:id/affinity）；回包带上更新后的
   * agent，界面据此刷新卡片，不用再拉一次列表。
   */
  router.post('/api/feedback', async (req, res) => {
    const service = evolutionService()
    if (service === undefined) {
      json(res, 409, { error: 'evolution system disabled' })
      return
    }
    const body = await req.body()
    const conversationId = strField(body, 'conversationId')
    const agentId = strField(body, 'agentId')
    const signal = strField(body, 'signal')
    if (conversationId === undefined || agentId === undefined || (signal !== 'thumb_up' && signal !== 'thumb_down')) {
      json(res, 400, { error: 'conversationId, agentId and signal(thumb_up|thumb_down) are required' })
      return
    }
    const messageId = strField(body, 'messageId')
    if (messageId !== undefined && store.hasFeedback(messageId, signal)) {
      json(res, 200, { recorded: false, duplicate: true })
      return
    }
    const agent = store.bumpAgentAffinity(agentId, signal === 'thumb_up' ? { likes: 1 } : { dislikes: 1 })
    service.recordFeedback({
      agentId,
      conversationId,
      signal,
      userText: strField(body, 'userText'),
      assistantText: strField(body, 'assistantText'),
      messageId,
    })
    json(res, 200, { recorded: true, ...(agent === undefined ? {} : { agent }) })
  })

  /** 某 agent 的经验手册：playbook 条目（含 deprecated）+ 待验证教训。 */
  router.get('/api/agents/:id/playbook', async (req, res) => {
    if (store.getAgent(req.params.id as string) === undefined) {
      json(res, 404, { error: 'agent not found' })
      return
    }
    const service = evolutionService()
    if (service === undefined) {
      json(res, 200, { entries: [], reflections: [] })
      return
    }
    json(res, 200, {
      entries: service.store.listEntries(req.params.id as string),
      reflections: service.store.listPendingReflections(req.params.id as string, 50),
    })
  })

  /** 手动 deprecate / 恢复条目。 */
  router.post('/api/playbook/:id/status', async (req, res) => {
    const service = evolutionService()
    if (service === undefined) {
      json(res, 409, { error: 'evolution system disabled' })
      return
    }
    const existing = service.store.getEntry(req.params.id as string)
    if (existing === undefined) {
      json(res, 404, { error: 'entry not found' })
      return
    }
    const status = strField(await req.body(), 'status')
    if (status !== 'active' && status !== 'deprecated') {
      json(res, 400, { error: 'status must be active|deprecated' })
      return
    }
    service.setEntryStatus(existing.id, status)
    json(res, 200, { id: existing.id, status })
  })

  /** 手动触发巩固任务（周期调度之外的即时入口）。 */
  router.post('/api/evolve/consolidate', async (_req, res) => {
    if (evolutionService() === undefined) {
      json(res, 409, { error: 'evolution system disabled' })
      return
    }
    const run = await deps.consolidate()
    if (!run.ok) {
      json(res, 500, { error: 'consolidation failed' })
      return
    }
    json(res, 200, run.result)
  })

  /**
   * 进化管线的耗时与吞吐：最近 limit 轮（新的在前）+ 各类轮次合计。
   *
   * 进化在服务端是**后台异步**跑的（反思/归因/巩固都不在用户那一轮的关键路径
   * 上），出问题时界面上看不见任何提示——这个端点就是那条唯一的观测面。
   */
  router.get('/api/evolve/stats', async (req, res) => {
    const service = evolutionService()
    if (service === undefined) {
      json(res, 200, { enabled: false })
      return
    }
    const raw = Number(req.query.get('limit') ?? '')
    const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined
    json(res, 200, { enabled: true, ...service.metrics(limit) })
  })

  /**
   * 单条 playbook 条目的证据链：条目本体 + 溯源（教训/对话/记忆）+ 一句人话
   * 摘要。用户问「它凭什么这么说」时，UI 拿这个回答。
   */
  router.get('/api/evolve/entries/:id/explain', async (req, res) => {
    const service = evolutionService()
    if (service === undefined) {
      json(res, 409, { error: 'evolution system disabled' })
      return
    }
    const explanation = service.explain(req.params.id as string)
    if (explanation === undefined) {
      json(res, 404, { error: `entry not found: ${req.params.id}` })
      return
    }
    json(res, 200, explanation)
  })
}
