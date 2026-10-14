/**
 * 运行时可观测性：请求计时与轮次耗时的环形缓冲（零依赖）。
 *
 * 只记计量数字与会话/轮次标识，**不记消息正文、prompt 与凭据**——这份快照会经
 * GET /api/telemetry 原样发给渲染层。容量固定，写满即丢最旧的（环形缓冲），
 * 长时间运行不会把内存吃光。
 * @module @ryagent/server/telemetry
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** 轮次结局。 */
export type TurnStatus = 'ok' | 'error' | 'aborted'

/** 一轮 turn 的耗时画像。 */
export interface TurnTiming {
  conversationId: string
  kind: 'direct' | 'group'
  turnIndex: number
  /** 首 token 延迟：本轮开始到第一个文本增量的毫秒数；全程无文本时缺省。 */
  firstTokenMs?: number
  /** 本轮总耗时（毫秒）。 */
  totalMs: number
  /** 记忆召回累计耗时（毫秒）。 */
  memoryRecallMs: number
  /** 注入本轮的记忆条数。 */
  memoryItems: number
  status: TurnStatus
  /** 轮次结束时刻（Unix 毫秒）。 */
  finishedAt: number
}

/** 一次 HTTP 请求的计时：只有方法、路径（不含查询串）、状态码与耗时。 */
export interface RequestTiming {
  method: string
  path: string
  status: number
  durationMs: number
  /** 响应完成时刻（Unix 毫秒）。 */
  at: number
}

/** GET /api/telemetry 的返回体。 */
export interface TelemetrySnapshot {
  /** 最近的轮次，按结束时间倒序。 */
  turns: TurnTiming[]
  /** 最近的请求，按完成时间倒序。 */
  requests: RequestTiming[]
  /** 环形缓冲容量（两类各一份）。 */
  capacity: number
}

/** 环形缓冲默认容量。 */
export const DEFAULT_TELEMETRY_CAPACITY = 200
/** GET /api/telemetry 默认返回的条数。 */
export const DEFAULT_TELEMETRY_LIMIT = 50

/**
 * 单轮累计器：一轮 turn 内的首 token 时刻与记忆召回计量。
 *
 * `firstTokenMs` 由调用方在收到第一个文本增量时打点（服务端看到的就是用户
 * 感知的"开始出字"时刻），召回计量由套了计时的记忆钩子喂进来。
 */
export class TurnRecorder {
  private firstTokenAt: number | undefined
  private memoryRecallMs = 0
  private memoryItems = 0

  constructor(
    readonly conversationId: string,
    readonly kind: 'direct' | 'group',
    readonly turnIndex: number,
    private readonly startedAt: number,
  ) {}

  /** 首个文本增量时打点（幂等：只认第一次）。 */
  markFirstToken(now: number = Date.now()): void {
    this.firstTokenAt ??= now
  }

  /** 记一次记忆召回：耗时与注入条数（本轮多次召回累加）。 */
  addRecall(durationMs: number, items: number): void {
    this.memoryRecallMs += durationMs
    this.memoryItems += items
  }

  /** 出账：把累计的计量固化成一条快照。 */
  finish(status: TurnStatus, now: number = Date.now()): TurnTiming {
    return {
      conversationId: this.conversationId,
      kind: this.kind,
      turnIndex: this.turnIndex,
      ...(this.firstTokenAt === undefined ? {} : { firstTokenMs: this.firstTokenAt - this.startedAt }),
      totalMs: now - this.startedAt,
      memoryRecallMs: this.memoryRecallMs,
      memoryItems: this.memoryItems,
      status,
      finishedAt: now,
    }
  }
}

/**
 * 遥测容器：两类环形缓冲 + 在途轮次登记。
 *
 * 记忆钩子的 recall 契约只有 (agentId, inputText)，拿不到会话 id。组合根在一轮
 * 对话开始时用 {@link Telemetry.scopedTurn} 把会话 id 放进异步上下文，于是钩子
 * 里的计量能落到**正确的**那一轮；没有上下文时退回"最近启动的那一轮"（单机本地
 * 应用同时只有个位数在途轮次）。
 */
export class Telemetry {
  private readonly turnRing: TurnTiming[] = []
  private readonly requestRing: RequestTiming[] = []
  /** 在途轮次，按启动顺序插入（Map 保序，最后一项即最近启动的那一轮）。 */
  private readonly inflight = new Map<string, TurnRecorder>()
  /** 当前异步链所属的会话 id（由 scopedTurn 建立）。 */
  private readonly scope = new AsyncLocalStorage<string>()

  constructor(readonly capacity: number = DEFAULT_TELEMETRY_CAPACITY) {}

  /**
   * 在 conversationId 的异步上下文里跑 fn：期间（以及它 await 出来的所有续链）
   * {@link Telemetry.recallTurn} 都能指名到这一轮。
   *
   * 用 AsyncLocalStorage 而不是把 conversationId 加进 AgentMemoryHooks.recall 的
   * 参数：钩子接口被 @ryagent/agent / @ryagent/session 两个包共用，改签名要连带
   * 动它们的实现与测试，而归属问题只是本进程的记账问题。
   */
  scopedTurn<T>(conversationId: string, fn: () => T): T {
    return this.scope.run(conversationId, fn)
  }

  /** 开一轮：登记在途并返回累计器。 */
  beginTurn(conversationId: string, kind: 'direct' | 'group', turnIndex: number): TurnRecorder {
    const recorder = new TurnRecorder(conversationId, kind, turnIndex, Date.now())
    this.inflight.set(conversationId, recorder)
    return recorder
  }

  /** 收一轮：出账并写进环形缓冲（会话 id 已被新一轮顶掉时不再写）。 */
  endTurn(recorder: TurnRecorder, status: TurnStatus): TurnTiming {
    if (this.inflight.get(recorder.conversationId) === recorder) this.inflight.delete(recorder.conversationId)
    const timing = recorder.finish(status)
    this.push(this.turnRing, timing)
    return timing
  }

  /** 最近启动且仍在跑的那一轮；没有在途轮次返回 undefined。 */
  currentTurn(): TurnRecorder | undefined {
    let latest: TurnRecorder | undefined
    for (const recorder of this.inflight.values()) latest = recorder
    return latest
  }

  /**
   * 计量该记到哪一轮：优先取当前异步上下文里指名的那一轮（多会话并发时不会记串），
   * 上下文缺席时退回 {@link Telemetry.currentTurn}。
   */
  recallTurn(): TurnRecorder | undefined {
    const conversationId = this.scope.getStore()
    if (conversationId === undefined) return this.currentTurn()
    return this.inflight.get(conversationId)
  }

  /** 记一次 HTTP 请求（响应结束时调用）。 */
  recordRequest(entry: RequestTiming): void {
    this.push(this.requestRing, entry)
  }

  /** 快照：最近 limit 条，按时间倒序（limit 省略时用默认条数）。 */
  getSnapshot(limit: number = DEFAULT_TELEMETRY_LIMIT): TelemetrySnapshot {
    const size = Math.max(0, Math.min(Math.trunc(limit), this.capacity))
    // slice(-0) 等于 slice(0)（会回全部），所以 0 条单独短路。
    return {
      turns: size === 0 ? [] : this.turnRing.slice(-size).reverse(),
      requests: size === 0 ? [] : this.requestRing.slice(-size).reverse(),
      capacity: this.capacity,
    }
  }

  /** 写满容量就丢最旧的一条。 */
  private push<T>(ring: T[], value: T): void {
    ring.push(value)
    while (ring.length > this.capacity) ring.shift()
  }
}
