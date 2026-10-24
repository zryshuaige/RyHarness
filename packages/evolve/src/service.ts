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
 * - 巩固（O(n²) 判重 + 溯源关联 + 归档 UPDATE）按切片推进，runOnce() 只做有界
 *   的一片就返回，剩余工作让出事件循环后台续跑，受总预算约束——状态机本身在
 *   {@link module:@ryharness/evolve/sweeper}，本类只做调度与转发；
 * - 每轮都记账耗时与处理条目数（{@link EvolveService.metrics}）供服务端聚合。
 * @module @ryharness/evolve/service
 */

import type { EvolveLlm, PlaybookDelta, TurnTrajectory } from './llm.ts'
import { CURATOR_ENTRY_LIMIT, NEGATIVE_FEEDBACK_RE } from './llm.ts'
import type { EvolutionRoundMetrics, EvolveMetricsSnapshot, RoundKind } from './metrics.ts'
import { RoundRecorder } from './metrics.ts'
import { maxOverlap } from './relevance.ts'
import type { PlaybookSection } from './schema.ts'
import { AUTO_DEPRECATE_HARMFUL, CONVERT_HIT_THRESHOLD } from './schema.ts'
import type { EntryOrigin, EntryOriginInput, PlaybookEntry } from './store.ts'
import { EvolveStore } from './store.ts'
import type { ConsolidationResult, MemorySweep } from './sweeper.ts'
import { Sweeper } from './sweeper.ts'

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
/** 溯源关联：条目与记忆的最小词面重叠系数（同一件事才会被关联）。 */
const MEMORY_ORIGIN_MIN_OVERLAP = 0.3
/** 归因集合上限：会话数无界增长会让这张 map 变成慢泄漏。 */
const ATTRIBUTION_MAX_KEYS = 512

const SECTION_LABELS: Record<PlaybookSection, string> = {
  strategy: '策略',
  pitfall: '坑',
  preference: '偏好',
  tooling: '工具用法',
}
const SECTION_ORDER: PlaybookSection[] = ['strategy', 'pitfall', 'preference', 'tooling']

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
  /** 归档相位单片最多归档多少行记忆（整段 UPDATE 是 1.8s 级的主循环冻结源）。 */
  consolidationArchiveChunkRows: number
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
  consolidationArchiveChunkRows: 200,
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

export class EvolveService implements AgentEvolutionHooks {
  readonly store: EvolveStore
  private readonly llm: EvolveLlm | undefined
  private readonly log: (message: string) => void
  private readonly limits: EvolveLimits
  private readonly recorder: RoundRecorder
  /** 巩固状态机（分片推进 + 可恢复续跑）：构造后 attach 一次宿主依赖即可。 */
  private readonly sweeper = new Sweeper()
  /** 待处理的每轮轨迹（单 writer 串行消费；容量上限见 maxQueuedTurns）。 */
  private readonly tasks: TurnTask[] = []
  private draining: Promise<void> | undefined
  /** 因过载被丢弃的轮次计数（埋点与日志都看它）。 */
  private droppedTurns = 0
  /** 最近注入归因：`${conversationId}:${agentId}` → 注入集合（👍/👎 归因用）。 */
  private readonly attribution = new Map<string, { playbookEntryIds: string[]; reflectionIds: string[] }>()
  /**
   * 记忆侧接缝（{@link MemorySweep}）。只用来把 👍/👎 转发过去：强化时的清理与
   * 归档在 Sweeper 里，只有反馈需要在本类发（它跟着 recordFeedback 走）。
   */
  private memorySweep: MemorySweep | undefined
  private consolidationTimer: ReturnType<typeof setInterval> | undefined
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
    this.attachSweeper()
  }

  /**
   * 接上巩固状态机——本类与 {@link Sweeper} 之间**唯一**的接缝。
   *
   * 状态机（24 个游标字段 + 十几个 advance* 方法）整体在 sweeper.ts 里，它只向
   * 宿主要四样东西：手册存储、调度参数、日志、巩固埋点。于是这里的 runOnce /
   * runUntilIdle 都退化成转发，再加一个巩固阶段也不会把本类拖回上帝类。
   */
  attachSweeper(): void {
    this.sweeper.attach({
      store: this.store,
      limits: this.limits,
      log: (message) => {
        this.log(message)
      },
      recordConsolidation: (round) => {
        this.record({ kind: 'consolidate', ...round })
      },
    })
  }

  close(): void {
    this.closed = true
    this.stopConsolidation()
    this.sweeper.close()
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
      this.log(`@ryharness/evolve: turn queue overflow (${this.limits.maxQueuedTurns}), dropped oldest turn`)
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
    await this.sweeper.drain()
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
      this.log(`@ryharness/evolve: attribution failed: ${describe(error)}`)
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
      this.log(`@ryharness/evolve: turn pipeline aborted: ${describe(error)}`)
    }
  }

  /** Reflector 归因计数 + 教训验证（确定性，不烧 LLM，不重试）。返回处理条数。 */
  private attributeTurn(task: TurnTask): number {
    const { agentId, turn, relevantEntryIds } = task
    const failure = turnFailure(turn)
    // 纯基础设施故障轮（llmError 且无质量信号）对注入条目两个方向都不计数：
    // harmful 无因果（供应商挂了不证明条目有害），helpful 也无证据（本轮结果
    // 未知）。供应商连续故障若干轮由此不再累计出「假差评」。
    const harmfulTurn = failure.failed && !failure.infraFailure
    let processed = 0

    for (const entryId of relevantEntryIds) {
      if (harmfulTurn || !failure.failed) {
        this.store.addCounts(entryId, failure.failed ? { harmful: 1 } : { helpful: 1 })
        processed += 1
        if (harmfulTurn) this.maybeAutoDeprecate(entryId)
      }
    }

    // 基础设施故障轮同样不给教训记验证 hit：本轮没有「成功」可言，教训转正
    // （Voyager 式入库须过执行验证）不能建立在供应商故障轮上。
    if (!failure.failed) {
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

  /**
   * harmful 触顶后的自动废弃（带保守护栏）。
   *
   * 为什么护栏选「净证据仍非负（helpful ≥ harmful）就不自动废弃，留给 Curator」
   * 而不是废弃前再发一次 LLM 复核：本方法是确定性阶段（不烧 LLM、不重试），
   * 塞进 LLM 调用会破坏这一分层；而 Curator 本来每轮都看得到条目与得分，可
   * 显式 deprecate——「复核」由它承担。护栏针对的噪声源：归因是近似（👎 落在
   * 「最近一次注入集合」上，工具连错也未必是条目内容所致），纯计数触顶但净分
   * 非负说明证据相持，不该一票处决。llmError 轮在上游已不计 harmful，基础设施
   * 故障凑不满阈值；这道闸是给其余误归因留的。净分为负仍立即废弃（原有路径）。
   */
  private maybeAutoDeprecate(entryId: string): void {
    const entry = this.store.getEntry(entryId)
    if (entry === undefined || entry.status !== 'active') return
    if (entry.harmful < AUTO_DEPRECATE_HARMFUL) return
    if (entry.helpful >= entry.harmful) {
      this.log(
        `@ryharness/evolve: entry ${entryId} harmful>=${AUTO_DEPRECATE_HARMFUL} but net evidence non-negative (helpful=${entry.helpful}), deprecate deferred to Curator`,
      )
      return
    }
    this.store.setEntryStatus(entryId, 'deprecated')
    this.log(`@ryharness/evolve: entry ${entryId} auto-deprecated (harmful>=${AUTO_DEPRECATE_HARMFUL})`)
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
        this.log(`@ryharness/evolve: reflection failed: ${describe(error)}`)
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
      this.log(`@ryharness/evolve: curator failed: ${describe(error)}`)
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
   *
   * 同一个信号还会转发给记忆侧（{@link MemorySweep.recordFeedback}，未接线时跳过）：
   * 此前反馈只回灌 playbook，记忆零通路，于是 recall 是单向棘轮——一条错误记忆
   * 被注入过就只会随着每次召回越来越稳，用户点了 👎 也拉不回来。
   */
  recordFeedback(input: {
    agentId: string
    conversationId: string
    signal: 'thumb_up' | 'thumb_down'
    userText?: string
    assistantText?: string
    /** 来源消息 id：落进 feedback_events 供路由按 (messageId, signal) 去重。 */
    messageId?: string
  }): void {
    const startedAt = Date.now()
    const feedbackId = this.store.recordFeedback({
      agentId: input.agentId,
      conversationId: input.conversationId,
      turnIndex: -1,
      signal: input.signal,
      messageId: input.messageId,
    })
    let memoryHits = 0
    try {
      memoryHits = this.memorySweep?.recordFeedback?.({ agentId: input.agentId, signal: input.signal }) ?? 0
    } catch (error) {
      // 记忆侧失败不该吃掉整个反馈：playbook 的计数与溯源已经落库了。
      this.log(`@ryharness/evolve: memory feedback skipped: ${describe(error)}`)
    }
    const injected = this.attribution.get(`${input.conversationId}:${input.agentId}`)
    if (injected === undefined) {
      this.record({ kind: 'feedback', startedAt, processed: memoryHits, ok: true })
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
      this.record({
        kind: 'feedback',
        startedAt,
        processed: injected.playbookEntryIds.length + memoryHits,
        ok: true,
      })
      return
    }
    for (const entryId of injected.playbookEntryIds) {
      this.store.addCounts(entryId, { harmful: 1 })
      this.store.recordOrigins(entryId, origin())
      // 与轮次归因同一道护栏：纯计数触顶但净证据非负时不自动废弃。
      this.maybeAutoDeprecate(entryId)
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
    this.record({
      kind: 'feedback',
      startedAt,
      processed: injected.playbookEntryIds.length + memoryHits,
      ok: true,
    })
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
  //
  // 下面四个方法全是转发：状态机（游标、三个阶段、分片续跑、失败隔离）在
  // {@link Sweeper} 里。留在这里是为了 server 侧调用点与语义都不变。

  /** 挂载记忆清扫面（runOnce 的判重合并用）。 */
  attachMemorySweep(sweep: MemorySweep): void {
    this.memorySweep = sweep
    this.sweeper.attachMemorySweep(sweep)
  }

  /**
   * 巩固任务（幂等）：同步做有界的一片就返回，剩余切片让出事件循环后台续跑。
   * 三个阶段（判重合并 / 条目↔记忆溯源 / 记忆归档）与失败隔离都在 {@link Sweeper}
   * 里；本方法只做转发，调用方（server 的周期调度与手动触发）不受影响。
   *
   * @param now - 本轮的「现在」；测试可注入以固定归档门槛的判定时刻。
   */
  runOnce(now = Date.now()): ConsolidationResult {
    return this.sweeper.runOnce(now)
  }

  /**
   * 等待一轮巩固彻底跑完（含后台切片）。服务端手动触发 / 关闭路径用；
   * 周期调度走 runOnce() 的异步续跑，不需要等。返回值是**整轮跑完**后的口径
   * （runOnce 返回的只是第一片的快照）。
   */
  async runUntilIdle(now = Date.now()): Promise<ConsolidationResult> {
    return this.sweeper.runUntilIdle(now)
  }

  /** 最近一轮巩固的完整结果（含后台续跑后的最终计数）。 */
  lastConsolidationResult(): ConsolidationResult | undefined {
    return this.sweeper.lastResult()
  }

  /** 启动周期巩固（默认 6 小时）；返回停止函数。可关：不调用即可。 */
  startConsolidation(intervalMs = 6 * 3_600_000): () => void {
    this.stopConsolidation()
    this.consolidationTimer = setInterval(() => {
      if (this.closed) return
      try {
        this.runOnce()
      } catch (error) {
        this.log(`@ryharness/evolve: consolidate failed: ${describe(error)}`)
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

/**
 * 本轮是否失败，以及给 Reflexion 看的失败原因。
 *
 * `infraFailure`：失败**纯**由 llmError 构成（供应商 429/超时/断网一类基础设施
 * 故障，且无负反馈、无工具连错）。基础设施错误与条目内容有害是正交维度，归因
 * 计数要据此分流（见 {@link EvolveService.attributeTurn}）；负反馈/工具连错是
 * 真实质量信号，即使与 llmError 同轮出现也不算纯基础设施故障。
 */
function turnFailure(turn: EvolutionTurn): { failed: boolean; reason: string; infraFailure: boolean } {
  const toolErrors = turn.toolResults.filter((t) => {
    return t.isError
  }).length
  const negativeFeedback = NEGATIVE_FEEDBACK_RE.test(turn.userText)
  const failed = turn.llmError || toolErrors >= 2 || negativeFeedback
  const infraFailure = turn.llmError && !negativeFeedback && toolErrors < 2
  const reason = turn.llmError
    ? 'LLM 流以错误收尾'
    : negativeFeedback
      ? '用户表达负反馈'
      : `工具连续失败（${toolErrors} 次）`
  return { failed, reason, infraFailure }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
