/**
 * 进化子系统的耗时埋点：每轮进化/巩固记一次「耗时 + 处理条目数 + 成败」，
 * 供服务端聚合成面板指标。
 *
 * 刻意不引外部依赖、不落盘：环形缓冲留在内存里（默认留最近 100 轮），
 * 历史趋势由拿到数据的调用方自己聚合。埋点自身零分配压力（每轮一条小对象）。
 * @module @ryagent/evolve/metrics
 */

/** 埋点种类。 */
export type RoundKind = 'turn' | 'feedback' | 'consolidate'

/** 一轮工作的记账。 */
export interface EvolutionRoundMetrics {
  kind: RoundKind
  /** 开始时刻（Date.now 毫秒）。 */
  startedAt: number
  /** 端到端耗时（毫秒）。 */
  durationMs: number
  /** 处理条目数：轮=计分/写库条目，consolidate=扫描的向量与记忆行。 */
  processed: number
  ok: boolean
  error?: string
}

/** 累计口径（按种类分列，服务端直接拿去渲染）。 */
export interface RoundTotals {
  rounds: number
  failures: number
  durationMs: number
  processed: number
}

/** metrics() 的返回结构。 */
export interface EvolveMetricsSnapshot {
  last?: EvolutionRoundMetrics
  /** 最近若干轮（新的在前）。 */
  rounds: EvolutionRoundMetrics[]
  totals: RoundTotals
  byKind: Record<RoundKind, RoundTotals>
}

function emptyTotals(): RoundTotals {
  return { rounds: 0, failures: 0, durationMs: 0, processed: 0 }
}

/** 环形缓冲记账器。 */
export class RoundRecorder {
  private readonly buffer: EvolutionRoundMetrics[] = []
  private readonly byKind: Record<RoundKind, RoundTotals> = {
    turn: emptyTotals(),
    feedback: emptyTotals(),
    consolidate: emptyTotals(),
  }
  private last: EvolutionRoundMetrics | undefined

  constructor(
    private readonly limit = 100,
    private readonly onRound?: (round: EvolutionRoundMetrics) => void,
  ) {}

  /** 记一轮并返回该轮记录（回调抛错不影响记账与调用方）。 */
  record(input: {
    kind: RoundKind
    startedAt: number
    durationMs: number
    processed: number
    ok: boolean
    error?: string
  }): EvolutionRoundMetrics {
    const round: EvolutionRoundMetrics = {
      kind: input.kind,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      processed: input.processed,
      ok: input.ok,
      ...(input.error === undefined ? {} : { error: input.error }),
    }
    this.last = round
    this.buffer.push(round)
    if (this.buffer.length > this.limit) this.buffer.shift()
    const totals = this.byKind[input.kind]
    totals.rounds += 1
    totals.durationMs += input.durationMs
    totals.processed += input.processed
    if (!input.ok) totals.failures += 1
    if (this.onRound !== undefined) {
      try {
        this.onRound(round)
      } catch {
        /* 埋点回调不该把进化管线带下去 */
      }
    }
    return round
  }

  /** 快照；`limit` 截断最近轮次（新的在前）。 */
  snapshot(limit = this.limit): EvolveMetricsSnapshot {
    const rounds = this.buffer.slice(-limit).reverse()
    const byKind = {
      turn: { ...this.byKind.turn },
      feedback: { ...this.byKind.feedback },
      consolidate: { ...this.byKind.consolidate },
    }
    const totals = rounds.reduce<RoundTotals>((acc, round) => {
      acc.rounds += 1
      acc.durationMs += round.durationMs
      acc.processed += round.processed
      if (!round.ok) acc.failures += 1
      return acc
    }, emptyTotals())
    return { ...(this.last === undefined ? {} : { last: this.last }), rounds, totals, byKind }
  }
}
