/**
 * RyHarness 循环卫生与崩溃恢复。
 *
 * 两件事：
 *   1. **guard**——重复工具调用提醒（模型原样重发同一条调用时提醒它换做法）与单次工具
 *      调用超时（工具声明了 `timeoutMs` 就按时限收掉，别让它一直挂着）。
 *   2. **checkpoint**——把「这一轮打算做什么」「工具调用的请求与结果」按顺序写下去，
 *      崩了能读回来继续：调用与结果先落盘，再进历史。
 *
 * 本包**不碰存储层与 agent 循环**：它给的是挂点与契约，装配（谁在什么时候调用它、
 * checkpoint 文件放哪）由宿主决定。
 * @module @ryharness/guard
 */

export type {
  CheckpointCall,
  CheckpointedToolCall,
  CheckpointJournalOptions,
  CheckpointRecord,
  CheckpointRecovery,
  CheckpointResult,
  CheckpointTurnEnd,
  CheckpointTurnStart,
  UnfinishedCall,
} from './checkpoint.ts'
export {
  CheckpointJournal,
  defaultCheckpointPath,
  readCheckpointRecords,
  recoverCheckpoint,
  runCheckpointedToolCall,
} from './checkpoint.ts'
export type { RepeatToolCall, RepeatToolReminderOptions, RepeatVerdict } from './repeat.ts'
export { DEFAULT_MAX_REMINDERS, RepeatToolReminder, repeatReminderText } from './repeat.ts'
export type { GuardToolResult, TimeoutOutcome, TimeoutRunOptions, TimeoutStatus } from './timeout.ts'
export { resolveToolTimeoutMs, runToolWithTimeout, toolAbortedMessage, toolTimeoutMessage } from './timeout.ts'
