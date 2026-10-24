/**
 * 长期记忆路由：agent 记忆列表、软删、归档/恢复、重建向量、统计与整体健康度。
 * @module @ryharness/server/routes/memory
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type MemoryService, toPublicMemories, toPublicMemory } from '@ryharness/memory'
import type { SessionStore } from '@ryharness/session'
import { json, type Router, strField } from '../router.ts'
import type { Telemetry } from '../telemetry.ts'

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
  /** 数据目录（数据库文件体积从这里量）。 */
  dataDir: string
  /** 运行时计量（"最近一次召回"取自轮次计量）。 */
  telemetry: Telemetry
}

/** 最近一次召回（GET /api/memory/health 的 lastRecall）。 */
export interface MemoryRecall {
  conversationId: string
  /** 注入该轮的记忆条数。 */
  items: number
  /** 该轮的召回耗时（毫秒，可能含多次召回的累计）。 */
  ms: number
  /** 该轮结束时刻（Unix 毫秒）。 */
  at: number
}

/** GET /api/memory/health 的返回体（记忆系统关闭时只有 enabled:false）。 */
export interface MemoryHealthReport {
  enabled: true
  /** 记忆总行数（口径同 /api/memory/stats：含归档与软删链）。 */
  total: number
  /** 已归档（status=inactive）条数。 */
  archived: number
  /** 缺当前 embedding 向量的条数（active + inactive）。 */
  missingVectors: number
  /** 各空间（agent 私有 + 共享画像）的记忆条数。 */
  bySpace: Record<string, number>
  /** <dataDir> 下 SQLite 数据文件占用的字节（含 WAL）。 */
  dbBytes: number
  embeddings: { label: string; model: string; dim?: number }
  lastRecall?: MemoryRecall
}

/** 「最近学到 N 条」的统计窗口：近 24 小时内新增的长期记忆。 */
const RECENT_LEARNED_WINDOW_MS = 86_400_000

/**
 * 记忆内容的长度上限：与抽取管线的候选事实截断（@ryharness/memory 的 llm.ts
 * slice(0, 500)）对齐——记忆本来就是一句句事实，编辑入口不该放进来一篇文章。
 */
const MAX_MEMORY_CONTENT_LENGTH = 500

/** 计数用的扫描上限：健康度要的是全量条数，列表接口的默认窗口不够看。 */
const HEALTH_COUNT_LIMIT = 10_000
/** 找"最近一次召回"时翻的轮次数：遥测环形缓冲的默认容量，一圈足够。 */
const RECALL_SCAN_LIMIT = 200
/** 计入存储体积的库文件后缀：主库 + WAL（已提交但尚未 checkpoint 的页）。 */
const DATABASE_FILE_SUFFIXES = ['.db', '.db-wal']

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

/**
 * 记忆库占用的磁盘字节：数据目录下所有 SQLite 库文件（含 WAL）。
 *
 * 记忆与会话/进化共用同一个 ryharness.db，所以这是"这台机器上的数据一共多大"，
 * 不是"记忆自己占了多少"——后者在当前存储布局下无法诚实拆出来，宁可给一个
 * 说得清的数字，也不猜一个只属于记忆的体积。
 */
function databaseBytes(dataDir: string): number {
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch {
    return 0
  }
  let bytes = 0
  for (const entry of entries) {
    if (!DATABASE_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue
    try {
      bytes += statSync(join(dataDir, entry)).size
    } catch {
      // 文件可能刚被删掉（临时目录清理等）：少算一个文件不该让整格读不出来。
    }
  }
  return bytes
}

/** 当前 embedding 模型下 active 向量的维度；一条向量都没有时缺省。 */
function embeddingDim(service: MemoryService, spaces: readonly string[]): number | undefined {
  for (const space of spaces) {
    for (const row of service.store.listActiveEmbeddings(space, service.embeddingModel)) {
      if (row.embedding !== null) return row.embedding.length
    }
  }
  return undefined
}

/**
 * 最近一次真的注入了记忆的轮次（遥测快照按时间倒序，取第一条命中）。
 *
 * 记忆召回的耗时与条数由组合根的计时钩子记在轮次计量上；轮次缓冲是环形且只活在
 * 本进程内，所以这是"本次运行以来最近的一次"，不是历史归档——重装后为空是如实的。
 */
function lastRecall(telemetry: Telemetry): MemoryRecall | undefined {
  const turn = telemetry.getSnapshot(RECALL_SCAN_LIMIT).turns.find((row) => {
    return row.memoryItems > 0
  })
  if (turn === undefined) return undefined
  return {
    conversationId: turn.conversationId,
    items: turn.memoryItems,
    ms: turn.memoryRecallMs,
    at: turn.finishedAt,
  }
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
    // 出包前一律过 toPublicMemories：store 的原始行带着 embedding（Float32Array），
    // 直接序列化会变成几千个「下标→数值」字段——既把响应撑到 MB 级，又把检索的
    // 内部状态泄给前端。归档列表与这里必须走同一道投影。
    json(res, 200, {
      agent: toPublicMemories(service.store.listActiveForAgent(req.params.id as string)),
      shared: toPublicMemories(service.store.listSharedProfile()),
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

  /**
   * 就地编辑一条记忆的内容：用户看到过时事实时改字，而不是整条删掉让 agent
   * 下一轮把错的学回来。FTS 与向量由服务层同步换新；不存在或非 active 的行
   * 一律 404（归档行走 restore，软删行不该被 id 复活改写）。
   */
  router.patch('/api/memories/:id', async (req, res) => {
    const service = memoryService()
    if (service === undefined) {
      json(res, 409, { error: 'memory system disabled' })
      return
    }
    const content = strField(await req.body(), 'content')
    if (content === undefined) {
      json(res, 400, { error: 'content is required' })
      return
    }
    const trimmed = content.trim()
    if (trimmed.length === 0) {
      json(res, 400, { error: 'content must not be empty' })
      return
    }
    if (trimmed.length > MAX_MEMORY_CONTENT_LENGTH) {
      json(res, 400, { error: `content is too long (max ${MAX_MEMORY_CONTENT_LENGTH} characters)` })
      return
    }
    const updated = await service.updateMemory(req.params.id as string, trimmed)
    if (updated === undefined) {
      json(res, 404, { error: 'memory not found' })
      return
    }
    json(res, 200, { memory: toPublicMemory(updated) })
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
   * 记忆库的整体健康度：总数 / 已归档 / 缺向量 / 各空间分布 / 存储体积 /
   * embedding 状态 / 最近一次召回。
   *
   * 「我的」页与记忆面板要的是**一次请求里的完整画面**：此前这些数字散在
   * /api/memory/stats、/api/memory/archived 与 /api/telemetry 三处，缺向量与
   * 存储体积更是没有任何路由能给，只能在界面上显示「—」。这里全部从现有 store
   * 与库文件算出来，不新增任何存储。
   *
   * 记忆系统关闭时回 200 `{enabled:false}`（面板每次打开都会拉，不该因此报错）。
   */
  router.get('/api/memory/health', async (req, res) => {
    // 健康度没有可调项：敲错的键 400，而不是被默默忽略后回一份"看起来对"的数字。
    for (const key of req.query.keys()) {
      json(res, 400, { error: `unknown query parameter: ${key}` })
      return
    }
    const service = memoryService()
    if (service === undefined) {
      json(res, 200, { enabled: false })
      return
    }
    const stats = service.store.stats()
    const dim = embeddingDim(service, Object.keys(stats.bySpace))
    const recall = lastRecall(deps.telemetry)
    const report: MemoryHealthReport = {
      enabled: true,
      total: stats.total,
      archived: service.store.listArchived(HEALTH_COUNT_LIMIT).length,
      missingVectors: service.store.listMissingEmbeddings(service.embeddingModel, HEALTH_COUNT_LIMIT).length,
      bySpace: stats.bySpace,
      dbBytes: databaseBytes(deps.dataDir),
      embeddings: {
        label: service.embeddingsAvailable ? 'configured' : 'none:fts-only',
        model: service.embeddingModel,
        ...(dim === undefined ? {} : { dim }),
      },
      ...(recall === undefined ? {} : { lastRecall: recall }),
    }
    json(res, 200, report)
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
    json(res, 200, { items: toPublicMemories(service.store.listArchived()) })
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
