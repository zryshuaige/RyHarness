/**
 * 群聊派工提示词必须按真实成员名单生成（P0，真机抓到的）。
 *
 * 曾经的路由指令是一段写死的常量，示例名是 `@CodeBot`。真实模型会照抄示例：
 * 真机实测调度员在回复里喊「@CodeBot 去查最近没去过的店，完成后 @OrganizerBot
 * 汇总」，而群里根本没有这两个 agent——接力链于是永远派不出去，且界面上看不出
 * 任何异常（调度员确实回复了，只是没人接手）。
 *
 * 另外 `parseMentions` 只认显示名：模型写 `@ryen-team-coding`（id）时同样
 * 静默失效。这里把两条一起钉住。
 */
import type { AgentDefinition } from '@ryharness/agent'
import { describe, expect, it } from 'vitest'
import { dispatcherRoutingSuffix, memberHandoffSuffix } from '../src/dispatcher.ts'
import { parseMentions } from '../src/mentions.ts'

function member(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    systemPrompt: `${name} 的人设`,
    model: 'mock',
    provider: 'mock',
  } as unknown as AgentDefinition
}

const RYEN = member('ryen', 'Ryen')
const AMA = member('ryen-team-coding', '阿码')
const ADI = member('ryen-team-organizer', '阿屉')

describe('群聊派工路由指令', () => {
  it('名单按群成员现生成：每个非调度员成员的名字与 id 都在里面', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA, ADI], 'ryen')
    expect(suffix).toContain('@阿码')
    expect(suffix).toContain('ryen-team-coding')
    expect(suffix).toContain('@阿屉')
    expect(suffix).toContain('ryen-team-organizer')
  })

  it('不再出现任何写死的示例名（曾经那句 @CodeBot 会把接力带偏）', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA], 'ryen')
    expect(suffix).not.toContain('CodeBot')
    expect(suffix).not.toContain('OrganizerBot')
  })

  it('明说不得编造名单外的名字，并给出「写错等于没派」的理由', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA], 'ryen')
    expect(suffix).toContain('编造')
  })

  it('调度员自己不在可 @ 名单里', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA], 'ryen')
    expect(suffix).not.toContain('@Ryen')
  })

  it('群里只有调度员一人时如实说明没有可交接的人', () => {
    const suffix = dispatcherRoutingSuffix([RYEN], 'ryen')
    expect(suffix).toContain('没有其他成员')
  })

  it('给出「光在文字里说去办不算交接」的硬约束（真机实测模型只说不调工具）', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA, ADI], 'ryen')
    expect(suffix).toContain('必须调用 handoff 工具')
  })

  it('示例名取名单里的真人（模型照抄示例时也派得出去）', () => {
    const suffix = dispatcherRoutingSuffix([RYEN, AMA, ADI], 'ryen')
    expect(suffix).toContain('handoff(to="阿码"')
  })
})

describe('成员交接提示（接力链上的非调度员）', () => {
  it('列出除自己外的可交接成员，并要求用工具而不是文字交接', () => {
    const suffix = memberHandoffSuffix([RYEN, AMA, ADI], 'ryen-team-coding')
    expect(suffix).toContain('@Ryen')
    expect(suffix).toContain('@阿屉')
    expect(suffix).not.toContain('@阿码')
    expect(suffix).toContain('必须调用 handoff 工具')
  })

  it('群里没有其他人时不追加任何提示', () => {
    expect(memberHandoffSuffix([RYEN], 'ryen')).toBe('')
  })
})

describe('parseMentions：名字与 id 都认', () => {
  it('按显示名命中（输入框自动补全插进来的就是名字）', () => {
    expect(parseMentions('@阿码 你去查，@阿屉 汇总', [RYEN, AMA, ADI]).map((m) => m.id)).toEqual([
      'ryen-team-coding',
      'ryen-team-organizer',
    ])
  })

  it('按 id 命中（模型常直接用 id 称呼成员）', () => {
    expect(
      parseMentions('@ryen-team-coding 先查，@ryen-team-organizer 再汇总', [RYEN, AMA, ADI]).map((m) => m.id),
    ).toEqual(['ryen-team-coding', 'ryen-team-organizer'])
  })

  it('同一个人两种写法都出现时只算一次，位置以最早出现为准', () => {
    const hits = parseMentions('@ryen-team-coding 查店，@阿码 写个单子', [RYEN, AMA])
    expect(hits.map((m) => m.id)).toEqual(['ryen-team-coding'])
  })

  it('名字是另一个成员 id 的前缀时不会误配', () => {
    const hits = parseMentions('@ryen-team 收工', [RYEN, AMA])
    expect(hits).toEqual([])
  })

  it('不存在的人名派不出去（不猜、不兜底）', () => {
    expect(parseMentions('@CodeBot 去查', [RYEN, AMA, ADI])).toEqual([])
  })
})
