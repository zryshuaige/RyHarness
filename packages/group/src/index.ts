/**
 * RyAgent 群聊调度。
 *
 * 混合模式：@提及直路由 + 调度员自然语言选路（不做单独的结构化路由
 * LLM 调用——调度员正常生成回复，输出中的 @提及即路由信号）。带接力
 * 护栏（maxTurns、连续同 agent 冷却、A-B-A 互踢 loop-guard），每次
 * 路由决策以 dispatch 事件产出，由协调器落 dispatch_events。
 * @module @ryagent/group
 */

export { parseMentions } from './mentions.ts'
export { buildGroupContext, DISPATCHER_ROUTING_SUFFIX, DEFAULT_HISTORY_BUDGET_CHARS, GroupDispatcher } from './dispatcher.ts'
export type { GroupDispatcherOptions, GroupEvent, GroupHistoryEntry } from './dispatcher.ts'
