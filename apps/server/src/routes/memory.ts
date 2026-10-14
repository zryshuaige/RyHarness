/**
 * 长期记忆路由：agent 记忆列表、软删、归档/恢复、重建向量与统计。
 * @module @ryagent/server/routes/memory
 */

import type { MemoryRow, MemoryService } from '@ryagent/memory'
import type { SessionStore } from '@ryagent/session'
import { json, type Router, strField } from '../router.ts'

/** 巩固状态（由组合根持有定时器与时间戳，路由只负责回包）。 */
export interface ConsolidationSnapshot {
  intervalMs: number
  lastRunAt?: number
}

/** 记忆路由的依赖。 */
export interface MemoryRoutes {
  store: SessionStore
  /** undefined = 记忆系统关闭（面板每次打开都拉，不该因此报错）。 */
  memoryService: MemoryService | undefined
  /** 巩固周期与上次巩固时间。 */
  consolidation: () => ConsolidationSnapshot
}

/** 「最近学到 N 条」的统计窗口：近 24 小时内新增的长期记忆。 */
const RECENT_LEARNED_WINDOW_MS = 86_400_000

/**
 * 记忆的对外形状（渲染层 MemoryRow）。
 *
 * 只挑展示与恢复需要的字段：MemoryRow 上的 `embedding` 是 Float32Array，
 * 直接序列化会变成 `{"0":…,"1":…}` 的一坨数字——归档列表是全量返回的，带着
 * 向量既把响应撑大，又把检索内部状态泄给前端。
 */
function publicMemoryRow(row: MemoryRow): {
  id: string
  agentId: string
  kind: MemoryRow['kind']
  content: string
  createdAt: number
  updatedAt: number
  accessCount: number
  sourceConversationId?: string
} {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accessCount: row.accessCount,
    ...(row.sourceConversationId === undefined ? {} : { sourceConversationId: row.sourceConversationId }),
  }
}

/**
 * 「最近学到 N 条」：近 24 小时内新增的 active 记忆数（各 agent 私有空间 +
 * 共享画像）。口径写在这里而不是散在 UI 上，免得用户看到的数字无从对账。
 */
function countRecentLearned(store: SessionStore, memoryService: MemoryService, now = Date.now()): number {
  const since = now - RECENT_LEARNED_WINDOW_MS
  let count = 0
  const fresh = (createdAt: number): boolean => {
    return createdAt >= since
  }
  for (const row of memoryService.store.listSharedProfile()) {
    if (fresh(row.createdAt)) count += 1
  }
  for (const agent of store.listAgents()) {
    for (const row of memoryService.store.listActiveForAgent(agent.id)) {
      if (fresh(row.createdAt)) count += 1
    }
  }
  return count
}

/** 长期记忆的路由。 */
export function registerMemoryRoutes(router: Router, deps: MemoryRoutes): void {
  const { store } = deps
  const memoryService = (): MemoryService | undefined => {
    return deps.memoryService
  }

  /** 某 agent 的记忆：私有空间 active + 共享画像。 */
  router.get('/api/agents/:id/memories', async (req, res) => {
    if (store.getAgent(req.params.id as string) === undefined) {
      json(res, 404, { error: 'agent not found' })
      return
    }
    const service = memoryService()
    if (service === undefined) {
      json(res, 200, { agent: [], shared: [] })
      return
    }
    json(res, 200, {
      agent: service.store.listActiveForAgent(req.params.id as string),
      shared: service.store.listSharedProfile(),
    })
  })

  /** 软删一条记忆。 */
  router.delete('/api/memories/:id', async (req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 409, { error: 'memory system disabled' })
      return
    }
    const existing = service.store.get(req.params.id as string)
    if (existing === undefined) {
      json(res, 404, { error: 'memory not found' })
      return
    }
    service.store.supersede(existing.id, 'deleted')
    json(res, 200, { deleted: existing.id })
  })

  /** 记忆统计。 */
  router.get('/api/memory/stats', async (_req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 200, { enabled: false, recentLearned: 0, consolidation: deps.consolidation() })
      return
    }
    json(res, 200, {
      enabled: true,
      embeddings: {
        label: service.embeddingsAvailable ? 'configured' : 'none:fts-only',
      },
      recentLearned: countRecentLearned(store, service),
      consolidation: deps.consolidation(),
      ...service.store.stats(),
    })
  })

  /**
   * 已归档的记忆（巩固任务判定长期零访问而移出检索面的那些）。
   *
   * 全量返回、由调用方按 agent 过滤：归档分区在每个 agent 的记忆面板里都要能
   * 看到"这个 agent 有什么被归档了"，按 agent 分组查询反而更贵。记忆系统关闭
   * 时回空列表而不是报错——面板每次打开都会拉一次，不该因此弹红条。
   */
  router.get('/api/memory/archived', async (_req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 200, { items: [] })
      return
    }
    json(res, 200, { items: service.store.listArchived().map(publicMemoryRow) })
  })

  /** 恢复一条归档记忆：回到 active，重新参与检索与注入。 */
  router.post('/api/memory/restore', async (req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 409, { error: 'memory system disabled' })
      return
    }
    const id = strField(await req.body(), 'id')
    if (id === undefined) {
      json(res, 400, { error: 'id is required' })
      return
    }
    const existing = service.store.get(id)
    if (existing === undefined) {
      json(res, 404, { error: 'memory not found' })
      return
    }
    // 只救归档：deleted / superseded 是用户或记忆管理器的软删决定，
    // 拿到 id 就能复活它们等于绕过软删语义。
    if (existing.status !== 'inactive') {
      json(res, 409, { error: `memory is not archived (status=${existing.status})` })
      return
    }
    if (!service.store.restore(id)) {
      json(res, 500, { error: 'restore failed' })
      return
    }
    json(res, 200, { restored: id })
  })

  /**
   * 重建向量索引：换 embedding 模型后为存量记忆回填向量（换模型时旧向量会被
   * 检索侧排除，不回填等于旧记忆静默退化成只走 BM25）。
   *
   * 没有 embedding 凭据（纯 FTS5）时回 409 而不是"重建成功 0 条"：那个按钮
   * 在这种安装下按下去没有意义，UI 需要如实看到它不可用。
   */
  router.post('/api/memory/reembed', async (_req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 409, { error: 'memory system disabled' })
      return
    }
    if (!service.embeddingsAvailable) {
      json(res, 409, { error: 'embeddings are not configured; nothing to rebuild' })
      return
    }
    json(res, 200, { reembedded: await service.reembedAll() })
  })
}
