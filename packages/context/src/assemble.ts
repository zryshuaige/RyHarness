/**
 * 统一装配：把几块上下文拼成一组 user 消息。
 * @module @ryharness/context/assemble
 */

import { collectFileReferences } from './file-refs.ts'
import { loadWorkspaceInstructions } from './instructions.ts'
import type { SessionSnapshotSource } from './session-snapshot.ts'
import { buildSessionSnapshot } from './session-snapshot.ts'
import { buildTimeContext } from './time.ts'
import type { ContextBlockConfig, ContextLimits, ContextMessage } from './types.ts'
import { DEFAULT_CONTEXT_BLOCKS, DEFAULT_CONTEXT_LIMITS } from './types.ts'

/** 装配的参数。 */
export interface ContextAssemblyOptions {
  /** 工作区根：指令文件与 @文件引用都按它划边界。 */
  workspaceRoot: string
  /** 本轮用户输入：@文件引用从里面解析。 */
  userText?: string
  /** 当前会话 id：跨会话快照要排除它。 */
  conversationId?: string
  /** 明确引用的另一个会话 id。 */
  referenceConversationId?: string
  /** 跨会话快照的数据源；没有它就没有这一块。 */
  snapshotSource?: SessionSnapshotSource
  /** 每块的开关。 */
  blocks?: Partial<ContextBlockConfig>
  /** 各类上限。 */
  limits?: Partial<ContextLimits>
  /** 取当前时间的方式。 */
  now?: () => Date
  /** 时区（IANA 名）。 */
  timeZone?: string
  /** 指令文件的候选名。 */
  instructionFiles?: readonly string[]
}

/**
 * 装配这一轮要注入的上下文。
 *
 * 顺序固定为：项目指引 → 当前时间 → @文件 → 另一个会话的近况。
 * 顺序为什么固定：重放同一轮时装出的块必须前后一致，否则历史对不上；
 * 指引排最前，是因为它讲的是「规矩」，模型读后面几块时得先知道规矩。
 * @param options - 装配参数。
 * @returns 注入消息（每块至多一条，装不出内容的块不出现）。
 */
export function assembleContext(options: ContextAssemblyOptions): ContextMessage[] {
  const blocks: ContextBlockConfig = { ...DEFAULT_CONTEXT_BLOCKS, ...options.blocks }
  const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...options.limits }
  const messages: ContextMessage[] = []

  if (blocks['workspace-instructions']) {
    const instruction = loadWorkspaceInstructions({
      workspaceRoot: options.workspaceRoot,
      fileNames: options.instructionFiles,
      maxChars: limits.instructionsMaxChars,
    })
    if (instruction !== undefined) {
      messages.push({ role: 'user', kind: 'workspace-instructions', text: instruction.text })
    }
  }

  if (blocks.time) {
    const time = buildTimeContext({ now: options.now, timeZone: options.timeZone })
    messages.push({ role: 'user', kind: 'time', text: time.text })
  }

  if (blocks['file-references'] && options.userText !== undefined) {
    const references = collectFileReferences({
      workspaceRoot: options.workspaceRoot,
      text: options.userText,
      maxCharsPerFile: limits.fileMaxChars,
      maxTotalChars: limits.filesTotalMaxChars,
      maxFiles: limits.maxFileRefs,
    })
    if (references !== undefined) {
      messages.push({ role: 'user', kind: 'file-references', text: references.text })
    }
  }

  if (blocks['session-snapshot'] && options.snapshotSource !== undefined) {
    const snapshot = buildSessionSnapshot({
      source: options.snapshotSource,
      conversationId: options.referenceConversationId,
      currentConversationId: options.conversationId,
      maxMessages: limits.snapshotMaxMessages,
      maxChars: limits.snapshotMaxChars,
    })
    if (snapshot !== undefined) {
      messages.push({ role: 'user', kind: 'session-snapshot', text: snapshot.text })
    }
  }

  return messages
}
