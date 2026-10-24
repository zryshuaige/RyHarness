/**
 * 轮次事件的归一与翻译：单聊（AgentLoop 事件）与群聊（调度器事件）先归一为
 * 同一中间形状 {@link TurnEvent}，再走**唯一一个** switch 发布 WsEvent。
 *
 * 拆分前这是两套近乎同构的 switch（单聊/群聊各一份，text-delta / tool-call-start
 * / tool-result / produce-card / message-done / error 各写一遍）：新增一种 WS 事件
 * 要同步改两处，漏一处单聊/群聊行为就分叉。现在归一层只负责补「发言者是谁」
 * （单聊固定一个 agent、群聊按事件的 agentId 惰性开气泡），翻译层只见统一形状。
 * seq 顺序、事件字段、错误/取消路径、produce-card 的落库（协调器随 tool-result
 * 一起写）与推送时机都与拆分前逐事件等价。
 * @module @ryharness/server/turn-events
 */

import type { AgentLoopEvent, ToolResult } from '@ryharness/agent'
import type { SessionCoordinator, StoredUsage } from '@ryharness/session'
import type { WsEvent } from './events.ts'
import type { TurnStatus } from './telemetry.ts'

/** 从异步生成器的类型里取它 yield 的事件类型。 */
type YieldOf<Stream> = Stream extends AsyncGenerator<infer TEvent> ? TEvent : never

/**
 * 群聊事件：协调器 chatGroup 的产出类型。
 *
 * 从 SessionCoordinator 的方法上取型而不是 import `@ryharness/group`：server 的
 * package.json 没有声明那个包（群事件本来就经协调器透传进来），为一条 type-only
 * 引用新增依赖面不划算。
 */
export type GroupStreamEvent = YieldOf<ReturnType<SessionCoordinator['chatGroup']>>

/**
 * 统一中间形状：单聊/群聊的协调器事件都先归一成它，翻译层只见这一种。
 *
 * 除 `dispatch` 自带轮次号外，序号相关信息都在轮次状态里（见
 * {@link TurnTranslationState}）：事件只回答「谁、说了什么」。
 */
export type TurnEvent =
  | { type: 'message-start'; senderId: string; senderName: string }
  | { type: 'text-delta'; senderId: string; text: string }
  | { type: 'tool-call-start'; senderId: string; callId: string; name: string; arguments: string }
  | { type: 'tool-result'; senderId: string; callId: string; name: string; isError: boolean; result: ToolResult }
  | { type: 'message-done'; senderId: string }
  | { type: 'dispatch'; fromAgent?: string; toAgent: string; reason: string; turnIndex: number }
  | { type: 'error'; message: string; code: string }

/**
 * 单聊归一层：整轮只有一个发言者，`message-start` 在消费事件流**之前**就发出
 * （拆分前它同样是开跑前发布、气泡先记在册）；`done` 收口同一个人。
 *
 * 包装成生成器而不是逐事件映射函数，正是为了保住这个先后关系：包装器第一次被
 * 拉取时先 yield message-start、还不会去拉底层协调器流——发布顺序与拆分前一致。
 */
export async function* normalizeDirectEvents(
  stream: AsyncIterable<AgentLoopEvent>,
  agentId: string,
  /** 发言者显示名：调用方在开跑那一刻查一次（与拆分前同时机）。 */
  senderName: string,
): AsyncGenerator<TurnEvent> {
  yield { type: 'message-start', senderId: agentId, senderName }
  for await (const event of stream) {
    switch (event.type) {
      case 'text-delta':
        yield { type: 'text-delta', senderId: agentId, text: event.text }
        break
      case 'tool-call-start':
        yield {
          type: 'tool-call-start',
          senderId: agentId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        }
        break
      case 'tool-result':
        yield {
          type: 'tool-result',
          senderId: agentId,
          callId: event.callId,
          name: event.name,
          isError: event.isError,
          result: event.result,
        }
        break
      case 'done':
        yield { type: 'message-done', senderId: agentId }
        break
      case 'error':
        yield { type: 'error', message: event.message, code: event.code }
        break
      default:
        break
    }
  }
}

/**
 * 群聊归一层：成员第一次开口（文本 / 工具 / 发言）才开气泡，`message-start`
 * 惰性发出且每个成员整轮只发一次；dispatch 是派工信号、error 不属于任何成员，
 * 都不开气泡。调度器自己的收工事件（turn-done）在这里丢弃——拆分前它落在 switch
 * 的 default 里被忽略，不进翻译层。
 *
 * @param senderNameOf 发言者显示名：事件时刻现查（与拆分前 ensureStart 里
 *   `store.getAgent` 的时机一致——归一与翻译之间没有 await，同一事件环内）。
 */
export async function* normalizeGroupEvents(
  stream: AsyncIterable<GroupStreamEvent>,
  senderNameOf: (agentId: string) => string,
): AsyncGenerator<TurnEvent> {
  /** 已开过气泡的成员：保证每个成员的 message-start 只发一次。 */
  const started = new Set<string>()
  for await (const event of stream) {
    // 带 agentId 的事件 = 成员真的开口了：第一次开口补一条 message-start。
    // 「谁在成员名单里」由协调器决定，这里只看事件形状（chatGroup 侧判「这位
    // 成员跑过了」用的也是同一个 `'agentId' in event` 口径）。
    if ('agentId' in event) {
      const { agentId } = event
      if (!started.has(agentId)) {
        started.add(agentId)
        yield { type: 'message-start', senderId: agentId, senderName: senderNameOf(agentId) }
      }
    }
    switch (event.type) {
      case 'dispatch':
        yield {
          type: 'dispatch',
          ...(event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent }),
          toAgent: event.toAgent,
          reason: event.reason,
          turnIndex: event.turnIndex,
        }
        break
      case 'text-delta':
        yield { type: 'text-delta', senderId: event.agentId, text: event.text }
        break
      case 'tool-call-start':
        yield {
          type: 'tool-call-start',
          senderId: event.agentId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        }
        break
      case 'tool-result':
        yield {
          type: 'tool-result',
          senderId: event.agentId,
          callId: event.callId,
          name: event.name,
          isError: event.isError,
          result: event.result,
        }
        break
      case 'agent-message':
        yield { type: 'message-done', senderId: event.agentId }
        break
      case 'error':
        yield { type: 'error', message: event.message, code: event.code }
        break
      default:
        break
    }
  }
}

/**
 * 翻译层的轮次状态：runTurn 持有一份、逐事件传给翻译器；catch / finally 也读
 * 同一份收口（中止补写 status、兜底 message-done 读 openBubbles 与 usage）。
 */
export interface TurnTranslationState {
  readonly conversationId: string
  /**
   * 本轮的轮次序号：message-start 与 message-done 必须发同一个值，渲染层按
   * (senderId, turnIndex) 认领流式气泡，两端对不上就永远收不了口。
   */
  readonly turnIndex: number
  /** 会话形态：群聊的 error 事件才把失败原因带给 RyVibe（见翻译器的 error 分支）。 */
  readonly kind: 'direct' | 'group'
  /** 已开气泡、还没收口的发言者：message-start 进、message-done 出，finally 兜底收口。 */
  readonly openBubbles: Set<string>
  /** 本轮累计用量：协调器的出账回调更新，message-done 带上（缺省不带字段）。 */
  usage: StoredUsage | undefined
  /** 轮次结局：error 事件置 'error'，中止/异常由 runTurn 的 catch 续写。 */
  status: TurnStatus
  /** 失败的一句人话原因（给 RyVibe 页面看的）。 */
  failureReason: string | undefined
}

/** 翻译层的出口：发布一条 WS 事件 + 首 token 打点。 */
export interface TurnTranslationSink {
  publish: (event: WsEvent) => void
  markFirstToken: () => void
}

/**
 * 绑定轮次状态的翻译器：内部就是**唯一那个** switch（统一事件 → WsEvent 发布
 * 与轮次记账）。新增一种 WS 事件只改这里（外加归一层一处映射），单聊/群聊不再
 * 各写一份。
 */
export function createTurnTranslator(
  state: TurnTranslationState,
  sink: TurnTranslationSink,
): (event: TurnEvent) => void {
  return (event) => {
    const { conversationId, turnIndex } = state
    switch (event.type) {
      case 'message-start':
        state.openBubbles.add(event.senderId)
        sink.publish({
          type: 'message-start',
          conversationId,
          senderId: event.senderId,
          senderName: event.senderName,
          turnIndex,
        })
        break
      case 'text-delta':
        // 第一个文本增量即「用户开始看到字」：首 token 延迟从这里起算。
        sink.markFirstToken()
        sink.publish({ type: 'text-delta', conversationId, senderId: event.senderId, text: event.text })
        break
      case 'tool-call-start':
        sink.publish({
          type: 'tool-call-start',
          conversationId,
          senderId: event.senderId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
        })
        break
      case 'tool-result':
        sink.publish({
          type: 'tool-result',
          conversationId,
          senderId: event.senderId,
          callId: event.callId,
          name: event.name,
          isError: event.isError,
          content: event.result.content,
        })
        // 产物卡片紧跟工具结果推送（落库由协调器随 tool-result 一起写，见
        // coordinator 的 appendMessage artifacts）：实时渲染与历史回看才有同一份产物。
        if (event.result.produce !== undefined) {
          sink.publish({
            type: 'produce-card',
            conversationId,
            senderId: event.senderId,
            callId: event.callId,
            card: event.result.produce,
          })
        }
        break
      case 'message-done':
        state.openBubbles.delete(event.senderId)
        sink.publish({
          type: 'message-done',
          conversationId,
          senderId: event.senderId,
          turnIndex,
          ...(state.usage === undefined ? {} : { usage: state.usage }),
        })
        break
      case 'dispatch':
        // turnIndex 用派工事件自带的轮次号（调度器记录 dispatch_events 用的那个），
        // 不是本轮预占的号——拆分前就是这么发的。
        sink.publish({
          type: 'dispatch',
          conversationId,
          ...(event.fromAgent === undefined ? {} : { fromAgent: event.fromAgent }),
          toAgent: event.toAgent,
          reason: event.reason,
          turnIndex: event.turnIndex,
        })
        break
      case 'error':
        state.status = 'error'
        // 群聊错误才喂 RyVibe 失败原因：小队会话都是群会话，而拆分前单聊的
        // error 分支就不写这条——原样保留两套行为的差异，零行为变化。
        if (state.kind === 'group') state.failureReason = event.message
        sink.publish({ type: 'error', conversationId, message: event.message, code: event.code })
        break
    }
  }
}
