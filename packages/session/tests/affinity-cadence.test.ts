/**
 * 亲密度的节奏：首场会话里就要跨一次档。
 *
 * 这不是数值游戏。跨档是养成关系唯一的可见事件（弹一句关系提示 + 称呼换掉），每轮
 * +2、档位切在 20/45/70 时，3–8 轮的首次会话永远等不到它——用户只看到分数在爬，
 * 而"它跟我不熟"这件事从头到尾没变过。于是这里按档位写死节奏：首场会话必须跨档，
 * 且不能一轮就顶格（顶格之后"越来越熟"这条线索就没了）。
 */

import { AFFINITY_TIERS, affinityTier, affinityTurnGain } from '@ryharness/session'
import { nextAffinity } from '@ryharness/session/src/persona.ts'
import { describe, expect, it } from 'vitest'

/** 模拟连续对话：从 0 聊 turns 轮，每轮之后落在哪个档。 */
function afterTurns(turns: number): { affinity: number; tiers: string[] } {
  let affinity = 0
  const tiers: string[] = []
  for (let round = 1; round <= turns; round++) {
    affinity = nextAffinity(affinity, { turns: 1 })
    tiers.push(affinityTier(affinity).key)
  }
  return { affinity, tiers }
}

describe('亲密度节奏', () => {
  it('两轮之内跨过初识：首场会话开头就有称呼变化', () => {
    const first = afterTurns(2)
    expect(first.tiers[0]).toBe('stranger')
    expect(first.tiers[1]).not.toBe('stranger')
  })

  it('3–8 轮的首场会话至少跨一次档', () => {
    for (const turns of [3, 4, 5, 6, 7, 8]) {
      const { tiers } = afterTurns(turns)
      const crossed = new Set(tiers).size > 1
      expect(crossed, `${turns} 轮后仍在「${tiers.at(-1)}」：事件从没发生过`).toBe(true)
    }
  })

  it('前八轮跨两档以上（不是刚好蹭到一次）', () => {
    const { tiers } = afterTurns(8)
    expect(new Set(tiers).size).toBeGreaterThanOrEqual(3)
  })

  it('不会一轮顶格，但也不是永远到不了顶', () => {
    const { tiers } = afterTurns(30)
    const turnsToConfidant = tiers.indexOf('confidant') + 1
    expect(turnsToConfidant).toBeGreaterThanOrEqual(10)
    expect(turnsToConfidant).toBeLessThanOrEqual(20)
    // 一轮之后仍在头两档内：节奏是"几轮之后质变"，不是"第一句就老朋友"。
    expect(affinityTier(afterTurns(1).affinity).key).toBe('stranger')
    expect(afterTurns(1).affinity).toBeLessThan(AFFINITY_TIERS[1]?.max ?? 45)
  })

  it('越熟涨得越慢（收敛，不是一路 +12）', () => {
    expect(affinityTurnGain(0)).toBeGreaterThan(affinityTurnGain(25))
    expect(affinityTurnGain(50)).toBeGreaterThan(affinityTurnGain(80))
    // 夹紧：脏数据不该放大增益。
    expect(affinityTurnGain(-10)).toBe(affinityTurnGain(0))
    expect(affinityTurnGain(1_000)).toBe(affinityTurnGain(100))
  })

  it('点赞/点踩仍然按同一套规则算（轮次与反馈走同一个入口）', () => {
    // 早期一轮 12 分，点赞 5 分不再便宜到"两下就满档"，点踩仍能把话说回去。
    const afterTurn = nextAffinity(0, { turns: 1 })
    expect(nextAffinity(afterTurn, { likes: 1 })).toBe(afterTurn + 5)
    expect(nextAffinity(afterTurn, { dislikes: 1 })).toBe(afterTurn - 4)
    expect(nextAffinity(afterTurn, { completions: 1 })).toBe(afterTurn + 6)
    expect(nextAffinity(0, {})).toBe(0)
  })

  it('共同交付与聊天轮次是两种关系事件', () => {
    expect(nextAffinity(20, { completions: 1 })).toBe(26)
    expect(nextAffinity(20, { turns: 0, completions: 0 })).toBe(20)
  })
})
