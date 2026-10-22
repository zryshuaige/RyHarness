/**
 * 扇出共享视图 asHooks 交出的钩子必须保 this：底层记忆可能是类实例（原型方法 +
 * 内部大量 this.*，recallRefine 还有 this 相关的默认参数），裸取出来调用会在进入
 * 函数体之前抛 TypeError。
 *
 * 退化为什么难查：AgentLoop 两处调用都按「记忆故障静默降级」写的
 * （recallMemorySync 的 catch 退回 await、refineMemory 的 catch 吞掉），于是丢 this
 * 不会让对话失败——它只是让记忆悄悄不生效：每个成员的 system 里换成 await 那份块，
 * 首 token 路径上白白多等一次 embedding 网络往返，扇出共享还照常「共享」了个寂寞。
 *
 * 今天没炸只是因为生产上递进来的是包过 bind 的普通对象；这组用例钉在**类实例**上，
 * 那是 @ryharness/memory 的 MemoryService 的真实形态。
 */

import type { AgentDefinition, AgentMemoryHooks } from '@ryharness/agent'
import type { GroupEvent } from '@ryharness/group'
import { GroupDispatcher } from '@ryharness/group'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@ryharness/llm'
import { describe, expect, it } from 'vitest'

function agent(id: string, name: string): AgentDefinition {
  return { id, name, systemPrompt: `你是${name}。`, provider: 'mock', model: 'mock', tools: [] }
}

const MEMBERS = [agent('ryen', 'Ryen'), agent('codebot', 'CodeBot'), agent('reviewer', 'Reviewer')]

/** 记录每个成员实际收到的 system prompt 的假 LLM。 */
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

/** this 相关默认参数的取值（照 MemoryService 的 firstTokenDeadlineMs）。 */
const REFINE_BUDGET_MS = 42

/** 每个钩子被调用时观察到的 this。 */
interface ReceiverLog {
  /** recallSync 调用时的 this（扇出两个成员 = 两条）。 */
  syncRecall: unknown[]
  /** recallRefine 调用时的 this，以及它取到的 this 相关默认参数。 */
  refine: { receiver: unknown; deadlineMs: number }[]
  /** await 通道 recall 调用时的 this。 */
  asyncRecall: unknown[]
  /** enqueueExtraction 调用次数。 */
  extractions: number
}

/**
 * 真实的类实例：四个钩子方法都在原型上，内部读 this 上的状态。
 *
 * 记账数组是闭包变量而不是 this.xxx：方法体第一行就可能因为 this 丢失而抛，记账
 * 必须发生在解引用 this 之前，否则退化时一条痕迹都不留。
 */
function classMemoryDouble(): { memory: AgentMemoryHooks; log: ReceiverLog } {
  const log: ReceiverLog = { syncRecall: [], refine: [], asyncRecall: [], extractions: 0 }
  class ClassMemory implements AgentMemoryHooks {
    /** this 上的字段：原型方法必须能读到它（this 丢失时连读都读不到）。 */
    readonly tag = '类实例记忆'
    /** this 相关的默认参数来源（照 MemoryService 的 firstTokenDeadlineMs）。 */
    readonly refineBudgetMs = REFINE_BUDGET_MS

    recallSync(agentId: string, inputText: string): string | undefined {
      log.syncRecall.push(this)
      return `[记忆:同步:${this.tag}] ${agentId} <- ${inputText}`
    }

    async recallRefine(agentId: string, inputText: string, deadlineMs = this.refineBudgetMs): Promise<boolean> {
      log.refine.push({ receiver: this, deadlineMs })
      return `${agentId}/${inputText}`.length > 0
    }

    async recall(agentId: string, inputText: string): Promise<string> {
      log.asyncRecall.push(this)
      return `[记忆:await:${this.tag}] ${agentId} <- ${inputText}`
    }

    enqueueExtraction(): void {
      log.extractions += 1
    }
  }
  return { memory: new ClassMemory(), log }
}

async function collect(events: AsyncGenerator<GroupEvent>): Promise<GroupEvent[]> {
  const out: GroupEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('FanoutMemory.asHooks：类实例的记忆钩子转交后 this 不丢', () => {
  it('扇出两个成员：同步召回与补正都在原实例上执行，注入块来自同步通道', async () => {
    const { memory, log } = classMemoryDouble()
    const { llm, systems } = promptRecordingLlm()
    const dispatcher = new GroupDispatcher({ llm, members: MEMBERS, dispatcherId: 'ryen', tools: [], memory })

    const events = await collect(
      dispatcher.runTurn({
        text: '@CodeBot @Reviewer 一起看下代码',
        history: [],
        workspaceRoot: process.cwd(),
        turnIndex: 0,
      }),
    )

    // 被 @ 的两个成员各自建一个 AgentLoop，于是同步召回与补正各两条。
    expect(
      events.filter((event) => {
        return event.type === 'agent-message'
      }),
    ).toHaveLength(2)
    expect(log.syncRecall).toEqual([memory, memory])
    expect(log.refine).toEqual([
      { receiver: memory, deadlineMs: REFINE_BUDGET_MS },
      { receiver: memory, deadlineMs: REFINE_BUDGET_MS },
    ])
    // 同步通道成功就不该走 await：这两条一起说明注入块真的来自原型方法。
    expect(log.asyncRecall).toEqual([])
    expect(log.extractions).toBe(2)

    // 每个发言成员的注入块只能来自同步通道。this 一丢，recallSync 在进入函数体之前
    // 抛 TypeError，再被 AgentLoop 的 catch 吞成「退回 await」——发言照常产出。
    const speaking = systems.filter((system) => {
      return system.includes('你是CodeBot') || system.includes('你是Reviewer')
    })
    expect(speaking).toHaveLength(2)
    expect(
      speaking.every((system) => {
        return system.includes('[记忆:同步:类实例记忆]')
      }),
    ).toBe(true)
    expect(
      speaking.some((system) => {
        return system.includes('[记忆:await')
      }),
    ).toBe(false)
  })
})
