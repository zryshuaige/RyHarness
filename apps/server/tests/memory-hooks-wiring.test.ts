/**
 * 生产组合根的记忆计时包装（timedMemoryHooks）不把两段式召回吃掉。
 *
 * 事故形态：包装层只透传 recall/enqueueExtraction，recallSync/recallRefine 在
 * 这里被丢掉。下游（coordinator 的 bindMemory、群调度器的 FanoutMemory）都按
 * "底层有没有这两个方法"决定要不要把同步通道交给 AgentLoop——包装层一丢，生产上
 * 首 token 静默退回 await 召回（embedding 网络往返排进首 token），recallRefine
 * 断掉后语义通道的回灌也一并消失。这里的用例锁的就是"包装前后钩子形状不变"。
 */
import type { AgentMemoryHooks } from '@ryharness/agent'
import { describe, expect, it } from 'vitest'
import { timedMemoryHooks } from '../src/app.ts'
import { Telemetry } from '../src/telemetry.ts'

/** 与 MemoryService 同形态：recallSync/recallRefine 是**原型方法**，依赖 this。 */
class PrototypeHooks implements AgentMemoryHooks {
  syncCalls = 0
  refineArgs: (string | number | undefined)[] = []
  extractionQueued = 0

  recallSync(_agentId: string, _inputText: string): string | undefined {
    this.syncCalls += 1
    return this.syncCalls === 1 ? '[记忆] 同步通道注入' : undefined
  }

  async recallRefine(agentId: string, inputText: string, deadlineMs?: number): Promise<boolean> {
    this.refineArgs.push(agentId, inputText, deadlineMs)
    return true
  }

  async recall(_agentId: string, _inputText: string): Promise<string | undefined> {
    return '[记忆] await 通道注入'
  }

  enqueueExtraction(): void {
    this.extractionQueued += 1
  }
}

describe('timedMemoryHooks：两段式召回穿过计时包装层', () => {
  it('recallSync/recallRefine 条件透传，且原型方法的 this 绑定不被拆掉', async () => {
    const hooks = new PrototypeHooks()
    const wrapped = timedMemoryHooks(hooks, new Telemetry())
    // 形状：两个方法都在（AgentLoop 与 FanoutMemory 靠 undefined 判断走哪条路）。
    expect(wrapped.recallSync).toBeTypeOf('function')
    expect(wrapped.recallRefine).toBeTypeOf('function')
    // this 绑定：裸透传会让 syncCalls/refineArgs 停在 0/空。
    expect(wrapped.recallSync?.('a1', '中午吃什么')).toBe('[记忆] 同步通道注入')
    expect(hooks.syncCalls).toBe(1)
    await wrapped.recallRefine?.('a1', '中午吃什么', 150)
    expect(hooks.refineArgs).toEqual(['a1', '中午吃什么', 150])
    expect(hooks.extractionQueued).toBe(0)
    wrapped.enqueueExtraction('a1', 'Ryen', 'c1', '中午吃什么')
    expect(hooks.extractionQueued).toBe(1)
  })

  it('同步通道完成的本轮注入也进召回计量（health 的"最近一次召回"不靠 await 通道）', () => {
    const hooks: AgentMemoryHooks = {
      recallSync: () => {
        return '[记忆] 相关记忆：\n- 用户养了一只橘猫'
      },
      async recall() {
        throw new Error('两段式路径下首 token 不该碰 await 通道')
      },
      enqueueExtraction: () => {},
    }
    const telemetry = new Telemetry()
    const wrapped = timedMemoryHooks(hooks, telemetry)
    const recorder = telemetry.beginTurn('c1', 'direct', 0)
    telemetry.scopedTurn('c1', () => {
      wrapped.recallSync?.('a1', '我的猫叫什么')
    })
    telemetry.endTurn(recorder, 'ok')
    const turn = telemetry.getSnapshot().turns[0]
    expect(turn?.memoryItems).toBe(1)
    expect(turn?.memoryRecallMs).toBeGreaterThanOrEqual(0)
  })

  it('底层没实现同步通道时，包装层也不补恒定 undefined 的 recallSync', () => {
    const bare: AgentMemoryHooks = {
      recall: async () => {
        return '[记忆] await 通道注入'
      },
      enqueueExtraction: () => {},
    }
    const wrapped = timedMemoryHooks(bare, new Telemetry())
    // 必须真的是 undefined：AgentLoop 看到 recallSync 存在就跳过 await 兜底，
    // 一个永远返回 undefined 的同步通道等于让记忆静默失效。
    expect(wrapped.recallSync).toBeUndefined()
    expect(wrapped.recallRefine).toBeUndefined()
  })

  it('recall 照旧透传返回值（无遥测作用域时不记、也不抛）', async () => {
    const bare: AgentMemoryHooks = {
      recall: async () => {
        return '[记忆] 用户画像：\n- 口味偏辣'
      },
      enqueueExtraction: () => {},
    }
    const wrapped = timedMemoryHooks(bare, new Telemetry())
    await expect(wrapped.recall('a1', '中午吃什么')).resolves.toBe('[记忆] 用户画像：\n- 口味偏辣')
  })
})
