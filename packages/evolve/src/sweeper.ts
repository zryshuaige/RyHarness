/**
 * 巩固状态机：可恢复的分片清扫（{@link Sweeper}）。
 *
 * 为什么单独成类：巩固是本包里唯一的**可恢复长任务**——判重是 O(n²)、溯源要回看
 * 整张记忆表、归档是两条整段 UPDATE，跑在服务进程的事件循环里。它必须按片推进、
 * 把剩余工作让出事件循环后台续跑、跨 runOnce() 记同一份游标。这些理由此前把
 * 十四个私有方法和 24 个可变字段压进了 EvolveService，把运行时钩子、反馈归因与
 * 一个状态机搅在一起。状态机的复杂度不该传染给调度它的那一层。
 *
 * 状态机的三个原语（{@link Sweeper.beginSweep} / {@link Sweeper.slice} /
 * {@link Sweeper.advance}）是公开的：每个阶段能单独单测，不必构造整轮。
 * {@link Sweeper.runOnce} 只是它们加一次到期清理的组合。
 *
 * 对外只暴露四个动作（runOnce / runUntilIdle / lastResult / drain），其余是游标
 * 细节。宿主（EvolveService）通过 {@link SweepHost} 提供四项依赖：手册存储、
 * 调度参数、日志与埋点——状态机不反向持有服务。
 * @module @ryharness/evolve/sweeper
 */

import { textOverlap } from './relevance.ts'
import type { EvolveStore, PlaybookEntry } from './store.ts'

/** 巩固周期内的反思有效期（30 天）。 */
const REFLECTION_TTL_MS = 30 * 86_400_000
/** 巩固：长期零访问记忆的归档门槛（天）。 */
const DORMANT_ARCHIVE_DAYS = 90
/** 巩固：陈旧软删链的归档保留期（天）。 */
const SUPERSEDED_RETENTION_DAYS = 180
/** 判重合并的余弦阈值（归一化向量，点积即余弦）。 */
const MERGE_COSINE_THRESHOLD = 0.95
/** 溯源关联：单条记忆最多被引用的条目数上限。 */
const MEMORY_ORIGIN_MAX_REFS = 3
/** 溯源关联：每个空间最多回看多少条手册条目（手册前排的才有解释价值）。 */
const ORIGIN_ENTRY_SCAN = 40

/**
 * 记忆巩固需要的最小存储面（由 @ryharness/memory 的 MemoryStore 满足）。
 */
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
  /**
   * 长期零访问记忆 → inactive（不物理删除）。返回归档条数。
   *
   * `limit` 是**必须透传**的分片参数：给出时只归档至多 limit 行（调用方反复
   * 调用到返回数小于 limit 为止）。整段 UPDATE 在服务进程的事件循环里能把主
   * 循环冻住 1.8s；漏传 limit 不会算错行数，但那一段又会变回一次性阻塞。
   */
  archiveDormant(dormantAfterMs: number, now: number, limit?: number): number
  /** 陈旧软删链（保留当前有效版本的直接前身）→ inactive。返回归档条数。`limit` 语义同上。 */
  archiveColdSuperseded(maxAgeMs: number, now: number, limit?: number): number
  /**
   * 把用户反馈回灌到该 agent 最近一轮注入的记忆上（记忆侧的反向信号通路）。
   *
   * 可选：没接线的宿主（单跑进化、或记忆未启用）返回 undefined 即可，行为与接上
   * 之前完全一致——反馈仍然照常进 playbook，只是记忆侧听不见。
   * @returns 实际记上信号的记忆条数。
   */
  recordFeedback?(input: { agentId: string; signal: 'thumb_up' | 'thumb_down' }): number
}

/** 巩固需要的调度与限流参数（{@link EvolveLimits} 的三个子集，宿主给全量）。 */
export interface SweepLimits {
  /** 巩固单切片墙钟预算（ms）：超过就让出事件循环。 */
  consolidationSliceMs: number
  /** 巩固单切片最多做多少次向量/文本比较（先到者为准）。 */
  consolidationSliceUnits: number
  /** 一轮巩固的总预算（ms，含后台续跑）：超时丢弃剩余工作，下轮再续。 */
  consolidationBudgetMs: number
  /** 归档相位单片最多归档多少行记忆（整段 UPDATE 是 1.8s 级的主循环冻结源）。 */
  consolidationArchiveChunkRows: number
  /** 溯源关联时，每个条目回看的记忆行数上限。 */
  memoryOriginScan: number
  /** 溯源关联的最小词面重叠系数。 */
  memoryOriginMinOverlap: number
}

/** 巩固埋点的一轮：只报「占住事件循环多久、做了多少工作单位、成没成」。 */
export interface SweepRoundRecord {
  startedAt: number
  /** 真正占住事件循环的毫秒（不含让出事件循环的墙钟）。 */
  durationMs: number
  /** 工作单位数（一次判重比较 / 一次溯源扫描 / 一次归档片）。 */
  processed: number
  ok: boolean
  error?: unknown
}

/** 巩固状态机向宿主要的东西（由 EvolveService 组装后一次 attach 进来）。 */
export interface SweepHost {
  /** 手册存储：溯源写入与到期反思清理。 */
  readonly store: EvolveStore
  readonly limits: SweepLimits
  log(message: string): void
  /** 巩固耗时埋点（与每轮进化/反馈共用同一个记账器）。 */
  recordConsolidation(round: SweepRoundRecord): void
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

/** 记忆清扫面返回的一行。 */
export interface SweepRow {
  id: string
  content: string
  embedding: Float32Array | null
  accessCount: number
  updatedAt: number
}

export type SweepPhase = 'dedupe' | 'origins' | 'archive'

/** 归档相位的两段：长期零访问 → 陈旧软删链。 */
export type ArchiveStage = 'dormant' | 'superseded'

/** 巩固的游标状态（跨 runOnce 续跑，让出事件循环而不是重头再来）。 */
export interface SweepState {
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
  /** 归档相位走到哪一段了（每段内部按片推进）。 */
  archiveStage: ArchiveStage
  completed: boolean
  timedOut: boolean
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
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

export class Sweeper {
  private host: SweepHost | undefined
  private memory: MemorySweep | undefined
  private closed = false
  /** 在跑的巩固切片状态（跨 runOnce 调用续跑）。 */
  private sweep: SweepState | undefined
  private sweepDrain: Promise<void> | undefined
  /** 本轮巩固的状态（runUntilIdle 要在跑完后拿它算完整口径）。 */
  private sweepRound: SweepState | undefined
  /** 最近一轮巩固的完整结果（后台续跑结束后刷新）。 */
  private lastConsolidation: ConsolidationResult | undefined

  /**
   * 接宿主（EvolveService 只调这一次）。单独一步而不是构造函数参数：宿主自己
   * 也要先把 store 与限流组装出来，构造期就互相持有会让两边的初始化顺序变成隐式契约。
   */
  attach(host: SweepHost): void {
    this.host = host
  }

  /** 挂载记忆清扫面（runOnce 的判重合并与归档用）。 */
  attachMemorySweep(sweep: MemorySweep): void {
    this.memory = sweep
  }

  /** 停机：不再续跑剩余切片，正在跑的那片跑到下一个让出点自然收尾。 */
  close(): void {
    this.closed = true
    this.sweep = undefined
  }

  /**
   * 等后台续跑排空（EvolveService.flush 与测试用）。循环而不是单次 await：
   * 一轮续跑结束时可能已经把下一轮的续跑挂上来了。
   */
  async drain(): Promise<void> {
    while (this.sweepDrain !== undefined) {
      await this.sweepDrain
    }
  }

  /** 最近一轮巩固的完整结果（含后台续跑后的最终计数）。 */
  lastResult(): ConsolidationResult | undefined {
    return this.lastConsolidation
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
   * 整个 server 冻住（实测可到数十秒）。这里只同步做**有界的一片**
   * （默认 ≤12ms 或 ≤2000 次比较，先到者为准），剩下的切片让出事件循环后台
   * 续跑，并受整轮预算约束；单个空间出错只跳过该空间。归档（4）内部还按
   * {@link SweepLimits.consolidationArchiveChunkRows} 行一片推进——它是两条
   * UPDATE，不切片的话单次就能冻住主循环 1.8s。
   */
  runOnce(now = Date.now()): ConsolidationResult {
    const host = this.requireHost()
    const startedAt = Date.now()
    const expired = host.store.expireReflections(REFLECTION_TTL_MS, now)
    const state = this.sweep ?? this.beginSweep(now)
    const slice = this.slice(state, host.limits.consolidationSliceUnits, host.limits.consolidationSliceMs)
    this.sweepRound = state
    this.sweep = state.completed || state.timedOut ? undefined : state
    this.resumeSweep(state)
    const result = this.consolidationResult(state, expired, slice.blockedMs)
    host.recordConsolidation({ startedAt, durationMs: slice.blockedMs, processed: slice.units, ok: true })
    if (expired > 0 || result.mergedMemories > 0 || result.dormant > 0 || result.linkedOrigins > 0) {
      host.log(
        `@ryharness/evolve: consolidate expired=${expired} merged=${result.mergedMemories} dormant=${result.dormant} ` +
          `origins=${result.linkedOrigins} archived=${result.archivedDormant + result.archivedSuperseded} ` +
          `(dormant=${result.archivedDormant} superseded=${result.archivedSuperseded}) scanned=${result.scannedMemories} ` +
          `blocked=${slice.blockedMs}ms pending=${result.pending}`,
      )
    }
    return result
  }

  /**
   * 等待一轮巩固彻底跑完（含后台切片）。服务端手动触发 / 关闭路径用；
   * 周期调度走 {@link runOnce} 的异步续跑，不需要等。返回值是**整轮跑完**后的口径
   * （runOnce 返回的只是第一片的快照）。
   */
  async runUntilIdle(now = Date.now()): Promise<ConsolidationResult> {
    const result = this.runOnce(now)
    await this.drain()
    const state = this.sweepRound
    if (state === undefined) return result
    const final = this.consolidationResult(state, result.expiredReflections, result.durationMs)
    this.lastConsolidation = final
    return final
  }

  /** 从零开一轮游标。公开是为了让单测能在不跑整轮的前提下直接驱动某个阶段。 */
  beginSweep(now: number): SweepState {
    return {
      now,
      deadline: Date.now() + this.requireHost().limits.consolidationBudgetMs,
      phase: 'dedupe',
      spaces: [],
      spaceIndex: 0,
      rows: [],
      loaded: false,
      scannedSpace: false,
      rowIndex: 0,
      colIndex: 1,
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
      archiveStage: 'dormant',
      completed: false,
      timedOut: false,
    }
  }

  /** 跑一片（同步、有界）。返回本次消耗的比较次数与占用事件循环的毫秒数。 */
  slice(state: SweepState, maxUnits: number, maxMs: number): { units: number; blockedMs: number } {
    const startedAt = Date.now()
    let units = 0
    while (!state.completed && units < maxUnits) {
      if (Date.now() - startedAt >= maxMs) break
      units += this.advance(state)
    }
    return { units, blockedMs: Date.now() - startedAt }
  }

  /** 一步推进（一个游标单位）。返回本次消耗的单位数（阶段切换按 1 计）。 */
  advance(state: SweepState): number {
    if (state.phase === 'dedupe') return this.advanceDedupe(state)
    if (state.phase === 'origins') return this.advanceOrigins(state)
    return this.advanceArchive(state)
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
        this.log(`@ryharness/evolve: supersede failed on ${b.id}: ${describe(error)}`)
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
    const limits = this.requireHost().limits
    if (!state.loaded) {
      if (state.spaces.length === 0 || state.spaceIndex >= state.spaces.length) {
        state.phase = 'archive'
        return 1
      }
      const space = state.spaces[state.spaceIndex] as string
      state.entries = this.requireHost().store.listActiveForCompile(space, ORIGIN_ENTRY_SCAN)
      state.rows = this.memory === undefined ? [] : this.loadRows(state, space).slice(0, limits.memoryOriginScan)
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
    if (textOverlap(entry.content, row.content) >= limits.memoryOriginMinOverlap) {
      state.matches.push({ refId: row.id, detail: row.content.slice(0, 60) })
    }
    return 1
  }

  private finishOriginEntry(state: SweepState): number {
    const entry = state.entries[state.entryIndex] as PlaybookEntry
    const top = state.matches.slice(0, MEMORY_ORIGIN_MAX_REFS)
    try {
      state.origins += this.requireHost().store.recordOrigins(
        entry.id,
        top.map((match) => {
          return { kind: 'memory' as const, refId: match.refId, detail: match.detail }
        }),
      )
    } catch (error) {
      state.errors += 1
      this.log(`@ryharness/evolve: recordOrigins failed on ${entry.id}: ${describe(error)}`)
    }
    state.entryIndex += 1
    state.memIndex = 0
    state.matches = []
    return 1
  }

  /**
   * 归档相位：一行行搬，搬完一段就换下一段。
   *
   * 归档是两条 UPDATE（dormant + 陈旧软删链），不切片就是一次 1.8s 级的同步
   * 阻塞，把整个 server 冻住——而它就在服务进程的事件循环里。每片只归档
   * `consolidationArchiveChunkRows` 行，片与片之间由后台续跑让出事件循环；
   * 一段归档返回数小于片长即视为搬空，转下一段，两段搬完整轮结束。
   * 语义（哪些行算陈旧）与整段 UPDATE 完全一致，只是拆开执行。
   */
  private advanceArchive(state: SweepState): number {
    const limit = Math.max(1, this.requireHost().limits.consolidationArchiveChunkRows)
    if (state.archiveStage === 'dormant') {
      const archived = this.archiveCall(state, () => {
        return this.memory?.archiveDormant(DORMANT_ARCHIVE_DAYS * 86_400_000, state.now, limit) ?? 0
      })
      state.archivedDormant += archived
      if (archived < limit) state.archiveStage = 'superseded'
      return 1
    }
    const archived = this.archiveCall(state, () => {
      return this.memory?.archiveColdSuperseded(SUPERSEDED_RETENTION_DAYS * 86_400_000, state.now, limit) ?? 0
    })
    state.archivedSuperseded += archived
    if (archived < limit) state.completed = true
    return 1
  }

  /** 归档调用的失败隔离：一段抛错只丢这一段（并跳过它），不带走整轮。 */
  private archiveCall(state: SweepState, run: () => number): number {
    if (this.memory === undefined) return 0
    try {
      return run()
    } catch (error) {
      state.errors += 1
      this.log(`@ryharness/evolve: archive failed: ${describe(error)}`)
      return 0
    }
  }

  /** 列出待巩固的空间；抛错按空集处理（一个空间挂掉不该废掉整轮）。 */
  private loadSpaces(state: SweepState): string[] {
    try {
      return this.memory?.listSpaces() ?? []
    } catch (error) {
      state.errors += 1
      this.log(`@ryharness/evolve: listSpaces failed: ${describe(error)}`)
      return []
    }
  }

  private loadRows(state: SweepState, space: string): SweepRow[] {
    try {
      return this.memory?.listActiveEmbeddings(space) ?? []
    } catch (error) {
      state.errors += 1
      this.log(`@ryharness/evolve: listActiveEmbeddings failed (space=${space}): ${describe(error)}`)
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
    const host = this.requireHost()
    const startedAt = Date.now()
    let units = 0
    let blockedMs = 0
    let failure: unknown
    try {
      while (!state.completed && !this.closed) {
        if (Date.now() >= state.deadline) {
          state.timedOut = true
          host.log(
            `@ryharness/evolve: consolidation exceeded ${host.limits.consolidationBudgetMs}ms budget, ` +
              'remaining work dropped and retried next round',
          )
          break
        }
        await yieldToEventLoop()
        const slice = this.slice(state, host.limits.consolidationSliceUnits, host.limits.consolidationSliceMs)
        units += slice.units
        blockedMs += slice.blockedMs
      }
    } catch (error) {
      failure = error
      state.errors += 1
      host.log(`@ryharness/evolve: consolidation aborted: ${describe(error)}`)
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
    host.recordConsolidation({
      startedAt,
      durationMs: blockedMs,
      processed: units,
      ok: failure === undefined,
      ...(failure === undefined ? {} : { error: failure }),
    })
    host.log(
      `@ryharness/evolve: consolidate tail units=${units} blocked=${blockedMs}ms completed=${state.completed} ` +
        `timedOut=${state.timedOut} errors=${state.errors}`,
    )
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

  private requireHost(): SweepHost {
    if (this.host === undefined) throw new Error('Sweeper 尚未 attach 宿主（EvolveService.attachSweeper）')
    return this.host
  }

  private log(message: string): void {
    this.requireHost().log(message)
  }
}
