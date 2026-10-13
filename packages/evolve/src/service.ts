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
 * @module @ryagent/evolve/service
 */

import type { EvolveLlm, TurnTrajectory } from './llm.ts'
import { CURATOR_ENTRY_LIMIT, NEGATIVE_FEEDBACK_RE } from './llm.ts'
import { maxOverlap } from './relevance.ts'
import type { PlaybookSection } from './schema.ts'
import { AUTO_DEPRECATE_HARMFUL, CONVERT_HIT_THRESHOLD } from './schema.ts'
import type { PlaybookEntry } from './store.ts'
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

/** 供 AgentLoop 接入的薄接口。 */
export interface AgentEvolutionHooks {
  compile(agentId: string, inputText?: string): Promise<CompiledEvolution | undefined>
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

const SECTION_LABELS: Record<PlaybookSection, string> = {
  strategy: '策略',
  pitfall: '坑',
  preference: '偏好',
  tooling: '工具用法',
}
const SECTION_ORDER: PlaybookSection[] = ['strategy', 'pitfall', 'preference', 'tooling']

/** 巩固周期内的反思有效期（30 天）。 */
const REFLECTION_TTL_MS = 30 * 86_400_000

export interface EvolveServiceOptions {
  dbPath: string
  llm?: EvolveLlm
  logger?: (message: string) => void
}

/** 记忆巩固需要的最小存储面（由 @ryagent/memory 的 MemoryStore 满足）。 */
export interface MemorySweep {
  listSpaces(): string[]
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
  private queue: Promise<void> = Promise.resolve()
  /** 最近注入归因：`${conversationId}:${agentId}` → 注入集合（👍/👎 归因用）。 */
  private readonly attribution = new Map<string, { playbookEntryIds: string[]; reflectionIds: string[] }>()
  private consolidationTimer: ReturnType<typeof setInterval> | undefined
  private memory: MemorySweep | undefined

  constructor(options: EvolveServiceOptions) {
    this.store = new EvolveStore(options.dbPath)
    this.llm = options.llm
    this.log =
      options.logger ??
      ((message) => {
        console.log(message)
      })
  }

  close(): void {
    this.stopConsolidation()
    this.store.close()
  }

  // ---- 注入（组装 prompt 前）----

  /**
   * 编译该 agent 的进化上下文：active playbook 条目（net 排序 top-N、按
   * section 分组）+ 与本轮输入相关的 pending 教训（top-N）。无内容返回
   * undefined。
   * @param agentId - agent id。
   * @param inputText - 本轮用户输入；缺省时退回"最近 N 条教训"。AgentLoop
   *   只传 agentId，由 SessionCoordinator 的绑定钩子把当前输入文本注入进来。
   */
  async compile(agentId: string, inputText?: string): Promise<CompiledEvolution | undefined> {
    const entries = this.store
      .listActiveForCompile(agentId)
      .sort((a, b) => {
        return b.helpful - b.harmful - (a.helpful - a.harmful)
      })
      .slice(0, COMPILE_TOP_N)
    const reflections =
      inputText === undefined
        ? this.store.listPendingReflections(agentId, REFLECTION_INJECT_MAX)
        : this.store.searchPendingReflections(agentId, inputText, REFLECTION_INJECT_MAX)

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
    const relevant = this.relevantEntryIds(agentId, turn)
    this.attribution.set(`${conversationId}:${agentId}`, {
      playbookEntryIds: relevant,
      reflectionIds: [...turn.injectedReflectionIds],
    })
    if (this.llm === undefined && turn.injectedPlaybookEntryIds.length === 0) return
    this.queue = this.queue.then(async () => {
      await this.runTurnWithRetry(agentId, agentName, conversationId, turn, relevant)
    })
  }

  /** 注入条目里与本轮输入真正相关的那些（无文本可判时全部保留）。 */
  private relevantEntryIds(agentId: string, turn: EvolutionTurn): string[] {
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

  /** 测试用：等队列排空。 */
  async flush(): Promise<void> {
    await this.queue
  }

  private async runTurnWithRetry(
    agentId: string,
    agentName: string,
    conversationId: string,
    turn: EvolutionTurn,
    relevantEntryIds: readonly string[],
  ): Promise<void> {
    try {
      await this.runTurn(agentId, agentName, conversationId, turn, relevantEntryIds)
    } catch (error) {
      this.log(
        `@ryagent/evolve: turn pipeline failed, retrying once: ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        await this.runTurn(agentId, agentName, conversationId, turn, relevantEntryIds)
      } catch (retryError) {
        this.log(
          `@ryagent/evolve: turn pipeline gave up: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        )
      }
    }
  }

  private async runTurn(
    agentId: string,
    agentName: string,
    conversationId: string,
    turn: EvolutionTurn,
    relevantEntryIds: readonly string[],
  ): Promise<void> {
    const negativeFeedback = NEGATIVE_FEEDBACK_RE.test(turn.userText)
    const toolErrors = turn.toolResults.filter((t) => {
      return t.isError
    }).length
    const failed = turn.llmError || toolErrors >= 2 || negativeFeedback

    // ---- Reflector：注入归因计数（确定性，不烧 LLM）----
    for (const entryId of relevantEntryIds) {
      this.store.addCounts(entryId, failed ? { harmful: 1 } : { helpful: 1 })
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

    // ---- 教训验证：注入后本轮成功 → hitCount+1，≥2 转正进 playbook ----
    if (!failed) {
      for (const reflectionId of turn.injectedReflectionIds) {
        const reflection = this.store.getReflection(reflectionId)
        if (reflection === undefined || reflection.status !== 'pending') continue
        this.store.bumpReflectionHit(reflectionId)
        const updated = this.store.getReflection(reflectionId)!
        if (updated.hitCount >= CONVERT_HIT_THRESHOLD) {
          this.store.insertEntry({
            agentId,
            section: 'pitfall',
            content: updated.lesson,
            source: 'reflection',
          })
          this.store.setReflectionStatus(reflectionId, 'converted')
        }
      }
    }

    // ---- Reflexion：失败轨迹 → 教训 ----
    if (failed && this.llm !== undefined) {
      const reason = turn.llmError
        ? 'LLM 流以错误收尾'
        : negativeFeedback
          ? '用户表达负反馈'
          : `工具连续失败（${toolErrors} 次）`
      const lesson = await this.llm.reflect({ agentName, trajectory: turn, reason })
      this.store.insertReflection({
        agentId,
        lesson,
        contextDigest: `${turn.userText.slice(0, 80)} → ${turn.assistantText.slice(0, 80)}`,
        sourceConversationId: conversationId,
      })
    }

    // ---- Curator：playbook 增量 delta ----
    if (this.llm !== undefined) {
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
      for (const delta of deltas) {
        switch (delta.op) {
          case 'add':
            if (
              !this.store.hasDuplicate(agentId, delta.section, delta.content) &&
              !this.store.hasNearDuplicate(agentId, delta.section, delta.content)
            ) {
              this.store.insertEntry({ agentId, section: delta.section, content: delta.content, source: 'curator' })
            }
            break
          case 'update': {
            const existing = this.store.getEntry(delta.entryId)
            if (existing === undefined || existing.agentId !== agentId || existing.status !== 'active') break
            // 改写后的内容不得与另一条既有条目近似重复（否则手册自我复制）。
            if (this.store.hasNearDuplicateExcept(agentId, existing.section, delta.content, existing.id)) break
            this.store.updateEntryContent(delta.entryId, delta.content)
            break
          }
          case 'deprecate': {
            const existing = this.store.getEntry(delta.entryId)
            if (existing !== undefined && existing.agentId === agentId && existing.status === 'active') {
              this.store.setEntryStatus(delta.entryId, 'deprecated')
            }
            break
          }
        }
      }
    }
  }

  // ---- 用户反馈闭环 ----

  /**
   * 👎：即时反思入库 + 归因条目 harmful+1；👍：归因条目 helpful+1。
   * 归因 = 该 agent 在该会话最近一次注入的集合（串行队列下的近似）。
   */
  recordFeedback(input: {
    agentId: string
    conversationId: string
    signal: 'thumb_up' | 'thumb_down'
    userText?: string
    assistantText?: string
  }): void {
    this.store.recordFeedback({
      agentId: input.agentId,
      conversationId: input.conversationId,
      turnIndex: -1,
      signal: input.signal,
    })
    const injected = this.attribution.get(`${input.conversationId}:${input.agentId}`)
    if (injected === undefined) return
    if (input.signal === 'thumb_up') {
      for (const entryId of injected.playbookEntryIds) this.store.addCounts(entryId, { helpful: 1 })
      return
    }
    for (const entryId of injected.playbookEntryIds) {
      this.store.addCounts(entryId, { harmful: 1 })
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
      this.queue = this.queue.then(async () => {
        try {
          const lesson = await this.llm!.reflect({ agentName: '', trajectory, reason: '用户点了差评' })
          this.store.insertReflection({ agentId: input.agentId, lesson, sourceConversationId: input.conversationId })
        } catch (error) {
          this.log(
            `@ryagent/evolve: feedback reflection failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    }
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
   * 1. 到期反思清理（>30 天未转正 → expired）；
   * 2. 重复记忆合并：同空间 embedding 余弦 >0.95 的对 → supersede 旧条目
   *    （确定性阈值，不再烧 LLM——桌面规模下足够，LLM 判重留给未来）；
   * 3. 记忆归档（保守）：90 天零访问 → inactive；180 天以上的软删链中间版本
   *    → inactive。都不物理删除，只移出检索面（dormant 只统计日志等于让记忆
   *    库无界增长）。
   */
  runOnce(now = Date.now()): {
    expiredReflections: number
    mergedMemories: number
    dormant: number
    archivedDormant: number
    archivedSuperseded: number
  } {
    const expired = this.store.expireReflections(REFLECTION_TTL_MS, now)
    let merged = 0
    let dormant = 0
    let archivedDormant = 0
    let archivedSuperseded = 0
    if (this.memory !== undefined) {
      for (const space of this.memory.listSpaces()) {
        const rows = this.memory.listActiveEmbeddings(space)
        for (let i = 0; i < rows.length; i++) {
          const a = rows[i]!
          if (a.embedding === null) continue
          if (a.accessCount === 0 && now - a.updatedAt > DORMANT_ARCHIVE_DAYS * 86_400_000) dormant++
          for (let j = i + 1; j < rows.length; j++) {
            const b = rows[j]!
            if (b.embedding === null) continue
            if (cosine(a.embedding, b.embedding) > 0.95) {
              this.memory.supersede(b.id, 'superseded')
              merged++
            }
          }
        }
      }
      archivedDormant = this.memory.archiveDormant(DORMANT_ARCHIVE_DAYS * 86_400_000, now)
      archivedSuperseded = this.memory.archiveColdSuperseded(SUPERSEDED_RETENTION_DAYS * 86_400_000, now)
    }
    if (expired > 0 || merged > 0 || dormant > 0 || archivedDormant > 0 || archivedSuperseded > 0) {
      this.log(
        `@ryagent/evolve: consolidate expired=${expired} merged=${merged} dormant=${dormant} ` +
          `archived=${archivedDormant + archivedSuperseded} (dormant=${archivedDormant} superseded=${archivedSuperseded})`,
      )
    }
    return { expiredReflections: expired, mergedMemories: merged, dormant, archivedDormant, archivedSuperseded }
  }

  /** 启动周期巩固（默认 6 小时）；返回停止函数。可关：不调用即可。 */
  startConsolidation(intervalMs = 6 * 3_600_000): () => void {
    this.stopConsolidation()
    this.consolidationTimer = setInterval(() => {
      try {
        this.runOnce()
      } catch (error) {
        this.log(`@ryagent/evolve: consolidate failed: ${error instanceof Error ? error.message : String(error)}`)
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
