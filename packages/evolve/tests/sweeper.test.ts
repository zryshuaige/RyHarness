/**
 * 巩固状态机（{@link Sweeper}）三个阶段各自的单测。
 *
 * 这组用例不经过 EvolveService：状态机拆出来之后，每个阶段都能只挂一个游标直接
 * 推进。断言也从「整轮返回了什么」换成「这一阶段的游标走到了哪一步」——阶段边界
 * （dedupe → origins → archive、dormant 段 → superseded 段）本来就是状态机内部的
 * 结构，不该只能被整轮口径间接覆盖。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvolveLimits, MemorySweep, SweepRoundRecord, SweepState } from '@ryharness/evolve'
import { DEFAULT_EVOLVE_LIMITS, EvolveStore, Sweeper } from '@ryharness/evolve'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []

function store(): EvolveStore {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-sweeper-'))
  dirs.push(dir)
  return new EvolveStore(join(dir, 'e.db'))
}

/** 接宿主并返回埋点收集器；限流参数按用例需要覆盖。 */
function sweeper(host: { store: EvolveStore; memory?: MemorySweep; limits?: Partial<EvolveLimits> }): {
  sweeper: Sweeper
  rounds: SweepRoundRecord[]
} {
  const rounds: SweepRoundRecord[] = []
  const instance = new Sweeper()
  instance.attach({
    store: host.store,
    limits: { ...DEFAULT_EVOLVE_LIMITS, ...host.limits },
    log: () => {},
    recordConsolidation: (round) => {
      rounds.push(round)
    },
  })
  if (host.memory !== undefined) instance.attachMemorySweep(host.memory)
  return { sweeper: instance, rounds }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
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

/** 记忆面：行由测试给，supersede 与两段归档在测试侧记账。 */
function memorySurface(options: {
  rows: FakeRow[]
  spaces?: string[]
}): MemorySweep & { superseded: string[]; archived: string[]; archiveLimits: (number | undefined)[] } {
  const superseded: string[] = []
  const archived: string[] = []
  const archiveLimits: (number | undefined)[] = []
  const rows = options.rows
  const chunk = (hits: FakeRow[], limit: number | undefined): FakeRow[] => {
    return limit === undefined ? hits : hits.slice(0, limit)
  }
  return {
    superseded,
    archived,
    archiveLimits,
    listSpaces: () => {
      return options.spaces ?? []
    },
    listActiveEmbeddings: () => {
      return rows.filter((row) => {
        return !superseded.includes(row.id)
      })
    },
    supersede: (id) => {
      superseded.push(id)
    },
    archiveDormant: (_afterMs, _now, limit) => {
      archiveLimits.push(limit)
      const hits = chunk(
        rows.filter((row) => {
          return row.accessCount === 0 && !archived.includes(row.id)
        }),
        limit,
      )
      archived.push(...hits.map((row) => row.id))
      return hits.length
    },
    archiveColdSuperseded: (_maxAgeMs, _now, limit) => {
      archiveLimits.push(limit)
      const hits = chunk(
        rows.filter((row) => {
          return superseded.includes(row.id) && !archived.includes(row.id)
        }),
        limit,
      )
      archived.push(...hits.map((row) => row.id))
      return hits.length
    },
  }
}

/** 推进到指定阶段（不设上限，让状态机自己走到那儿）。返回推进步数。 */
function advanceTo(state: SweepState, target: SweepState['phase'], sweeper: Sweeper): number {
  let steps = 0
  while (state.phase !== target && !state.completed && steps < 100_000) {
    sweeper.advance(state)
    steps += 1
  }
  return steps
}

describe('dedupe 阶段：只合并，不碰溯源与归档', () => {
  it('余弦 >0.95 的后一行被 supersede，互异向量一对都不动', () => {
    const same = Float32Array.from([1, 0, 0, 0])
    const rows: FakeRow[] = [
      { id: 'r0', content: 'a', embedding: same, accessCount: 1, updatedAt: Date.now() },
      { id: 'r1', content: 'b', embedding: same, accessCount: 1, updatedAt: Date.now() },
      { id: 'r2', content: 'c', embedding: Float32Array.from([0, 1, 0, 0]), accessCount: 1, updatedAt: Date.now() },
    ]
    const memory = memorySurface({ rows, spaces: ['a1'] })
    const { sweeper: engine } = sweeper({ store: store(), memory })
    const state = engine.beginSweep(Date.now())

    advanceTo(state, 'origins', engine)

    expect(state.merged).toBe(1)
    expect(memory.superseded).toEqual(['r1'])
    // 只有真正相同的那一对参与合并；互异向量那行既没被软删也没被计错。
    expect(state.archivedDormant).toBe(0)
    expect(state.archivedSuperseded).toBe(0)
  })

  it('取数抛错只丢该空间：游标照常换到下一阶段，错误记账但整轮不炸', () => {
    const memory = memorySurface({ rows: [], spaces: ['bad', 'good'] })
    const original = memory.listActiveEmbeddings
    memory.listActiveEmbeddings = (space) => {
      if (space === 'bad') throw new Error('memory db locked')
      return original(space)
    }
    const { sweeper: engine } = sweeper({ store: store(), memory })
    const state = engine.beginSweep(Date.now())

    advanceTo(state, 'origins', engine)

    expect(state.errors).toBe(1)
    expect(state.phase).toBe('origins')
  })

  it('slice 的单位预算真的截断这一片：剩下的游标留给下一片', () => {
    const rows: FakeRow[] = Array.from({ length: 30 }, (_, i) => {
      const vector = new Float32Array(30)
      vector[i] = 1
      return {
        id: `m${i}`,
        content: `记忆 ${i}`,
        embedding: vector,
        accessCount: 1,
        updatedAt: Date.now(),
      }
    })
    const { sweeper: engine } = sweeper({ store: store(), memory: memorySurface({ rows, spaces: ['a1'] }) })
    const state = engine.beginSweep(Date.now())

    const first = engine.slice(state, 5, 10_000)
    // C(30,2)=435 次比较远多于 5 个单位：一片只做一片。
    expect(first.units).toBe(5)
    expect(state.completed).toBe(false)

    const second = engine.slice(state, 5, 10_000)
    expect(second.units).toBe(5)
    // 游标跨片保留（不是每片从零开始）：第二片接着第一片的列游标往下比。
    expect(state.colIndex).toBeGreaterThan(1)
    // 两片合计 10 个单位，其中 2 个花在装载（列空间 + 装行），其余才是比较。
    expect(state.scanned).toBe(8)
  })
})

describe('origins 阶段：条目↔记忆溯源', () => {
  it('词面重合的记忆写进 entry_origins，不重合的一条都不写', () => {
    const books = store()
    const entry = books.insertEntry({
      agentId: 'a1',
      section: 'strategy',
      content: '翻译之前先确认目标语言',
      source: 'manual',
    })
    const memory = memorySurface({
      rows: [
        { id: 'hit', content: '翻译之前先确认目标语言再动手', embedding: null, accessCount: 1, updatedAt: Date.now() },
        { id: 'miss', content: '今天午饭吃面条', embedding: null, accessCount: 1, updatedAt: Date.now() },
      ],
      spaces: ['a1'],
    })
    const { sweeper: engine } = sweeper({ store: books, memory })
    const state = engine.beginSweep(Date.now())

    advanceTo(state, 'origins', engine)
    while (state.phase === 'origins') engine.advance(state)

    const origins = books.listOrigins(entry.id)
    expect(
      origins.map((origin) => {
        return origin.refId
      }),
    ).toEqual(['hit'])
    expect(origins[0]?.kind).toBe('memory')
    expect(state.origins).toBe(1)
    // 溯源阶段只写溯源，不顺手归档。
    expect(state.archivedDormant).toBe(0)
  })

  it('没有手册条目时直接跳到归档相位，不空转', () => {
    const { sweeper: engine } = sweeper({ store: store(), memory: memorySurface({ rows: [], spaces: ['a1'] }) })
    const state = engine.beginSweep(Date.now())

    const steps = advanceTo(state, 'archive', engine)

    expect(state.phase).toBe('archive')
    expect(state.entries).toHaveLength(0)
    // 空条目也要走完 origins 的装载/收尾两步，不是卡住也不是一步跳过去。
    expect(steps).toBeGreaterThan(0)
  })
})

describe('archive 阶段：两段归档各自按片推进', () => {
  it('dormant 段搬满片长才换段，两段搬空整轮才 completed', () => {
    const rows: FakeRow[] = Array.from({ length: 25 }, (_, i) => {
      return {
        id: `d${i}`,
        content: `陈旧 ${i}`,
        embedding: null,
        accessCount: 0,
        updatedAt: Date.now() - 365 * 86_400_000,
      }
    })
    const memory = memorySurface({ rows, spaces: [] })
    const { sweeper: engine } = sweeper({
      store: store(),
      memory,
      limits: { consolidationArchiveChunkRows: 10 },
    })
    const state = engine.beginSweep(Date.now())
    advanceTo(state, 'archive', engine)

    engine.advance(state)
    // 第一片搬满 10 < 25：dormant 段还没搬空，不能换段。
    expect(state.archivedDormant).toBe(10)
    expect(state.archiveStage).toBe('dormant')
    expect(state.completed).toBe(false)

    engine.advance(state)
    engine.advance(state)
    // 第三片只有 5 行 < 10：视为搬空，转 superseded 段（此时 supersede 集为空）。
    expect(state.archivedDormant).toBe(25)
    expect(state.archiveStage).toBe('superseded')
    expect(state.completed).toBe(false)

    engine.advance(state)
    expect(state.archiveStage).toBe('superseded')
    expect(state.completed).toBe(true)
  })

  it('每一片都带上限，绝不出现不限行的整段 UPDATE', () => {
    const rows: FakeRow[] = Array.from({ length: 40 }, (_, i) => {
      return {
        id: `d${i}`,
        content: `陈旧 ${i}`,
        embedding: null,
        accessCount: 0,
        updatedAt: 0,
      }
    })
    const memory = memorySurface({ rows, spaces: [] })
    const { sweeper: engine } = sweeper({
      store: store(),
      memory,
      limits: { consolidationArchiveChunkRows: 8 },
    })
    const state = engine.beginSweep(Date.now())
    advanceTo(state, 'archive', engine)
    while (!state.completed) engine.advance(state)

    expect(state.archivedDormant).toBe(40)
    expect(
      memory.archiveLimits.every((limit) => {
        return limit === 8
      }),
    ).toBe(true)
    // 40 行 / 8 一片 = 5 片，再加一次搬空 dormant 段、一次搬空 superseded 段。
    expect(memory.archiveLimits.length).toBe(7)
  })

  it('一段抛错只丢这一段：dormant 报错后 superseded 段照走，整轮仍能收尾', () => {
    const rows: FakeRow[] = Array.from({ length: 3 }, (_, i) => {
      return {
        id: `d${i}`,
        content: `陈旧 ${i}`,
        embedding: null,
        accessCount: 0,
        updatedAt: 0,
      }
    })
    const memory = memorySurface({ rows, spaces: [] })
    memory.archiveDormant = () => {
      throw new Error('memory db locked')
    }
    const { sweeper: engine } = sweeper({ store: store(), memory })
    const state = engine.beginSweep(Date.now())
    advanceTo(state, 'archive', engine)
    while (!state.completed) engine.advance(state)

    expect(state.errors).toBeGreaterThanOrEqual(1)
    expect(state.archivedDormant).toBe(0)
    expect(state.completed).toBe(true)
  })
})

describe('状态机的宿主边界', () => {
  it('没 attach 宿主就跑巩固会立刻抛错，而不是静默跑一个空轮', () => {
    const engine = new Sweeper()
    expect(() => {
      engine.runOnce()
    }).toThrow(/attach/)
  })

  it('runOnce 只做有界的一片，其余让出事件循环；drain() 之后拿到整轮口径', async () => {
    const rows: FakeRow[] = Array.from({ length: 60 }, (_, i) => {
      const vector = new Float32Array(60)
      vector[i] = 1
      return {
        id: `m${i}`,
        content: `记忆 ${i}`,
        embedding: vector,
        accessCount: 1,
        updatedAt: Date.now(),
      }
    })
    const { sweeper: engine, rounds } = sweeper({
      store: store(),
      memory: memorySurface({ rows, spaces: ['a1'] }),
      limits: { consolidationSliceUnits: 20 },
    })

    const first = engine.runOnce()
    // C(60,2)=1770 次比较一片做不完。
    expect(first.pending).toBe(true)
    expect(first.scannedMemories).toBeLessThanOrEqual(20)
    expect(first.errors).toBe(0)

    const done = await engine.runUntilIdle()
    expect(done.pending).toBe(false)
    expect(done.scannedMemories).toBe(1770)
    expect(engine.lastResult()?.scannedMemories).toBe(1770)

    // 埋点由宿主记账：同步片与后台续跑各一条，状态机自己不持有历史。
    expect(rounds.length).toBeGreaterThan(0)
    expect(
      rounds.every((round) => {
        return round.processed >= 0 && round.durationMs >= 0
      }),
    ).toBe(true)
  })
})
