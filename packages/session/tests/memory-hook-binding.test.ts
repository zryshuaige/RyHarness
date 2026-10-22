/**
 * 记忆钩子转交时的 this 语义：包装层必须 `.bind(memory)`，否则类实例的原型方法
 * 在**进入函数体之前**就抛 TypeError。
 *
 * 退化为什么难查：AgentLoop 那两处调用都按「记忆故障静默降级」写的
 * （recallMemorySync 的 catch 退回 await 路径、refineMemory 的 catch 直接吞掉），
 * 于是丢 this 不会让对话失败——它只是让记忆悄悄不生效：system 里换成 await 那份
 * 块，首 token 路径上白白多等一次 embedding 网络往返，而且没有任何错误冒到日志上。
 *
 * 今天没炸只是因为 apps/server 递进来的是包过 bind 的普通对象（方法已是自有属性，
 * 裸取不丢 this）。这组用例钉在**类实例**上：那才是 @ryharness/memory 的 MemoryService
 * 的真实形态（原型方法 + 内部大量 this.*，recallRefine 还有 this 相关的默认参数），
 * 也是唯一能把丢 this 暴露出来的形态。
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

/** this 相关默认参数的取值（照 MemoryService 的 firstTokenDeadlineMs）。 */
const REFINE_BUDGET_MS = 42

/** 每个钩子被调用时观察到的 this（方法级记账，退化时与正确调用可区分）。 */
interface ReceiverLog {
  /** recallSync 调用时的 this。 */
  syncRecall: unknown[]
  /** recallRefine 调用时的 this，以及它取到的 this 相关默认参数。 */
  refine: { receiver: unknown; deadlineMs: number }[]
  /** await 通道 recall 调用时的 this。 */
  asyncRecall: unknown[]
  /** enqueueExtraction 收到的 conversationId（由包装层注入）。 */
  extractions: { agentId: string; conversationId: string }[]
}

interface MemoryDouble {
  memory: AgentMemoryHooks
  log: ReceiverLog
}

/**
 * 一个**真实的类实例**：四个钩子方法都在原型上，内部读 this 上的状态。
 *
 * 形态照 @ryharness/memory 的 MemoryService 对齐：`recallSync` 直接读 this 的索引与
 * 预算，`recallRefine` 的第三个参数是 this 相关的默认参数
 * （`deadlineMs = this.refineBudgetMs`）——this 丢了连默认参数都求不出来，异常抛在
 * 函数体第一行之前。
 *
 * 记账数组刻意是闭包变量而不是 this.xxx：方法体第一行就可能因为 this 丢失而抛，
 * 记账必须发生在**解引用 this 之前**，否则退化时一条痕迹都不留。
 * @param options.sync - 缺省时实现同步通道；传 false 得到只实现 await 通道的同款实例。
 */
function classMemoryDouble(options: { sync?: boolean } = {}): MemoryDouble {
  const log: ReceiverLog = { syncRecall: [], refine: [], asyncRecall: [], extractions: [] }
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

    enqueueExtraction(agentId: string, _agentName: string, conversationId: string): void {
      log.extractions.push({ agentId, conversationId })
    }
  }

  /** 只实现 await 通道的同款类实例：钩子形状上 recallSync 缺席，循环据此退回 await。 */
  class AwaitOnlyClassMemory implements AgentMemoryHooks {
    readonly tag = '类实例记忆'

    async recall(agentId: string, inputText: string): Promise<string> {
      log.asyncRecall.push(this)
      return `[记忆:await:${this.tag}] ${agentId} <- ${inputText}`
    }

    enqueueExtraction(agentId: string, _agentName: string, conversationId: string): void {
      log.extractions.push({ agentId, conversationId })
    }
  }

  const memory = options.sync === false ? new AwaitOnlyClassMemory() : new ClassMemory()
  return { memory, log }
}

async function drain(events: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

describe('bindMemory：类实例的记忆钩子转到协调器后 this 不丢', () => {
  it('单聊：同步召回、补正、await 召回、抽取入队四个钩子都在原实例上执行', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(DIRECT_AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { memory, log } = classMemoryDouble()
    const { llm, systems } = promptRecordingLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [], memory })

    await drain(coordinator.chatDirect(conversation.id, 'a1', '周报怎么写', { workspaceRoot: process.cwd() }))

    // 钩子被调用时的 this 必须还是那个实例：绑错了（或没绑）这里记到的就是 undefined。
    expect(log.syncRecall).toEqual([memory])
    expect(log.refine).toEqual([{ receiver: memory, deadlineMs: REFINE_BUDGET_MS }])
    // 同步通道成功就不该走 await：这两条一起说明注入块真的来自原型方法。
    expect(log.asyncRecall).toEqual([])
    expect(log.extractions).toEqual([{ agentId: 'a1', conversationId: conversation.id }])

    // 注入块只能来自同步通道。this 一丢，recallSync 在进入函数体之前抛 TypeError，
    // 再被 AgentLoop 的 catch 吞成「退回 await」——对话照常跑完，只是记忆静默失效。
    expect(systems[0]).toContain('[记忆:同步:类实例记忆]')
    expect(systems[0]).not.toContain('[记忆:await')
    store.close()
  })

  it('单聊：只实现 await 通道时，recall 的 this 同样正确（降级路径也不能丢）', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(DIRECT_AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { memory, log } = classMemoryDouble({ sync: false })
    const { llm, systems } = promptRecordingLlm()
    const coordinator = new SessionCoordinator({ store, llm, tools: [], memory })

    await drain(coordinator.chatDirect(conversation.id, 'a1', '周报怎么写', { workspaceRoot: process.cwd() }))

    expect(log.asyncRecall).toEqual([memory])
    expect(log.syncRecall).toEqual([])
    expect(log.extractions).toEqual([{ agentId: 'a1', conversationId: conversation.id }])
    expect(systems[0]).toContain('[记忆:await:类实例记忆]')
    store.close()
  })
})
