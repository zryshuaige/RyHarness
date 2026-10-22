/**
 * 记忆的反向信号：👍/👎 能不能把一条记忆从棘轮里拉回来。
 *
 * 这一组用例盯的是一个具体的失效模式：在有反馈列之前，recall 的增益只有
 * `1 + log1p(accessCount)`，单调不减且只增不减。一条错误记忆只要被注入过一次，
 * 下一轮召回就再给它加一分——用户点 👎 系统听不见，于是它越用越牢固。
 * 这里用「同样的输入、同样两条候选，只有反馈计数不同」把这条曲线钉住。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRow } from '@ryharness/memory'
import { MemoryService, recallGain, SHARED_SPACE } from '@ryharness/memory'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-memory-feedback-'))
  dirs.push(dir)
  return join(dir, 'm.db')
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

// WRONG 必须与查询（'川菜' / '川菜 辣的 甜'）共享 bigram：这些用例不挂 embedding，
// 词法通道是唯一能把 WRONG 召回的通道——零字面交集的记忆在任何本地通道下都
// 不可召回，「注入 → 归因 → 👎」的链条根本搭不起来。
const WRONG = '用户从不吃辣的川菜，只吃甜的'
const RIGHT = '用户偏好川菜，重辣'

function ids(rows: readonly MemoryRow[]): string[] {
  return rows.map((row) => {
    return row.id
  })
}

describe('recallGain：召回增益的形状', () => {
  it('无反馈时与旧的「1 + log1p(accessCount)」逐值相等', () => {
    for (const accessCount of [0, 1, 5, 50, 1000]) {
      expect(recallGain({ accessCount, helpfulCount: 0, harmfulCount: 0 })).toBeCloseTo(1 + Math.log1p(accessCount), 12)
    }
  })

  it('👎 单调压低增益，👍 单调抬高', () => {
    const base = { accessCount: 4, helpfulCount: 0, harmfulCount: 0 }
    expect(recallGain({ ...base, harmfulCount: 1 })).toBeLessThan(recallGain(base))
    expect(recallGain({ ...base, harmfulCount: 2 })).toBeLessThan(recallGain({ ...base, harmfulCount: 1 }))
    expect(recallGain({ ...base, helpfulCount: 1 })).toBeGreaterThan(recallGain(base))
    expect(recallGain({ ...base, helpfulCount: 2 })).toBeGreaterThan(recallGain({ ...base, helpfulCount: 1 }))
  })

  it('👎 足够多时增益归零而不是变负——排序分恒正，反向增益会把排序扭成倒序', () => {
    // log1p(harmful) 需要超过 1 + log1p(accessCount) 才可能为负，这里取极端计数验证下界。
    expect(recallGain({ accessCount: 0, helpfulCount: 0, harmfulCount: 1000 })).toBe(0)
    expect(recallGain({ accessCount: 1000, helpfulCount: 0, harmfulCount: 1000 })).toBe(0)
  })

  it('👍 与 👎 权重对称：一正一负回到基线', () => {
    const base = { accessCount: 3, helpfulCount: 0, harmfulCount: 0 }
    expect(recallGain({ ...base, helpfulCount: 4, harmfulCount: 4 })).toBeCloseTo(recallGain(base), 12)
  })
})

describe('recordFeedback：反馈落到当轮注入的记忆上', () => {
  it('没有注入过时是 0 次改动，且不会误伤库里任何一行', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    const row = svc.store.insert({ agentId: 'a1', kind: 'fact', content: RIGHT })
    expect(svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })).toBe(0)
    expect(svc.store.get(row.id)?.harmfulCount).toBe(0)
    svc.close()
  })

  it('👎 记 harmful +1、👍 记 helpful +1，且只落在被注入的那些行上', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    const injected = svc.store.insert({ agentId: 'a1', kind: 'fact', content: RIGHT })
    const untouched = svc.store.insert({ agentId: 'a1', kind: 'fact', content: '用户的工位在四楼' })
    svc.store.insert({ agentId: SHARED_SPACE, kind: 'profile', content: '用户养了一只橘猫叫布丁' })
    // 共享画像每轮全量注入，因此它也在归因集合里。
    svc.recallSync('a1', '川菜')

    const hits = svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })
    expect(hits).toBeGreaterThan(0)
    expect(svc.store.get(injected.id)?.harmfulCount).toBe(1)
    expect(svc.store.get(untouched.id)?.harmfulCount).toBe(0)

    svc.recordFeedback({ agentId: 'a1', signal: 'thumb_up' })
    const again = svc.store.get(injected.id)
    expect(again?.helpfulCount).toBe(1)
    expect(again?.harmfulCount).toBe(1)
    svc.close()
  })

  it('归因按 agent 空间隔离：a1 的反馈不落到 b1 的注入上', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    svc.store.insert({ agentId: 'a1', kind: 'fact', content: 'a1 的专属记忆：川菜馆在楼下' })
    const b1 = svc.store.insert({ agentId: 'b1', kind: 'fact', content: 'b1 的专属记忆：咖啡只喝美式' })
    svc.recallSync('a1', '川菜馆')
    svc.recallSync('b1', '咖啡')

    svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })
    expect(svc.store.get(b1.id)?.harmfulCount).toBe(0)
    svc.close()
  })

  it('注入块为空时不留陈旧归因（否则会对上一轮的记忆误罚）', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    const row = svc.store.insert({ agentId: 'a1', kind: 'fact', content: RIGHT })
    svc.recallSync('a1', '川菜')
    expect(svc.lastInjectedIds('a1')).toContain(row.id)
    expect(svc.recallSync('a1', '查无此事的关键词zzz')).toBeUndefined()
    expect(svc.lastInjectedIds('a1')).toEqual([])
    expect(svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })).toBe(0)
    expect(svc.store.get(row.id)?.harmfulCount).toBe(0)
    svc.close()
  })

  it('反馈即刻反映在下一轮排序上（不靠向量缓存整体失效才生效）', async () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    const wrong = svc.store.insert({ agentId: 'a1', kind: 'fact', content: WRONG })
    const right = svc.store.insert({ agentId: 'a1', kind: 'fact', content: RIGHT })
    svc.recallSync('a1', '川菜')
    expect(svc.lastInjectedIds('a1')).toContain(wrong.id)

    expect(ids(await svc.hybridRecall('a1', '川菜', 2))).toContain(wrong.id)
    svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })
    const after = await svc.hybridRecall('a1', '川菜', 2)
    // 反馈之后它仍然可以被检索到（没被软删），但排序权重大幅下降。
    expect(svc.store.get(wrong.id)?.harmfulCount).toBe(1)
    const order = ids(after)
    expect(order).toContain(right.id)
    if (order.includes(wrong.id)) {
      expect(order.indexOf(right.id)).toBeLessThan(order.indexOf(wrong.id))
    }
    svc.close()
  })

  it('连续 👎 能把一条记忆彻底挤出 top-N（棘轮的刹车）', async () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    const wrong = svc.store.insert({ agentId: 'a1', kind: 'fact', content: WRONG })
    for (let i = 0; i < 12; i++) {
      svc.store.insert({ agentId: 'a1', kind: 'fact', content: `其他事实 ${i}：与提问无关的记录` })
    }
    const before = ids(await svc.hybridRecall('a1', '川菜 辣的 甜', 3))
    expect(before).toContain(wrong.id)

    // 每轮都要重新注入才归因得到它，所以先召回一次再点一次。
    for (let i = 0; i < 4; i++) {
      svc.recallSync('a1', '川菜 辣的 甜')
      svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })
    }
    // 只记 2 次：第 1 次 👎 大幅降权（增益 1.69 → 0.31），第 2 次后增益归零、
    // 退出竞争（注入块为空）——按「空注入不留陈旧归因」的语义，第 3、4 轮的 👎
    // 针对的是已经不含该记忆的回复，正确地罚不到它头上。这正是防误罚与
    // 棘轮刹车在同一条规则下的合力，而不是漏记。
    expect(svc.store.get(wrong.id)?.harmfulCount).toBe(2)
    const after = ids(await svc.hybridRecall('a1', '川菜 辣的 甜', 3))
    expect(after).not.toContain(wrong.id)
    // 只是排序出局，行还在：用户没说它错，只是说它没用。
    expect(svc.store.get(wrong.id)?.status).toBe('active')
    svc.close()
  })

  it('👍 能把一条被 👎 压下去的记忆拉回候选', () => {
    const svc = new MemoryService({ dbPath: dbPath() })
    svc.store.insert({ agentId: 'a1', kind: 'fact', content: RIGHT })
    svc.recallSync('a1', '川菜')
    svc.recordFeedback({ agentId: 'a1', signal: 'thumb_down' })
    svc.recallSync('a1', '川菜')
    svc.recordFeedback({ agentId: 'a1', signal: 'thumb_up' })
    const row = svc.store.listActiveForAgent('a1')[0]
    expect(row?.helpfulCount).toBe(1)
    expect(row?.harmfulCount).toBe(1)
    svc.close()
  })
})
