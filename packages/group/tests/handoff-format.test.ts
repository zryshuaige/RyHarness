/**
 * 调度员交接格式（[交办] 行）与路由解析口径。
 *
 * 背景是真机（硅基流动 DeepSeek-V3）实测：修好派工名单之后，调度员开始用真实成员名
 * 说话了，却把 @ 号漏掉——回复是「让阿码查最近没去过的店。让阿屉汇总大家的忌口。」，
 * 一个 @ 都没有，接力链于是静默失效：界面上只看到调度员答了话，没人接手。
 *
 * 与其赌模型每次都记得加 @，不如把交接语义落在一个显式标记行上：
 *   - 有 [交办] 行：只解析这些行里的 @（正文里顺口提到成员不算派工）；
 *   - 没有：退回整段文本，老行为（模型直接写 @阿码）仍然成立。
 */
import type { AgentDefinition } from '@ryharness/agent'
import { describe, expect, it } from 'vitest'
import { dispatcherRoutingSuffix, handoffText } from '../src/dispatcher.ts'
import { parseMentions } from '../src/mentions.ts'

function member(id: string, name: string): AgentDefinition {
  return { id, name, systemPrompt: `${name} 的人设`, model: 'mock', provider: 'mock' } as unknown as AgentDefinition
}

const RYEN = member('ryen', 'Ryen')
const AMA = member('ryen-team-coding', '阿码')
const ADI = member('ryen-team-organizer', '阿屉')
const ALL = [RYEN, AMA, ADI]

describe('调度员交接格式', () => {
  it('提示词改成让模型调用 handoff 工具，并给出真实成员名单', () => {
    const suffix = dispatcherRoutingSuffix(ALL, 'ryen')
    expect(suffix).toContain('handoff')
    expect(suffix).toContain('阿码')
    expect(suffix).toContain('ryen-team-coding')
    expect(suffix).toContain('阿屉')
  })

  it('明说交给自己 / 编造名字等于没派出去', () => {
    const suffix = dispatcherRoutingSuffix(ALL, 'ryen')
    expect(suffix).toContain('绝不交给自己')
    expect(suffix).toContain('编造')
  })

  it('有标记行时只解析标记行（正文里的 @ 不算数）', () => {
    const reply = ['交给我，先去办。', '顺便说一句，@阿屉 上次推荐的那家不错。', '[交办] @阿码 查最近没去过的店'].join(
      '\n',
    )
    expect(parseMentions(handoffText(reply), ALL).map((m) => m.id)).toEqual(['ryen-team-coding'])
  })

  it('没有标记行时退回整段文本（模型自由发挥的老行为仍成立）', () => {
    const reply = '好的，@阿码 你去查店。'
    expect(parseMentions(handoffText(reply), ALL).map((m) => m.id)).toEqual(['ryen-team-coding'])
  })

  it('调度员漏写 @ 号的散文不会误派工（真机上正是这种情况）', () => {
    const reply = '让阿码查最近没去过的店。\n\n让阿屉汇总大家的忌口。'
    expect(parseMentions(handoffText(reply), ALL)).toEqual([])
  })

  it('一行 [交办] 可以交多人', () => {
    const reply = '[交办] @阿码 查店，@阿屉 汇总忌口'
    expect(parseMentions(handoffText(reply), ALL).map((m) => m.id)).toEqual(['ryen-team-coding', 'ryen-team-organizer'])
  })

  it('[交办] 里写了名单外的名字不派工（不猜、不兜底）', () => {
    const reply = '[交办] @CodeBot 去查店'
    expect(parseMentions(handoffText(reply), ALL)).toEqual([])
  })

  it('调度员把自己写进 [交办] 会被 loop-guard 拦下（由 parseMentions 命中自己兜住）', () => {
    const reply = '[交办] @Ryen 我自己来'
    expect(parseMentions(handoffText(reply), [RYEN]).map((m) => m.id)).toEqual(['ryen'])
  })
})
