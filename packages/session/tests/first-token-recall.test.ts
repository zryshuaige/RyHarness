/**
 * 首 token 路径上的两段式召回：从**生产组合根**（SessionCoordinator → GroupDispatcher
 * → AgentLoop）走一遍，证明首 token 不等 embedding 那次网络往返。
 *
 * 为什么不在 memory 包里测：recallSync/recallRefine 在包内成立不代表生产成立。真正的
 * 风险恰恰出在"中间那层"——协调器把钩子重新绑一次（bindMemory）、调度器在扇出里再包
 * 一层（FanoutMemory），任何一层漏掉这两个方法，线上就静默退回 await 路径，而单测
 * memory 包永远看不到。这组用例量的就是这条链。
 *
 * 网络往返用一个闸门模拟：recall() 要等闸门开，而闸门由用例自己放。第一条事件能在闸
 * 门还关着的时候到达，才叫"不等网络"。
 */

import type { AgentDefinition, AgentMemoryHooks } from '@ryharness/agent'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryharness/llm'
import { SessionCoordinator, SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

const DIRECT_AGENT: AgentDefinition = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

const GROUP_MEMBERS: AgentDefinition[] = [
  { ...DIRECT_AGENT, id: 'ryen', name: 'Ryen' },
  { ...DIRECT_AGENT, id: 'bot', name: 'CodeBot' },
]

/** 记录每次请求的 system（注入块就在里面）。 */
function promptRecordingLlm(): { llm: LlmRuntime; systems: string[] } {
  const systems: string[] = []
  const llm = {
    stream(options: GenerateOptions) {
      systems.push(options.system ?? '')
      const text = '收到'
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  } as unknown as LlmRuntime
  return { llm, systems }
}

/**
 * 假记忆：同步通道（本地、立刻返回）+ 补正 + 一条要等闸门的 await 通道。
 *
 * 形态与 @ryharness/memory 的 MemoryService 同名同序——生产组合根就是靠这两个方法名
 * 认同步通道的，写成别的名字这条用例就测不到东西了。
 */
function gatedMemory(): AgentMemoryHooks & {
  /** 放行 await 通道（模拟 embedding 网络返回）。 */
  open: () => void
  awaitCalls: () => number
  refineCalls: () => number
  isOpen: () => boolean
} {
  let open = false
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let awaitCalls = 0
  let refineCalls = 0
  return {
    open: () => {
      open = true
      release?.()
    },
    awaitCalls: () => {
      return awaitCalls
    },
    refineCalls: () => {
      return refineCalls
    },
    isOpen: () => {
      return open
    },
    recallSync: () => {
      return '[记忆] 同步通道注入'
    },
    async recallRefine() {
      refineCalls += 1
      // 补正本身也要等网络——它不在首 token 路径上，所以这里返回的 promise
      // 没人 await，用例靠 refineCalls 记账而不是靠它 settle。
      await gate
      return true
    },
    async recall() {
      awaitCalls += 1
      await gate
      return '[记忆] await 通道注入'
    },
    enqueueExtraction: () => {},
  }
}

/**
 * 取到流里的第一条事件；若闸门没开就取不到，说明首 token 在等网络。
 *
 * 用竞态而不是 sleep：闸门还关着时 await 路径不可能返回，于是"能拿到"本身就证明了
 * 首 token 没走那条路。
 */
function firstEventWithin<T>(events: AsyncGenerator<T>, ms: number): Promise<IteratorResult<T>> {
  return Promise.race([
    events.next(),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`首 token 等了超过 ${ms}ms：多半是退回了 await 召回`))
      }, ms)
      timer.unref?.()
    }),
  ])
}

/**
 * 取到流里的第一条 text-delta（群聊前面还有调度/派发事件，那不是首 token）。
 *
 * 同样带竞态：整段"读到第一个字"的过程都被闸门卡着的话，这里会超时。
 */
async function firstTextDeltaWithin<T extends { type: string }>(events: AsyncGenerator<T>, ms: number): Promise<T> {
  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`首 token 等了超过 ${ms}ms：多半是退回了 await 召回`))
    }, ms)
    timer.unref?.()
  })
  const read = (async (): Promise<T> => {
    for (;;) {
      const next = await events.next()
      if (next.done === true) throw new Error('事件流在出字之前就结束了')
      if (next.value.type === 'text-delta') return next.value
    }
  })()
  return await Promise.race([read, deadline])
}

describe('生产组合根上的首 token：不等 embedding 那次网络往返', () => {
  it('单聊：SessionCoordinator → AgentLoop，同步注入块在闸门关闭时就进了 system', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(DIRECT_AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const memory = gatedMemory()
    const { llm, systems } = promptRecordingLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [], memory })

    const events = coordinator.chatDirect(conversation.id, 'a1', '周报怎么写', { workspaceRoot: process.cwd() })
    const first = await firstEventWithin(events, 2_000)
    expect(first.value.type).toBe('text-delta')
    // 闸门还关着：首 token 若走了 await 召回，这里根本取不到事件。
    expect(memory.isOpen()).toBe(false)
    expect(memory.awaitCalls()).toBe(0)
    expect(systems[0]).toContain('[记忆] 同步通道注入')
    expect(systems[0]).not.toContain('await 通道注入')

    memory.open()
    for await (const _ of events) {
      /* drain */
    }
    // 补正发生在首 token 之后（异步、不 await），它才是那段网络往返真正的落点。
    expect(memory.refineCalls()).toBe(1)
    store.close()
  })

  it('群聊扇出：GroupDispatcher 的共享召回视图不把同步通道吃掉', async () => {
    const store = new SessionStore(':memory:')
    for (const member of GROUP_MEMBERS) store.upsertAgent(member)
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['ryen', 'bot'],
      dispatcherAgentId: 'ryen',
    })
    const memory = gatedMemory()
    const { llm, systems } = promptRecordingLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [], memory })

    const events = coordinator.chatGroup(conversation.id, '@CodeBot 看一下这个需求', {
      workspaceRoot: process.cwd(),
    })
    const first = await firstTextDeltaWithin(events, 2_000)
    expect(first.type).toBe('text-delta')
    expect(memory.isOpen()).toBe(false)
    expect(memory.awaitCalls()).toBe(0)
    // 每一个发言 agent 的 system 都只能有同步通道那一份：调度器与扇出各包一层，
    // 任何一层漏掉 recallSync，这里就会混进 await 通道的注入块。
    expect(
      systems.filter((system) => {
        return system.includes('同步通道注入')
      }).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      systems.some((system) => {
        return system.includes('await 通道注入')
      }),
    ).toBe(false)

    memory.open()
    for await (const _ of events) {
      /* drain */
    }
    expect(memory.refineCalls()).toBeGreaterThanOrEqual(1)
    store.close()
  })

  it('钩子对象没实现同步通道时退回 await（缺实现不该让对话变慢，但会多等一次网络）', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(DIRECT_AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const memory = gatedMemory()
    // 只保留 await 通道：与"包装器漏掉两段式"之后的形态一致。
    const stripped: AgentMemoryHooks = {
      recall: memory.recall,
      enqueueExtraction: () => {},
    }
    const { llm, systems } = promptRecordingLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [], memory: stripped })

    const events = coordinator.chatDirect(conversation.id, 'a1', '周报怎么写', { workspaceRoot: process.cwd() })
    await expect(firstEventWithin(events, 300)).rejects.toThrow(/首 token/)
    memory.open()
    for await (const _ of events) {
      /* drain */
    }
    // 补正不会发：没走过同步路径就没有需要补的语义通道。
    expect(memory.refineCalls()).toBe(0)
    expect(systems[0]).toContain('[记忆] await 通道注入')
    store.close()
  })
})
