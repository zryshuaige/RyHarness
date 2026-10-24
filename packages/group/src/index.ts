/**
 * RyHarness 群聊调度。
 *
 * 混合模式：@提及直路由 + 调度员交接工具选路（不做单独的结构化路由
 * LLM 调用——调度员正常生成回复，交接意图走 handoff 工具调用，模型只
 * 在文字里提名字时的 @提及/[交办] 行是兜底信号）。带接力护栏
 * （maxTurns、连续同 agent 冷却、A-B-A 互踢 loop-guard），每次
 * 路由决策以 dispatch 事件产出，由协调器落 dispatch_events。
 * @module @ryharness/group
 */

export type { GroupDispatcherOptions, GroupEvent, GroupHistoryEntry } from './dispatcher.ts'
export {
  buildGroupContext,
  DEFAULT_FANOUT_CONCURRENCY,
  DEFAULT_HISTORY_BUDGET_TOKENS,
  dispatcherRoutingSuffix,
  GroupDispatcher,
  groupTranscriptBlock,
  handoffText,
  memberHandoffSuffix,
} from './dispatcher.ts'
export { parseMentions } from './mentions.ts'
