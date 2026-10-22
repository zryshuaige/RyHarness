/**
 * 巩固的分片执行（不冻结主循环）、超时预算、失败隔离与耗时埋点。
 *
 * 这组用例盯的是 P0「整个本地 server 被同步冻住」：判重是 O(n²)，跑在服务
 * 进程的事件循环里，一次性跑完会把 HTTP/WS 一起卡住。这里用「主循环在巩固
 * 期间仍能继续跑」作为可执行的不冻证据。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolveServiceOptions, MemorySweep } from '@ryharness/evolve'
import { EvolveService } from '@ryharness/evolve'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function service(options: Partial<EvolveServiceOptions> = {}): EvolveService {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-consolidate-'))
  dirs.push(dir)
  return new EvolveService({ dbPath: join(dir, 'e.db'), logger: () => {}, ...options })
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      /* Windows 句柄滞后 */
    }
  }
})

interface FakeRow {
  id: string
  content: string
  embedding: Float32Array | null
  accessCount: number
  updatedAt: number
}

/** 可控的 memory sweep：行由测试给，supersede/归档记账在测试侧。 */
function fakeSweep(options: {
  rows: FakeRow[]
  spaces?: string[]
  listSpaces?: () => string[]
  listActiveEmbeddings?: (space: string) => FakeRow[]
}): MemorySweep & {
  superseded: string[]
  archived: string[]
  archiveCalls: { method: string; limit: number | undefined }[]
} {
  const superseded: string[] = []
  const archived: string[] = []
  const archiveCalls: { method: string; limit: number | undefined }[] = []
  const rows = options.rows
  return {
    superseded,
    archived,
    archiveCalls,
    listSpaces:
      options.listSpaces ??
      (() => {
        return options.spaces ?? ['a1']
      }),
    listActiveEmbeddings:
      options.listActiveEmbeddings ??
      (() => {
        return rows.filter((r) => {
          return !superseded.includes(r.id)
        })
      }),
    supersede: (id) => {
      superseded.push(id)
    },
    archiveDormant: (dormantAfterMs, now, limit) => {
      archiveCalls.push({ method: 'dormant', limit })
      const hits = rows.filter(
        (r) => r.accessCount === 0 && now - r.updatedAt > dormantAfterMs && !archived.includes(r.id),
      )
      const slice = limit === undefined ? hits : hits.slice(0, limit)
      archived.push(...slice.map((r) => r.id))
      return slice.length
    },
    archiveColdSuperseded: (maxAgeMs, now, limit) => {
      archiveCalls.push({ method: 'superseded', limit })
      const hits = rows.filter(
        (r) => superseded.includes(r.id) && now - r.updatedAt > maxAgeMs && !archived.includes(r.id),
      )
      const slice = limit === undefined ? hits : hits.slice(0, limit)
      archived.push(...slice.map((r) => r.id))
      return slice.length
    },
  }
}

/**
 * 主循环探针：在巩固分片期间反复抢时间片，记录每次它跑起来时这一轮的状态。
 *
 * Node 的 immediate 队列是 FIFO，且每执行完一个回调都会排空微任务，所以巩固
 * 每片之间的让出点（服务侧每片前的 `setImmediate`）与这里的探针严格交替执行——
 * 这与墙钟无关。用 0ms 定时器就不行：整轮跑得足够快时事件循环一次都不会回到
 * timers 阶段，定时器一次都不触发，那是纯调度竞态，而不是"主循环还活着"的证据
 * （真退回同步跑完整个 P0 冻结的话，探针只会跑一次、且看到整轮已收尾）。
 */
interface LoopTurn {
  /** 那一刻整轮巩固是否已经收尾（lastConsolidation 只在整轮结束时落定）。 */
  roundDone: boolean
  /** 那一刻已经发起过的归档调用数（切片推进程度的可观察量）。 */
  archiveCalls: number
}

function probeMainLoop(
  service: EvolveService,
  sweep: { archiveCalls: unknown[] },
): {
  turns: LoopTurn[]
  stop: () => void
} {
  const turns: LoopTurn[] = []
  let running = true
  const tick = () => {
    if (!running) return
    turns.push({
      roundDone: service.lastConsolidationResult() !== undefined,
      archiveCalls: sweep.archiveCalls.length,
    })
    setImmediate(tick)
  }
  setImmediate(tick)
  return {
    turns,
    stop: () => {
      running = false
    },
  }
}

/** n 行互异向量（one-hot，任意两行余弦为 0）：判重需要 n(n-1)/2 次比较。 */
function distinctRows(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(n)
    v[i] = 1
    return {
      id: `m${i}`,
      content: `记忆 ${i}`,
      embedding: v,
      accessCount: 1,
      updatedAt: Date.now(),
    }
  })
}

describe('巩固分片：主循环不再被冻住', () => {
  it('runOnce 同步部分有界并立刻返回，剩余切片让出事件循环后台跑完', async () => {
    const s = service({ limits: { consolidationSliceUnits: 20, consolidationSliceMs: 2 } })
    const sweep = fakeSweep({ rows: distinctRows(120) })
    s.attachMemorySweep(sweep)

    // 1) 同步调用只做一片：O(n²) 的 7140 次比较一次跑不完。
    const startedAt = Date.now()
    const first = s.runOnce()
    const syncMs = Date.now() - startedAt
    expect(first.pending).toBe(true) // 还有切片没做完
    expect(first.scannedMemories).toBeLessThanOrEqual(20)
    expect(syncMs).toBeLessThan(200) // 主线程没有被这轮判重占住

    // 2) 巩固期间主循环反复把时间片交还给别的宏任务（真正的不冻证据）：
    //    探针拿到过不止一次时间片，且每一次都发生在这一轮收尾之前。
    const probe = probeMainLoop(s, sweep)
    await s.flush()
    probe.stop()
    expect(probe.turns.length).toBeGreaterThan(1)
    expect(
      probe.turns.some((turn) => {
        return turn.roundDone
      }),
    ).toBe(false)

    // 3) 跑完之后再跑一轮：幂等，没有任何新的合并/归档动作。
    const second = await s.runUntilIdle()
    expect(second.mergedMemories).toBe(0)
    expect(second.archivedDormant).toBe(0)
    expect(second.pending).toBe(false)
  })

  it('runUntilIdle 等到整轮跑完（手动触发/关闭路径用）', async () => {
    const s = service({ limits: { consolidationSliceUnits: 10 } })
    const sweep = fakeSweep({ rows: distinctRows(60) })
    s.attachMemorySweep(sweep)
    const result = await s.runUntilIdle()
    expect(result.pending).toBe(false)
    // 60 行 8 维互异向量：一对都不该判重
    expect(result.mergedMemories).toBe(0)
    expect(result.scannedMemories).toBe(1770) // C(60,2)
  })

  it('预算耗尽即截断：剩余工作丢弃，不拖住主循环，下一轮从头再来', async () => {
    const s = service({ limits: { consolidationSliceUnits: 5, consolidationBudgetMs: 10 } })
    const sweep = fakeSweep({ rows: distinctRows(400) })
    s.attachMemorySweep(sweep)
    const first = s.runOnce()
    await s.flush()

    // 预算耗尽 → 这一轮以「超时丢弃」收尾，不会无限切片。
    const truncated = s.lastConsolidationResult()
    expect(truncated?.truncated).toBe(true)
    expect(truncated?.pending).toBe(false)
    // 确实只做了预算内的工作：远小于 C(400,2)=79800。
    expect(truncated!.scannedMemories).toBeLessThan(79_800)
    expect(s.metrics().byKind.consolidate.processed).toBeGreaterThan(0)

    // 下一轮从干净游标重来，不会接着半截状态无限累加。
    const second = s.runOnce()
    expect(second.scannedMemories).toBeLessThanOrEqual(5)
    expect(second.truncated).toBe(false)
    expect(first.pending).toBe(true)
  })
})

describe('巩固归档：整段 UPDATE 也要切片，主循环不再被冻 1.8s', () => {
  /** n 条从未被访问、且很久没更新的记忆（全部够归档）。 */
  function dormantRows(n: number): FakeRow[] {
    return Array.from({ length: n }, (_, i) => {
      return {
        id: `d${i}`,
        content: `陈旧记忆 ${i}`,
        embedding: null,
        accessCount: 0,
        updatedAt: Date.now() - 365 * 86_400_000,
      }
    })
  }

  it('归档按片推进：runOnce 一片就返回，runUntilIdle 等到整轮搬完', async () => {
    const rows = dormantRows(500)
    // 片长 10 < 归档相位自身的 22 步：归档本身就是分片跑的，"按片推进"才成立。
    const s = service({ limits: { consolidationSliceUnits: 10, consolidationArchiveChunkRows: 25 } })
    const sweep = fakeSweep({ rows })
    s.attachMemorySweep(sweep)

    const first = s.runOnce()
    // 同步部分只搬一片：归档不是一次 500 行的 UPDATE。
    expect(first.archivedDormant).toBeLessThanOrEqual(25)
    expect(first.pending).toBe(true)

    const probe = probeMainLoop(s, sweep)
    const done = await s.runUntilIdle()
    probe.stop()

    // 主循环在归档还没搬完时就反复抢到过时间片（不是跑完了才醒）。
    expect(probe.turns.length).toBeGreaterThan(1)
    expect(
      probe.turns.some((turn) => {
        return turn.roundDone
      }),
    ).toBe(false)
    expect(Math.max(...probe.turns.map((turn) => turn.archiveCalls))).toBeLessThan(sweep.archiveCalls.length)
    expect(done.pending).toBe(false)
    expect(done.archivedDormant).toBe(500)
    expect(sweep.archived).toHaveLength(500)
  })

  it('每一次归档调用都带片长上限，绝不出现不限行的整段 UPDATE', async () => {
    const s = service({ limits: { consolidationArchiveChunkRows: 32 } })
    const sweep = fakeSweep({ rows: dormantRows(200) })
    s.attachMemorySweep(sweep)

    await s.runUntilIdle()

    expect(sweep.archiveCalls.length).toBeGreaterThan(1) // 200 行 / 32 一片
    expect(
      sweep.archiveCalls.every((call) => {
        return call.limit === 32
      }),
    ).toBe(true)
    expect(s.lastConsolidationResult()?.archivedDormant).toBe(200)
  })

  it('切片与整段的口径一致：跑完一遍归档，行集合不多不少', async () => {
    const s = service({ limits: { consolidationArchiveChunkRows: 10 } })
    const sweep = fakeSweep({ rows: dormantRows(95) })
    s.attachMemorySweep(sweep)

    const result = await s.runUntilIdle()
    expect(result.archivedDormant).toBe(95)
    expect(new Set(sweep.archived).size).toBe(95) // 没有重复归档
    // 末片返回 7 < 10 → 扫空后补一次 0 收尾，整轮才结束。
    const calls = sweep.archiveCalls.filter((call) => {
      return call.method === 'dormant'
    })
    expect(calls.at(-1)?.limit).toBe(10)
  })

  it('未挂记忆面时不报错也不空转（归档相位照常收尾）', () => {
    const s = service()
    const result = s.runOnce()
    expect(result.archivedDormant).toBe(0)
    expect(result.archivedSuperseded).toBe(0)
    expect(result.pending).toBe(false)
  })

  it('归档抛错只丢这一段：整轮仍正常结束，错误被记账', async () => {
    const s = service()
    s.attachMemorySweep({
      ...fakeSweep({ rows: dormantRows(5) }),
      archiveDormant: () => {
        throw new Error('memory db locked')
      },
    })

    const result = await s.runUntilIdle()
    expect(result.errors).toBeGreaterThanOrEqual(1)
    expect(result.archivedDormant).toBe(0)
    expect(result.pending).toBe(false)
  })
})

describe('巩固的失败隔离', () => {
  it('单个空间取数抛错只跳过该空间，其余空间照常合并', async () => {
    const s = service({ limits: { consolidationSliceUnits: 50 } })
    const good = distinctRows(4).map((r, i) => {
      // 前两行同向量 → 应合并
      return i < 2 ? { ...r, id: `g${i}`, embedding: Float32Array.from([1, 0, 0, 0]) } : r
    })
    const sweep = fakeSweep({
      rows: good,
      listSpaces: () => ['bad', 'good'],
      listActiveEmbeddings: (space) => {
        if (space === 'bad') throw new Error('memory db locked')
        return good.filter((r) => {
          return !sweep.superseded.includes(r.id)
        })
      },
    })
    s.attachMemorySweep(sweep)

    const result = await s.runUntilIdle()
    expect(result.errors).toBeGreaterThanOrEqual(1)
    expect(result.mergedMemories).toBe(1)
    expect(sweep.superseded).toContain('g1')
  })

  it('listSpaces 整体抛错也不炸出 runOnce（后台 housekeeping 不该带下服务）', async () => {
    const s = service()
    s.attachMemorySweep(
      fakeSweep({
        rows: [],
        listSpaces: () => {
          throw new Error('spaces unavailable')
        },
      }),
    )
    const result = s.runOnce()
    expect(result.errors).toBe(1)
    expect(result.pending).toBe(false)
    expect(result.mergedMemories).toBe(0)
  })

  it('未挂记忆面时 runOnce 只做到期清理，不报错', () => {
    const s = service()
    s.store.insertReflection({ agentId: 'a1', lesson: '老教训' })
    const db = (s.store as unknown as { db: { prepare: (q: string) => { run: (...a: (number | string)[]) => void } } })
      .db
    db.prepare('UPDATE reflections SET created_at = ? WHERE agent_id = ?').run(Date.now() - 31 * 86_400_000, 'a1')
    const result = s.runOnce()
    expect(result.expiredReflections).toBe(1)
    expect(result.pending).toBe(false)
  })
})

describe('巩固耗时埋点', () => {
  it('每轮巩固记一条（耗时 + 扫描条数），可被服务端聚合', async () => {
    const rounds: { durationMs: number; processed: number; kind: string }[] = []
    const s = service({
      limits: { consolidationSliceUnits: 30 },
      onRound: (round) => {
        rounds.push({ durationMs: round.durationMs, processed: round.processed, kind: round.kind })
      },
    })
    s.attachMemorySweep(fakeSweep({ rows: distinctRows(50) }))
    await s.runUntilIdle()

    expect(rounds.length).toBeGreaterThan(0)
    expect(
      rounds.every((r) => {
        return r.kind === 'consolidate'
      }),
    ).toBe(true)
    expect(
      rounds.every((r) => {
        return r.durationMs >= 0 && r.processed > 0
      }),
    ).toBe(true)

    const metrics = s.metrics()
    expect(metrics.byKind.consolidate.rounds).toBe(rounds.length)
    expect(metrics.byKind.consolidate.processed).toBe(
      rounds.reduce((sum, r) => {
        return sum + r.processed
      }, 0),
    )
    expect(metrics.totals.durationMs).toBeGreaterThanOrEqual(0)
    expect(metrics.last?.kind).toBe('consolidate')
  })

  it('环形缓冲只保留最近 N 轮（长跑进程不会把内存吃光）', async () => {
    const s = service({ limits: { metricsRounds: 3 } })
    for (let i = 0; i < 6; i++) s.runOnce()
    await s.flush()
    const metrics = s.metrics()
    expect(metrics.rounds.length).toBeLessThanOrEqual(3)
    // 累计口径不受环形上限影响（服务端要看的是"一共跑了多久"）。
    expect(metrics.byKind.consolidate.rounds).toBeGreaterThanOrEqual(6)
  })
})
