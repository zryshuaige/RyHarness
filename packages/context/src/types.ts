/**
 * 上下文装配的公共类型：注入块的种类、消息形状、各类上限。
 * @module @ryharness/context/types
 */

/** 注入块的种类：一块对应一件「模型看不见但应该知道」的事。 */
export type ContextBlockKind = 'workspace-instructions' | 'file-references' | 'time' | 'session-snapshot'

/**
 * 一条注入消息。
 *
 * 角色固定是 user：注入的内容以用户消息进历史，于是它能落库、能重放、能被压缩，
 * 和普通对话内容走同一套生命周期（上游 dsh 的同一口径）。
 * 副作用是注入块会留在历史里——重放同一轮时得装出同样的块，否则历史对不上。
 */
export interface ContextMessage {
  readonly role: 'user'
  /** 哪一块装配出来的（宿主可按类过滤或跳过）。 */
  readonly kind: ContextBlockKind
  /** 模型看到的正文。 */
  readonly text: string
}

/** 每块上下文的开关。 */
export interface ContextBlockConfig {
  /** 工作区指令文件（AGENTS.md 之类）。默认开。 */
  'workspace-instructions': boolean
  /** 用户消息里的 @文件引用。默认开。 */
  'file-references': boolean
  /** 当前时间。默认开。 */
  time: boolean
  /** 另一个会话的近况快照。默认关：它把别的会话带进来，得由宿主明确要。 */
  'session-snapshot': boolean
}

/** 各类上限（字符数 / 条数）。 */
export interface ContextLimits {
  /** 指令文件最多保留多少字符。 */
  instructionsMaxChars: number
  /** 单个 @文件最多保留多少字符。 */
  fileMaxChars: number
  /** 所有 @文件加起来最多多少字符。 */
  filesTotalMaxChars: number
  /** 最多装配几个 @文件。 */
  maxFileRefs: number
  /** 快照最多取几条消息。 */
  snapshotMaxMessages: number
  /** 快照正文最多多少字符。 */
  snapshotMaxChars: number
}

/** 默认上限。 */
export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  instructionsMaxChars: 8_000,
  fileMaxChars: 4_000,
  filesTotalMaxChars: 12_000,
  maxFileRefs: 8,
  snapshotMaxMessages: 8,
  snapshotMaxChars: 2_000,
}

/** 默认开关。 */
export const DEFAULT_CONTEXT_BLOCKS: ContextBlockConfig = {
  'workspace-instructions': true,
  'file-references': true,
  time: true,
  'session-snapshot': false,
}

/**
 * 注入消息转成模型侧的内容块。
 *
 * 宿主落库（content_blocks）或组装请求时用这个，不必各写一遍形状。
 * @param message - 一条注入消息。
 * @returns 单个文本块：注入内容都是纯文本。
 */
export function contextContentBlocks(message: ContextMessage): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: message.text }]
}
