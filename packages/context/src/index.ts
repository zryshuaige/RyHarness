/**
 * RyHarness 上下文装配：把「模型看不见但应该知道」的信息装进请求。
 *
 * 四块：工作区指令文件（AGENTS.md 之类）、用户消息里的 @文件引用、当前时间、
 * 另一个会话的近况快照。装配结果是**一组 user 角色的消息**——注入内容以用户
 * 消息进历史，于是它能落库、能重放、能被压缩，和普通对话内容走同一套生命周期
 * （上游 dsh 的同一口径）。
 *
 * 本包不碰存储也不碰请求组装：跨会话快照的数据源由宿主实现成
 * {@link SessionSnapshotSource}，装出来的消息由宿主决定放哪儿。
 * @module @ryharness/context
 */

export type { ContextAssemblyOptions } from './assemble.ts'
export { assembleContext } from './assemble.ts'
export type { FileReferenceBlock, FileReferenceEntry, FileReferenceOptions } from './file-refs.ts'
export { collectFileReferences, parseFileMentions } from './file-refs.ts'
export type { InstructionBlock, InstructionOptions } from './instructions.ts'
export { DEFAULT_INSTRUCTION_FILES, loadWorkspaceInstructions } from './instructions.ts'
export type {
  SessionSnapshotBlock,
  SessionSnapshotOptions,
  SessionSnapshotSource,
  SnapshotMessage,
  SnapshotSession,
} from './session-snapshot.ts'
export { buildSessionSnapshot } from './session-snapshot.ts'
export type { TimeBlock, TimeContextOptions } from './time.ts'
export { buildTimeContext } from './time.ts'
export type { ContextBlockConfig, ContextBlockKind, ContextLimits, ContextMessage } from './types.ts'
export { contextContentBlocks, DEFAULT_CONTEXT_BLOCKS, DEFAULT_CONTEXT_LIMITS } from './types.ts'
export type { WorkspaceFile, WorkspaceFileKind } from './workspace.ts'
export { isInsideWorkspace, resolveWorkspaceFile } from './workspace.ts'
