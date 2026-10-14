/**
 * EvolveService：ACE 式 playbook 演化 + Reflexion 反思 + 反馈闭环 + 巩固调度。
 *
 * 闭环时序（调研 §2.2/§2.3/§2.5）：
 * - 每轮对话后（异步单 writer，与记忆抽取同节奏）：Reflector 归因计数
 *   （本轮注入的 playbook 条目：成功 helpful+1 / 失败 harmful+1，harmful≥3
 *   自动 deprecate）→ 失败触发 Reflexion（LLM 写教训入 reflections）→
 *   教训被注入后若本轮成功 hitCount+1，≥2 转正合并进 playbook（pitfall）并
 *   清理 → Curator（LLM）产出 playbook 增量 delta（add/update/deprecate，
 *   绝不整段重写）。
 * - 组装 prompt 前：compile() 编译 active 条目（helpful-harmful 排序 top-N，
 *   按 section 分组）+ 最近 1–3 条 pending 教训，格式 [经验手册]/[上次教训]。
 * - 用户反馈：👎 即时反思入库并对归因条目 harmful+1；👍 对归因条目 helpful+1。
 *
 * 不阻塞主循环（P0）：本包所有重活都在服务进程的事件循环里跑，因此
 * - 每轮管线有超时上限与阶段级失败隔离（LLM 挂掉不影响确定性计数）；
 * - 巩固（O(n²) 判重 + 溯源关联 + 归档）按切片推进，runOnce() 只做有界的一
 *   片就返回，剩余工作让出事件循环后台续跑，受总预算约束；
 * - 每轮都记账耗时与处理条目数（{@link EvolveService.metrics}）供服务端聚合。
 * @module @ryagent/evolve/service
 */

import type { EvolveLlm, PlaybookDelta, TurnTrajectory } from './llm.ts'
import { CURATOR_ENTRY_LIMIT, NEGATIVE_FEEDBACK_RE } from './llm.ts'
import type { EvolutionRoundMetrics, EvolveMetricsSnapshot, RoundKind } from './metrics.ts'
import { RoundRecorder } from './metrics.ts'
import { maxOverlap, textOverlap } from './relevance.ts'
import type { PlaybookSection } from './schema.ts'
import { AUTO_DEPRECATE_HARMFUL, CONVERT_HIT_THRESHOLD } from './schema.ts'
import type { EntryOrigin, EntryOriginInput, PlaybookEntry } from './store.ts'
import { EvolveStore } from './store.ts'

/** 一轮轨迹 + 注入归因（AgentLoop 在编译后记录）。 */
export interface EvolutionTurn extends TurnTrajectory {
  /** 本轮注入的 playbook 条目（归因计数用）。 */
  injectedPlaybookEntryIds: string[]
  /** 本轮注入的待验证教训。 */
  injectedReflectionIds: string[]
}

export interface CompiledEvolution {
  text: string
  playbookEntryIds: string[]
  reflectionIds: string[]
}

/**
 * 一轮巩固的结果。前 5 个字段是原有口径（server 直接 JSON 回去），其余是
 * 面向 P0 的可观测字段：这次调用阻塞了多久、扫了多少行、还有没有剩余切片。
 */
export interface ConsolidationResult {
  expiredReflections: number
  mergedMemories: number
  dormant: number
  archivedDormant: number
  archivedSuperseded: number
  /** 扫描过的记忆行数（判重比较 + 溯源关联）。 */
  scannedMemories: number
  /** 本轮新写的条目↔记忆溯源条数。 */
  linkedOrigins: number
  /** 隔离掉的失败次数（单个空间失败不影响整轮）。 */
  errors: number
  /** 本次调用真正占住事件循环的时间（毫秒）。 */
  durationMs: number
  /** 还有切片在后台续跑（或已被预算截断）：返回值只是本片的结果。 */
  pending: boolean
  /** 本轮因预算耗尽丢掉了剩余工作。 */
  truncated: boolean
}

/** playbook 条目的证据链（explain 面板/接口的数据源）。 */
export interface EntryExplanation {
  entry: PlaybookEntry
  origins: EntryOrigin[]
  /** 「来自教训×1、对话×2」这样的一句话摘要，UI 可直接显示。 */
  summary: string
}

/** 供 AgentLoop 接入的薄接口。 */
export interface AgentEvolutionHooks {
  /**
   * 编译注入内容。`inputText` 是本轮用户输入且必须给出：教训注入靠它做相关性
   * 筛选，缺省成"最近几条"只会把别的任务的教训糊到当前问题上。
   */
  compile(agentId: string, inputText: string): Promise<CompiledEvolution | undefined>
  enqueueTurn(agentId: string, agentName: string, conversationId: string, turn: EvolutionTurn): void
}

/** 编译注入条数上限。 */
const COMPILE_TOP_N = 12
/** 教训注入条数上限。 */
const REFLECTION_INJECT_MAX = 3
/**
 * 归因相关性阈值：注入条目与本轮输入（用户文本 / 工具名 / 助手文本）无任何词面
 * 重叠时不算"这轮用到了它"。不设下限就等于噪声条目也拿 harmful/harmful 计数，
 * auto-deprecate 建立在噪声之上。
 */
const ATTRIBUTION_RELEVANCE_THRESHOLD = 0.15
/** 巩固：长期零访问记忆的归档门槛（天）。 */
const DORMANT_ARCHIVE_DAYS = 90
/** 巩固：陈旧软删链的归档保留期（天）。 */
const SUPERSEDED_RETENTION_DAYS = 180
/** 判重合并的余弦阈值（归一化向量，点积即余弦）。 */
const MERGE_COSINE_THRESHOLD = 0.95
/** 溯源关联：条目与记忆的最小词面重叠系数（同一件事才会被关联）。 */
const MEMORY_ORIGIN_MIN_OVERLAP = 0.3
/** 溯源关联：单条记忆最多被引用的条目数上限。 */
const MEMORY_ORIGIN_MAX_REFS = 3
/** 溯源关联：每个空间最多回看多少条手册条目（手册前排的才有解释价值）。 */
const ORIGIN_ENTRY_SCAN = 40
/** 单轮巩固最多保留的「会话+轮次」溯源数（一条轨迹记多个来源时防膨胀）。 */
const TRAJECTORY_ORIGIN_LIMIT = 8
/** 归因集合上限：会话数无界增长会让这张 map 变成慢泄漏。 */
const ATTRIBUTION_MAX_KEYS = 512

const SECTION_LABELS: Record<PlaybookSection, string> = {
  strategy: '策略',
  pitfall: '坑',
  preference: '偏好',
  tooling: '工具用法',
}
const SECTION_ORDER: PlaybookSection[] = ['strategy', 'pitfall', 'preference', 'tooling']

/** 巩固周期内的反思有效期（30 天）。 */
const REFLECTION_TTL_MS = 30 * 86_400_000

/** 调度与限流参数（默认值按本地桌面规模调过，可整体覆盖）。 */
export interface EvolveLimits {
  /** 巩固单切片墙钟预算（ms）：超过就让出事件循环，主服务保持可响应。 */
  consolidationSliceMs: number
  /** 巩固单切片最多做多少次向量/文本比较（先到者为准）。 */
  consolidationSliceUnits: number
  /** 一轮巩固的总预算（ms，含后台续跑）：超时丢弃剩余工作，下轮再续。 */
  consolidationBudgetMs: number
  /** 单轮进化管线（Reflector+Reflexion+Curator）超时（ms）。 */
  turnTimeoutMs: number
  /** 待处理轮次队列上限：超出丢弃最旧的一轮（过载保护，别让队列无界涨）。 */
  maxQueuedTurns: number
  /** 溯源关联时，每个条目回看的记忆行数上限。 */
  memoryOriginScan: number
  /** 溯源关联的最小词面重叠系数。 */
  memoryOriginMinOverlap: number
  /** 耗时埋点环形缓冲保留轮数。 */
  metricsRounds: number
}

export const DEFAULT_EVOLVE_LIMITS: EvolveLimits = {
  consolidationSliceMs: 12,
  consolidationSliceUnits: 2_000,
  consolidationBudgetMs: 30_000,
  turnTimeoutMs: 60_000,
  maxQueuedTurns: 64,
  memoryOriginScan: 400,
  memoryOriginMinOverlap: MEMORY_ORIGIN_MIN_OVERLAP,
  metricsRounds: 100,
}

export interface EvolveServiceOptions {
  dbPath: string
  llm?: EvolveLlm
  logger?: (message: string) => void
  /** 耗时埋点回调（每轮进化/反馈/巩固记一次；异常不影响进化本身）。 */
  onRound?: (round: EvolutionRoundMetrics) => void
  /** 调度与限流参数；缺省项用 {@link DEFAULT_EVOLVE_LIMITS}。 */
  limits?: Partial<EvolveLimits>
}

/** 记忆巩固需要的最小存储面（由 @ryagent/memory 的 MemoryStore 满足）。 */
export interface MemorySweep {
  listSpaces(): string[]
  /** active 记忆行：`content` 除了判重还要用于「条目↔记忆」溯源关联。 */
  listActiveEmbeddings(spaceId: string): {
    id: string
    content: string
    embedding: Float32Array | null
    accessCount: number
    updatedAt: number
  }[]
  supersede(id: string, status: 'superseded'): void
  /** 长期零访问记忆 → inactive（不物理删除）。返回归档条数。 */
  archiveDormant(dormantAfterMs: number, now: number): number
  /** 陈旧软删链（保留当前有效版本的直接前身）→ inactive。返回归档条数。 */
  archiveColdSuperseded(maxAgeMs: number, now: number): number
}

export class EvolveService implements AgentEvolutionHooks {
  readonly store: EvolveStore
  private readonly llm: EvolveLlm | undefined
  private readonly log: (message: string) => void
  private readonly limits: EvolveLimits
  private readonly recorder: RoundRecorder
  /** 待处理的每轮轨迹（单 writer 串行消费；容量上限见 maxQueuedTurns）。 */
  private readonly tasks: TurnTask[] = []
  private draining: Promise<void> | undefined
  /** 因过载被丢弃的轮次计数（埋点与日志都看它）。 */
  private droppedTurns = 0
  /** 最近注入归因：`${conversationId}:${agentId}` → 注入集合（👍/👎 归因用）。 */
  private readonly attribution = new Map<string, { playbookEntryIds: string[]; reflectionIds: string[] }>()
  private consolidationTimer: ReturnType<typeof setInterval> | undefined
  private memory: MemorySweep | undefined
  /** 在跑的巩固切片状态（跨 runOnce 调用续跑）。 */
  private sweep: SweepState | undefined
  private sweepDrain: Promise<void> | undefined
  /** 本轮巩固的状态（runUntilIdle 要在跑完后拿它算完整口径）。 */
  private sweepRound: SweepState | undefined
  /** 最近一轮巩固的完整结果（后台续跑结束后刷新）。 */
  private lastConsolidation: ConsolidationResult | undefined
  private closed = false

  constructor(options: EvolveServiceOptions) {
    this.store = new EvolveStore(options.dbPath)
    this.llm = options.llm
    this.log =
      options.logger ??
      ((message) => {
        console.log(message)
      })
    this.limits = { ...DEFAULT_EVOLVE_LIMITS, ...options.limits }
    this.recorder =
      options.onRound === undefined
        ? new RoundRecorder(this.limits.metricsRounds)
        : new RoundRecorder(this.limits.metricsRounds, options.onRound)
  }

  close(): void {
    this.closed = true
    this.stopConsolidation()
    this.sweep = undefined
    this.tasks.length = 0
    this.store.close()
  }

  // ---- 注入（组装 prompt 前）----

  /**
   * 编译该 agent 的进化上下文：active playbook 条目（net 排序 top-N、按
   * section 分组）+ 与本轮输入相关的 pending 教训（top-N）。无内容返回
   * undefined。
   * @param agentId - agent id。
   * @param inputText - 本轮用户输入；教训按与它的词面相关性选取。
   */
  async compile(agentId: string, inputText: string): Promise<CompiledEvolution | undefined> {
    // 按 net = helpful - harmful 降序。ties 交给 Array#sort 的稳定性：底层查询
    // 已按 (section, net desc, updated_at desc) 排好，平分条目的先后确定。
    const entries = this.store
      .listActiveForCompile(agentId)
      .sort((a, b) => {
        return b.helpful - b.harmful - (a.helpful - a.harmful)
      })
      .slice(0, COMPILE_TOP_N)
    const reflections = this.store.searchPendingReflections(agentId, inputText, REFLECTION_INJECT_MAX)

    const sections: string[] = []
    const playbookEntryIds: string[] = []
    if (entries.length > 0) {
      const bySection = new Map<PlaybookSection, PlaybookEntry[]>()
      for (const entry of entries) {
        const list = bySection.get(entry.section) ?? []
        list.push(entry)
        bySection.set(entry.section, list)
      }
      for (const section of SECTION_ORDER) {
        const list = bySection.get(section)
        if (list === undefined) continue
        sections.push(
          `${SECTION_LABELS[section]}：${list
            .map((e) => {
              return e.content
            })
            .join('；')}`,
        )
        playbookEntryIds.push(
          ...list.map((e) => {
            return e.id
          }),
        )
      }
    }
    const reflectionIds = reflections.map((r) => {
      return r.id
    })
    if (reflections.length > 0) {
      sections.push(
        `上次教训：\n${reflections
          .map((r) => {
            return `- ${r.lesson}`
          })
          .join('\n')}`,
      )
    }

    if (sections.length === 0) return undefined
    return {
      text: `[经验手册]\n${sections.join('\n')}`,
      playbookEntryIds,
      reflectionIds,
    }
  }

  // ---- 每轮后异步管线 ----

  enqueueTurn(agentId: string, agentName: string, conversationId: string, turn: EvolutionTurn): void {
    // 归因只记与本轮有关的条目：噪声条目也 ±1 会把 harmful 排序与自动
    // deprecate 建在噪声上。反馈闭环复用同一份集合。
    const relevant = this.relevantEntryIds(turn)
    this.rememberAttribution(`${conversationId}:${agentId}`, {
      playbookEntryIds: relevant,
      reflectionIds: [...turn.injectedReflectionIds],
    })
    if (this.llm === undefined && turn.injectedPlaybookEntryIds.length === 0) return
    // 过载保护：LLM 慢于对话节奏时队列会无界涨（每轮两次 LLM 调用），
    // 内存涨到 OOM 只是时间问题。丢最旧的一轮并记账——进化是后台增强，
    // 丢几轮归因远好过拖垮整个服务。
    if (this.tasks.length >= this.limits.maxQueuedTurns) {
      this.tasks.shift()
      this.droppedTurns += 1
      this.log(`@ryagent/evolve: turn queue overflow (${this.limits.maxQueuedTurns}), dropped oldest turn`)
    }
    this.tasks.push({
      agentId,
      agentName,
      conversationId,
      turnKey: `${conversationId.length === 0 ? 'turn' : conversationId}:${Date.now()}`,
      turn,
      relevantEntryIds: relevant,
    })
    this.startDrain()
  }

  /** 注入条目里与本轮输入真正相关的那些（无文本可判时全部保留）。 */
  private relevantEntryIds(turn: EvolutionTurn): string[] {
    const context = turnContextTexts(turn)
    if (context.length === 0) return [...turn.injectedPlaybookEntryIds]
    const relevant: string[] = []
    for (const entryId of turn.injectedPlaybookEntryIds) {
      const entry = this.store.getEntry(entryId)
      if (entry === undefined) continue
      const score = maxOverlap(entry.content, context)
      if (score >= ATTRIBUTION_RELEVANCE_THRESHOLD) relevant.push(entryId)
    }
    return relevant
  }

  /** 记归因集合；超过上限按插入序淘汰最旧的键（长跑进程不漏内存）。 */
  private rememberAttribution(key: string, value: { playbookEntryIds: string[]; reflectionIds: string[] }): void {
    this.attribution.delete(key)
    this.attribution.set(key, value)
    while (this.attribution.size > ATTRIBUTION_MAX_KEYS) {
      const oldest = this.attribution.keys().next()
      if (oldest.done === true) break
      this.attribution.delete(oldest.value)
    }
  }

  /** 测试用：等队列与巩固续跑都排空。 */
  async flush(): Promise<void> {
    while (this.draining !== undefined || this.tasks.length > 0) {
      const draining = this.draining
      if (draining === undefined) {
        this.startDrain()
        continue
      }
      await draining
    }
    while (this.sweepDrain !== undefined) {
      await this.sweepDrain
    }
  }

  private startDrain(): void {
    if (this.draining !== undefined) return
    const drain = this.drain().finally(() => {
      if (this.draining === drain) this.draining = undefined
    })
    this.draining = drain
  }

  /** 单 writer 串行消费；一轮抛错不影响后续轮次（失败隔离在 runTurnIsolated）。 */
  private async drain(): Promise<void> {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift() as TurnTask
      await this.runTurnIsolated(task)
    }
  }

  /**
   * 一轮轨迹的执行外壳：确定性部分（归因计数/教训验证）先跑且只跑一次——
   * 重试会重复计分，把自动弃用建立在重复的 harmful 上。LLM 阶段带超时与
   * 阶段级隔离：Reflexion 挂了不影响 Curator，反之亦然。
   */
  private async runTurnIsolated(task: TurnTask): Promise<void> {
    const startedAt = Date.now()
    let processed = 0
    try {
      processed += this.attributeTurn(task)
    } catch (error) {
      this.record({ kind: 'turn', startedAt, processed, ok: false, error })
      this.log(`@ryagent/evolve: attribution failed: ${describe(error)}`)
      return
    }
    if (this.llm === undefined) {
      this.record({ kind: 'turn', startedAt, processed, ok: true })
      return
    }
    try {
      processed += await withTimeout(
        this.llmStages(task),
        this.limits.turnTimeoutMs,
        `turn pipeline exceeded turnTimeoutMs=${this.limits.turnTimeoutMs}ms`,
      )
      this.record({ kind: 'turn', startedAt, processed, ok: true })
    } catch (error) {
      this.record({ kind: 'turn', startedAt, processed, ok: false, error })
      this.log(`@ryagent/evolve: turn pipeline aborted: ${describe(error)}`)
    }
  }

  /** Reflector 归因计数 + 教训验证（确定性，不烧 LLM，不重试）。返回处理条数。 */
  private attributeTurn(task: TurnTask): number {
    const { agentId, turn, relevantEntryIds } = task
    const failed = turnFailure(turn).failed
    let processed = 0

    for (const entryId of relevantEntryIds) {
      this.store.addCounts(entryId, failed ? { harmful: 1 } : { helpful: 1 })
      processed += 1
      const entry = this.store.getEntry(entryId)
      if (
        entry !== undefined &&
        entry.status === 'active' &&
        entry.harmful + (failed ? 1 : 0) >= AUTO_DEPRECATE_HARMFUL
      ) {
        this.store.setEntryStatus(entryId, 'deprecated')
        this.log(`@ryagent/evolve: entry ${entryId} auto-deprecated (harmful>=${AUTO_DEPRECATE_HARMFUL})`)
      }
    }

    if (!failed) {
      for (const reflectionId of turn.injectedReflectionIds) {
        const reflection = this.store.getReflection(reflectionId)
        if (reflection === undefined || reflection.status !== 'pending') continue
        this.store.bumpReflectionHit(reflectionId)
        const updated = this.store.getReflection(reflectionId)!
        if (updated.hitCount < CONVERT_HIT_THRESHOLD) continue
        // 转正也要过近似去重：同一条教训换个说法反复转正，会把 top-N 名额
        // 吃光，手册看起来"学了很多"，实际注入的全是同义重复。
        if (
          !this.store.hasDuplicate(agentId, 'pitfall', updated.lesson) &&
          !this.store.hasNearDuplicate(agentId, 'pitfall', updated.lesson)
        ) {
          this.store.insertEntry({
            agentId,
            section: 'pitfall',
            content: updated.lesson,
            source: 'reflection',
            origins: [
              { kind: 'reflection', refId: reflectionId, detail: updated.lesson },
              ...this.turnOrigins(task, '转正验证'),
            ],
          })
          processed += 1
        }
        this.store.setReflectionStatus(reflectionId, 'converted')
      }
    }
    return processed
  }

  /** Reflexion + Curator：阶段级隔离，一个阶段失败不带走另一个。 */
  private async llmStages(task: TurnTask): Promise<number> {
    const { agentId, agentName, conversationId, turn } = task
    const failure = turnFailure(turn)
    const reason = task.forcedReason ?? failure.reason
    let processed = 0
    if (this.llm === undefined) return processed

    if (failure.failed || task.forcedReason !== undefined) {
      try {
        const lesson = await this.llm.reflect({ agentName, trajectory: turn, reason })
        this.store.insertReflection({
          agentId,
          lesson,
          contextDigest: `${turn.userText.slice(0, 80)} → ${turn.assistantText.slice(0, 80)}`,
          sourceConversationId: conversationId,
        })
        processed += 1
      } catch (error) {
        this.log(`@ryagent/evolve: reflection failed: ${describe(error)}`)
      }
    }

    try {
      // 把既有条目交给 Curator：没有条目列表，模型只能 add，update/deprecate
      // 的 entryId 全是幻觉（必然被下面的校验拒掉）。
      const entries = this.store.listActiveForCompile(agentId, CURATOR_ENTRY_LIMIT)
      const deltas = await this.llm.proposeDeltas({
        agentName,
        trajectory: turn,
        entries: entries.map((entry) => {
          return {
            id: entry.id,
            section: entry.section,
            content: entry.content,
            helpful: entry.helpful,
            harmful: entry.harmful,
          }
        }),
      })
      processed += this.applyDeltas(task, deltas)
    } catch (error) {
      this.log(`@ryagent/evolve: curator failed: ${describe(error)}`)
    }
    return processed
  }

  /** 校验并落库 Curator 的增量；每条变更都写溯源。返回实际落库条数。 */
  private applyDeltas(task: TurnTask, deltas: readonly PlaybookDelta[]): number {
    const { agentId } = task
    let applied = 0
    for (const delta of deltas) {
      switch (delta.op) {
        case 'add':
          if (
            !this.store.hasDuplicate(agentId, delta.section, delta.content) &&
            !this.store.hasNearDuplicate(agentId, delta.section, delta.content)
          ) {
            this.store.insertEntry({
              agentId,
              section: delta.section,
              content: delta.content,
              source: 'curator',
              origins: this.turnOrigins(task, 'Curator 新增'),
            })
            applied += 1
          }
          break
        case 'update': {
          const existing = this.store.getEntry(delta.entryId)
          if (existing === undefined || existing.agentId !== agentId || existing.status !== 'active') break
          // 改写后的内容不得与另一条既有条目近似重复（否则手册自我复制）。
          if (this.store.hasNearDuplicateExcept(agentId, existing.section, delta.content, existing.id)) break
          this.store.updateEntryContent(delta.entryId, delta.content)
          this.store.recordOrigins(delta.entryId, this.turnOrigins(task, 'Curator 改写'))
          applied += 1
          break
        }
        case 'deprecate': {
          const existing = this.store.getEntry(delta.entryId)
          if (existing !== undefined && existing.agentId === agentId && existing.status === 'active') {
            this.store.setEntryStatus(delta.entryId, 'deprecated')
            this.store.recordOrigins(delta.entryId, this.turnOrigins(task, 'Curator 弃用'))
            applied += 1
          }
          break
        }
      }
    }
    return applied
  }

  /** 该轮轨迹的溯源（会话 + 轮次 + 成败与输入摘要）。 */
  private turnOrigins(task: TurnTask, action: string): EntryOriginInput[] {
    const { turn, turnKey } = task
    const verdict = turnFailure(turn).failed ? '失败' : '成功'
    const digest = turn.userText.slice(0, 60).trim()
    return [
      {
        kind: 'trajectory',
        refId: turnKey,
        detail: `${action}（${verdict}）：${digest.length === 0 ? '（无输入文本）' : digest}`,
      },
    ]
  }

  private record(round: {
    kind: RoundKind
    startedAt: number
    /** 缺省用「现在 - 开始」；后台续跑要显式传「真正占用事件循环的时间」。 */
    durationMs?: number
    processed: number
    ok: boolean
    error?: unknown
  }): void {
    this.recorder.record({
      kind: round.kind,
      startedAt: round.startedAt,
      durationMs: round.durationMs ?? Math.max(0, Date.now() - round.startedAt),
      processed: round.processed,
      ok: round.ok,
      ...(round.error === undefined ? {} : { error: describe(round.error) }),
    })
  }

  // ---- 用户反馈闭环 ----

  /**
   * 👎：即时反思入库 + 归因条目 harmful+1；👍：归因条目 helpful+1。
   * 归因 = 该 agent 在该会话最近一次注入的集合（串行队列下的近似）。
   * 反馈同时写进溯源：条目被 👍/👎 过这件事要能在手册里被看见。
   */
  recordFeedback(input: {
    agentId: string
    conversationId: string
    signal: 'thumb_up' | 'thumb_down'
    userText?: string
    assistantText?: string
  }): void {
    const startedAt = Date.now()
    const feedbackId = this.store.recordFeedback({
      agentId: input.agentId,
      conversationId: input.conversationId,
      turnIndex: -1,
      signal: input.signal,
    })
    const injected = this.attribution.get(`${input.conversationId}:${input.agentId}`)
    if (injected === undefined) {
      this.record({ kind: 'feedback', startedAt, processed: 0, ok: true })
      return
    }
    const label = input.signal === 'thumb_up' ? '👍 认可' : '👎 差评'
    const origin = (): EntryOriginInput[] => {
      return [{ kind: 'feedback', refId: feedbackId, detail: `${label}（会话 ${input.conversationId}）` }]
    }
    if (input.signal === 'thumb_up') {
      for (const entryId of injected.playbookEntryIds) {
        this.store.addCounts(entryId, { helpful: 1 })
        this.store.recordOrigins(entryId, origin())
      }
      this.record({ kind: 'feedback', startedAt, processed: injected.playbookEntryIds.length, ok: true })
      return
    }
    for (const entryId of injected.playbookEntryIds) {
      this.store.addCounts(entryId, { harmful: 1 })
      this.store.recordOrigins(entryId, origin())
      const entry = this.store.getEntry(entryId)
      if (entry !== undefined && entry.status === 'active' && entry.harmful + 1 >= AUTO_DEPRECATE_HARMFUL) {
        this.store.setEntryStatus(entryId, 'deprecated')
      }
    }
    if (this.llm !== undefined) {
      const trajectory: TurnTrajectory = {
        userText: input.userText ?? '',
        assistantText: input.assistantText ?? '',
        toolResults: [],
        llmError: false,
      }
      this.tasks.push({
        agentId: input.agentId,
        agentName: '',
        conversationId: input.conversationId,
        turnKey: `feedback:${feedbackId}`,
        // 👎 本身就是反思触发器，与轮次失败信号无关：强制走 Reflexion。
        forcedReason: '用户点了差评',
        turn: { ...trajectory, injectedPlaybookEntryIds: [], injectedReflectionIds: [] },
        relevantEntryIds: [],
      })
      this.startDrain()
    }
    this.record({ kind: 'feedback', startedAt, processed: injected.playbookEntryIds.length, ok: true })
  }

  // ---- 可解释性证据链 ----

  /**
   * 某条 playbook 条目的完整来源（explain 面板/接口的数据源）：条目本体 +
   * 溯源列表 + 一句人话总结。条目不存在返回 undefined。
   */
  explain(entryId: string): EntryExplanation | undefined {
    const entry = this.store.getEntry(entryId)
    if (entry === undefined) return undefined
    const origins = this.store.listOrigins(entryId)
    return { entry, origins, summary: summarizeOrigins(entry, origins) }
  }

  // ---- 耗时埋点 ----

  /**
   * 耗时与吞吐快照（最近 `limit` 轮，新的在前）。服务端面板拿它做聚合，
   * 落盘与否由调用方决定——本包不持有历史。
   */
  metrics(limit?: number): EvolveMetricsSnapshot & { droppedTurns: number } {
    return { ...this.recorder.snapshot(limit), droppedTurns: this.droppedTurns }
  }

  // ---- 手动/周期 playbook 管理 ----

  setEntryStatus(entryId: string, status: 'active' | 'deprecated'): void {
    this.store.setEntryStatus(entryId, status)
  }

  // ---- 巩固调度（收编记忆遗留项）----

  /** 挂载记忆清扫面（runOnce 的判重合并用）。 */
  attachMemorySweep(sweep: MemorySweep): void {
    this.memory = sweep
  }

  /**
   * 巩固任务（幂等）：
   * 1. 到期反思清理（>30 天未转正 → expired，一条 UPDATE，直接同步做完）；
   * 2. 重复记忆合并：同空间 embedding 余弦 >0.95 的对 → supersede 旧条目
   *    （确定性阈值，不再烧 LLM——桌面规模下足够，LLM 判重留给未来）；
   * 3. 条目↔记忆溯源关联：把词面重合的记忆记进 entry_origins（证据链的
   *    「从哪几条记忆来」）；
   * 4. 记忆归档（保守）：90 天零访问 → inactive；180 天以上的软删链中间版本
   *    → inactive。都不物理删除，只移出检索面（dormant 只统计日志等于让记忆
   *    库无界增长）。
   *
   * 分片执行：2–4 是 O(n²) 的重活，跑在服务进程的事件循环里，一次性跑完会把
   * 整个 server 冻住（实测可到数十秒）。这里 runOnce() 只同步做**有界的一片**
   * （默认 ≤12ms 或 ≤2000 次比较，先到者为准），剩下的切片让出事件循环后台
   * 续跑，并受整轮预算约束；单个空间出错只跳过该空间。
   */
  runOnce(now = Date.now()): ConsolidationResult {
    const startedAt = Date.now()
    const expired = this.store.expireReflections(REFLECTION_TTL_MS, now)
    const state = this.sweep ?? this.beginSweep(now)
    const slice = this.sweepSlice(state, this.limits.consolidationSliceUnits, this.limits.consolidationSliceMs)
    this.sweepRound = state
    this.sweep = state.completed || state.timedOut ? undefined : state
    this.resumeSweep(state)
    const result = this.consolidationResult(state, expired, slice.blockedMs)
    this.record({ kind: 'consolidate', startedAt, durationMs: slice.blockedMs, processed: slice.units, ok: true })
    if (expired > 0 || result.mergedMemories > 0 || result.dormant > 0 || result.linkedOrigins > 0) {
      this.log(
        `@ryagent/evolve: consolidate expired=${expired} merged=${result.mergedMemories} dormant=${result.dormant} ` +
          `origins=${result.linkedOrigins} archived=${result.archivedDormant + result.archivedSuperseded} ` +
          `(dormant=${result.archivedDormant} superseded=${result.archivedSuperseded}) scanned=${result.scannedMemories} ` +
          `blocked=${slice.blockedMs}ms pending=${result.pending}`,
      )
    }
    return result
  }

  private consolidationResult(state: SweepState, expiredReflections: number, blockedMs: number): ConsolidationResult {
    return {
      expiredReflections,
      mergedMemories: state.merged,
      dormant: state.dormant,
      archivedDormant: state.archivedDormant,
      archivedSuperseded: state.archivedSuperseded,
      scannedMemories: state.scanned,
      linkedOrigins: state.origins,
      errors: state.errors,
      durationMs: blockedMs,
      // 预算耗尽时没有「后台还在跑」这回事，剩余工作已被丢弃（truncated 标记）。
      pending: !state.completed && !state.timedOut,
      truncated: state.timedOut,
    }
  }

  /**
   * 等待一轮巩固彻底跑完（含后台切片）。服务端手动触发 / 关闭路径用；
   * 周期调度走 runOnce() 的异步续跑，不需要等。返回值是**整轮跑完**后的口径
   * （runOnce 返回的只是第一片的快照）。
   */
  async runUntilIdle(now = Date.now()): Promise<ConsolidationResult> {
    const result = this.runOnce(now)
    while (this.sweepDrain !== undefined) await this.sweepDrain
    const state = this.sweepRound
    if (state === undefined) return result
    const final = this.consolidationResult(state, result.expiredReflections, result.durationMs)
    this.lastConsolidation = final
    return final
  }

  private beginSweep(now: number): SweepState {
    return {
      now,
      deadline: Date.now() + this.limits.consolidationBudgetMs,
      phase: 'dedupe',
      spaces: [],
      spaceIndex: 0,
      rows: [],
      loaded: false,
      scannedSpace: false,
      rowIndex: 0,
      colIndex: 0,
      entries: [],
      entryIndex: 0,
      memIndex: 0,
      matches: [],
      merged: 0,
      dormant: 0,
      scanned: 0,
      origins: 0,
      errors: 0,
      archivedDormant: 0,
      archivedSuperseded: 0,
      completed: false,
      timedOut: false,
    }
  }

  /** 跑一片（同步、有界）。返回本次消耗的比较次数与占用事件循环的毫秒数。 */
  private sweepSlice(state: SweepState, maxUnits: number, maxMs: number): { units: number; blockedMs: number } {
    const startedAt = Date.now()
    let units = 0
    while (!state.completed && units < maxUnits) {
      if (Date.now() - startedAt >= maxMs) break
      units += this.advance(state)
    }
    return { units, blockedMs: Date.now() - startedAt }
  }

  /** 一步推进（一个游标单位）。返回本次消耗的单位数（阶段切换按 1 计）。 */
  private advance(state: SweepState): number {
    if (state.phase === 'dedupe') return this.advanceDedupe(state)
    if (state.phase === 'origins') return this.advanceOrigins(state)
    this.runArchive(state)
    return 1
  }

  private advanceDedupe(state: SweepState): number {
    if (!state.loaded) {
      state.spaces = this.memory === undefined ? [] : this.loadSpaces(state)
      state.loaded = true
      return 1
    }
    if (state.spaceIndex >= state.spaces.length) return this.enterOriginsPhase(state)
    if (state.rows.length === 0 && !state.scannedSpace) {
      const space = state.spaces[state.spaceIndex] as string
      state.rows = this.memory === undefined ? [] : this.loadRows(state, space)
      state.scannedSpace = true
      state.rowIndex = 0
      state.colIndex = 1
      return 1
    }
    const a = state.rows[state.rowIndex] as SweepRow | undefined
    if (a === undefined) return this.nextDedupeSpace(state)
    if (a.embedding === null || state.colIndex >= state.rows.length) return this.leaveDedupeRow(state)
    const b = state.rows[state.colIndex] as SweepRow
    if (b.embedding !== null && cosine(a.embedding, b.embedding) > MERGE_COSINE_THRESHOLD) {
      try {
        this.memory?.supersede(b.id, 'superseded')
        state.merged += 1
      } catch (error) {
        state.errors += 1
        this.log(`@ryagent/evolve: supersede failed on ${b.id}: ${describe(error)}`)
      }
    }
    state.colIndex += 1
    state.scanned += 1
    return 1
  }

  /** 离开当前行（它的两两比较已经做完）：顺手记一次 dormant，再换行。 */
  private leaveDedupeRow(state: SweepState): number {
    const row = state.rows[state.rowIndex] as SweepRow | undefined
    // dormant 是状态快照而非动作：零访问且超期就该被归档，与有没有向量无关
    // （记忆侧 archiveDormant 也是按访问时间全量 UPDATE 的）。每行只数一次。
    if (row !== undefined && row.accessCount === 0 && state.now - row.updatedAt > DORMANT_ARCHIVE_DAYS * 86_400_000) {
      state.dormant += 1
    }
    state.rowIndex += 1
    state.colIndex = state.rowIndex + 1
    if (state.rowIndex < state.rows.length) return 1
    return this.nextDedupeSpace(state)
  }

  private nextDedupeSpace(state: SweepState): number {
    state.spaceIndex += 1
    state.rows = []
    state.scannedSpace = false
    state.rowIndex = 0
    state.colIndex = 1
    return 1
  }

  private enterOriginsPhase(state: SweepState): number {
    state.phase = 'origins'
    state.spaceIndex = 0
    state.entries = []
    state.entryIndex = 0
    state.loaded = false
    return 1
  }

  /** 条目↔记忆溯源：把词面重合的记忆记进 entry_origins。 */
  private advanceOrigins(state: SweepState): number {
    if (!state.loaded) {
      if (state.spaces.length === 0 || state.spaceIndex >= state.spaces.length) {
        state.phase = 'archive'
        return 1
      }
      const space = state.spaces[state.spaceIndex] as string
      state.entries = this.store.listActiveForCompile(space, ORIGIN_ENTRY_SCAN)
      state.rows = this.memory === undefined ? [] : this.loadRows(state, space).slice(0, this.limits.memoryOriginScan)
      state.entryIndex = 0
      state.memIndex = 0
      state.matches = []
      state.loaded = true
      return 1
    }
    if (state.entryIndex >= state.entries.length) {
      state.spaceIndex += 1
      state.entries = []
      state.rows = []
      state.loaded = false
      if (state.spaceIndex >= state.spaces.length) state.phase = 'archive'
      return 1
    }
    if (state.memIndex >= state.rows.length) return this.finishOriginEntry(state)
    const entry = state.entries[state.entryIndex] as PlaybookEntry
    const row = state.rows[state.memIndex] as SweepRow
    state.memIndex += 1
    state.scanned += 1
    if (textOverlap(entry.content, row.content) >= this.limits.memoryOriginMinOverlap) {
      state.matches.push({ refId: row.id, detail: row.content.slice(0, 60) })
    }
    return 1
  }

  private finishOriginEntry(state: SweepState): number {
    const entry = state.entries[state.entryIndex] as PlaybookEntry
    const top = state.matches.slice(0, MEMORY_ORIGIN_MAX_REFS)
    try {
      state.origins += this.store.recordOrigins(
        entry.id,
        top.map((match) => {
          return { kind: 'memory' as const, refId: match.refId, detail: match.detail }
        }),
      )
    } catch (error) {
      state.errors += 1
      this.log(`@ryagent/evolve: recordOrigins failed on ${entry.id}: ${describe(error)}`)
    }
    state.entryIndex += 1
    state.memIndex = 0
    state.matches = []
    return 1
  }

  private runArchive(state: SweepState): void {
    if (this.memory !== undefined) {
      try {
        state.archivedDormant = this.memory.archiveDormant(DORMANT_ARCHIVE_DAYS * 86_400_000, state.now)
        state.archivedSuperseded = this.memory.archiveColdSuperseded(SUPERSEDED_RETENTION_DAYS * 86_400_000, state.now)
      } catch (error) {
        state.errors += 1
        this.log(`@ryagent/evolve: archive failed: ${describe(error)}`)
      }
    }
    state.completed = true
  }

  /** 列出待巩固的空间；抛错按空集处理（一个空间挂掉不该废掉整轮）。 */
  private loadSpaces(state: SweepState): string[] {
    try {
      return this.memory?.listSpaces() ?? []
    } catch (error) {
      state.errors += 1
      this.log(`@ryagent/evolve: listSpaces failed: ${describe(error)}`)
      return []
    }
  }

  private loadRows(state: SweepState, space: string): SweepRow[] {
    try {
      return this.memory?.listActiveEmbeddings(space) ?? []
    } catch (error) {
      state.errors += 1
      this.log(`@ryagent/evolve: listActiveEmbeddings failed (space=${space}): ${describe(error)}`)
      return []
    }
  }

  /** 后台续跑剩余切片：每片之间让出事件循环，整轮受预算约束。 */
  private resumeSweep(state: SweepState): void {
    if (state.completed || state.timedOut || this.closed || this.sweepDrain !== undefined) return
    const drain = this.drainSweep(state).finally(() => {
      if (this.sweepDrain === drain) this.sweepDrain = undefined
    })
    this.sweepDrain = drain
  }

  private async drainSweep(state: SweepState): Promise<void> {
    const startedAt = Date.now()
    let units = 0
    let blockedMs = 0
    let failure: unknown
    try {
      while (!state.completed && !this.closed) {
        if (Date.now() >= state.deadline) {
          state.timedOut = true
          this.log(
            `@ryagent/evolve: consolidation exceeded ${this.limits.consolidationBudgetMs}ms budget, ` +
              'remaining work dropped and retried next round',
          )
          break
        }
        await yieldToEventLoop()
        const slice = this.sweepSlice(state, this.limits.consolidationSliceUnits, this.limits.consolidationSliceMs)
        units += slice.units
        blockedMs += slice.blockedMs
      }
    } catch (error) {
      failure = error
      state.errors += 1
      this.log(`@ryagent/evolve: consolidation aborted: ${describe(error)}`)
    }
    // 跑完或被预算截断，这一轮的状态都不再续跑：下一轮从干净游标重来
    // （续着半截游标只会让"本轮计数"无限累加）。
    if (state.completed || state.timedOut || this.closed) this.sweep = undefined
    if (this.sweepRound === state) {
      this.lastConsolidation = this.consolidationResult(
        state,
        this.lastConsolidation?.expiredReflections ?? 0,
        blockedMs,
      )
    }
    // 记的是「这一段真正占住事件循环的时间」，不是含让出的墙钟——
    // 服务端要看的是"进化/巩固把主进程卡了多久"。
    this.record({
      kind: 'consolidate',
      startedAt,
      durationMs: blockedMs,
      processed: units,
      ok: failure === undefined,
      ...(failure === undefined ? {} : { error: failure }),
    })
    this.log(
      `@ryagent/evolve: consolidate tail units=${units} blocked=${blockedMs}ms completed=${state.completed} ` +
        `timedOut=${state.timedOut} errors=${state.errors}`,
    )
  }

  /** 最近一轮巩固的完整结果（含后台续跑后的最终计数）。 */
  lastConsolidationResult(): ConsolidationResult | undefined {
    return this.lastConsolidation
  }

  /** 启动周期巩固（默认 6 小时）；返回停止函数。可关：不调用即可。 */
  startConsolidation(intervalMs = 6 * 3_600_000): () => void {
    this.stopConsolidation()
    this.consolidationTimer = setInterval(() => {
      if (this.closed) return
      try {
        this.runOnce()
      } catch (error) {
        this.log(`@ryagent/evolve: consolidate failed: ${describe(error)}`)
      }
    }, intervalMs)
    // 周期任务不该拖住进程退出（内嵌模式/测试），与 server 的 WS 心跳一致。
    this.consolidationTimer.unref?.()
    return () => {
      this.stopConsolidation()
    }
  }

  stopConsolidation(): void {
    if (this.consolidationTimer !== undefined) {
      clearInterval(this.consolidationTimer)
      this.consolidationTimer = undefined
    }
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

/** 归因判定的上下文文本：用户输入、工具名、助手回复。 */
function turnContextTexts(turn: EvolutionTurn): string[] {
  return [
    turn.userText,
    turn.assistantText,
    ...turn.toolResults.map((result) => {
      return result.name
    }),
  ].filter((text) => {
    return text.trim().length > 0
  })
}

/** 本轮是否失败，以及给 Reflexion 看的失败原因。 */
function turnFailure(turn: EvolutionTurn): { failed: boolean; reason: string } {
  const toolErrors = turn.toolResults.filter((t) => {
    return t.isError
  }).length
  const negativeFeedback = NEGATIVE_FEEDBACK_RE.test(turn.userText)
  const failed = turn.llmError || toolErrors >= 2 || negativeFeedback
  const reason = turn.llmError
    ? 'LLM 流以错误收尾'
    : negativeFeedback
      ? '用户表达负反馈'
      : `工具连续失败（${toolErrors} 次）`
  return { failed, reason }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 让出一个宏任务：后台切片之间主循环要能处理 HTTP/WS 事件。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * 超时包装。超时后底层 promise 仍会跑完（LLM 请求没法中断），这里只是不再
 * 阻塞管线；给原 promise 挂 catch 是必须的，否则迟到的 reject 变成
 * unhandledRejection 把进程带下去。
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
    timer.unref?.()
  })
  work.catch(() => {})
  try {
    return await Promise.race([work, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 一条待处理的轨迹（进队列的形态，带溯源用的轮次键）。 */
interface TurnTask {
  agentId: string
  agentName: string
  conversationId: string
  /** 溯源用的轮次标识：会话 id + 入队时刻（会话为空时退回本进程内唯一键）。 */
  turnKey: string
  /** 强制反思原因（👎 反馈走这里）；缺省按轮次失败信号判定。 */
  forcedReason?: string
  turn: EvolutionTurn
  relevantEntryIds: readonly string[]
}

/** 记忆清扫面返回的一行。 */
interface SweepRow {
  id: string
  content: string
  embedding: Float32Array | null
  accessCount: number
  updatedAt: number
}

type SweepPhase = 'dedupe' | 'origins' | 'archive'

/** 巩固的游标状态（跨 runOnce 续跑，让出事件循环而不是重头再来）。 */
interface SweepState {
  now: number
  deadline: number
  phase: SweepPhase
  spaces: string[]
  spaceIndex: number
  rows: SweepRow[]
  /** 当前空间/阶段的数据是否已装载（区分「没装」与「装到 0 行」）。 */
  loaded: boolean
  scannedSpace: boolean
  rowIndex: number
  colIndex: number
  entries: PlaybookEntry[]
  entryIndex: number
  memIndex: number
  matches: { refId: string; detail: string }[]
  merged: number
  dormant: number
  scanned: number
  origins: number
  errors: number
  archivedDormant: number
  archivedSuperseded: number
  completed: boolean
  timedOut: boolean
}

const ORIGIN_KIND_LABELS: Record<EntryOrigin['kind'], string> = {
  trajectory: '对话',
  reflection: '教训',
  feedback: '反馈',
  memory: '记忆',
  seed: '种子',
}

/** 一句话来源摘要（UI 直接显示；detail 缺失时按种类兜底）。 */
function summarizeOrigins(entry: PlaybookEntry, origins: readonly EntryOrigin[]): string {
  if (origins.length === 0) {
    return `来源未知（${SOURCE_LABELS[entry.source]}，无溯源记录）`
  }
  const groups = new Map<string, number>()
  for (const origin of origins) {
    groups.set(origin.kind, (groups.get(origin.kind) ?? 0) + 1)
  }
  const parts = [...groups.entries()].map(([kind, count]) => {
    return count > 1
      ? `${ORIGIN_KIND_LABELS[kind as EntryOrigin['kind']]}×${count}`
      : ORIGIN_KIND_LABELS[kind as EntryOrigin['kind']]
  })
  return `来自${parts.join('、')}`
}

const SOURCE_LABELS: Record<PlaybookEntry['source'], string> = {
  curator: 'Curator 归纳',
  reflection: '教训转正',
  seed: '冷启动模板',
  manual: '手动录入',
}
