/**
 * RyHarness 的斜杠命令：人敲 `/命令`，直接触发动作，不花模型一轮。
 *
 * 两块东西：
 * - **注册表**（{@link CommandRegistry}）：登记命令、给界面补全、执行一行输入。
 *   命令名唯一，重名直接报错——静默覆盖会让用户敲了命令却跑了另一个。
 * - **解析**（{@link parseCommandLine}）：斜杠必须在第一个字节，命令名后面要么到
 *   行尾、要么是空白。认不出来就明说「这不是命令」。
 *
 * 本包**不碰模型、不碰会话历史**：命令跑完的结果怎么显示、要不要进历史，都
 * 是宿主的事。
 * @module @ryharness/commands
 */

export type { CommandErrorCode } from './errors.ts'
export { CommandError, describeCommandFailure } from './errors.ts'
export { isCommandName, type ParsedCommand, parseCommandLine } from './parse.ts'
export { CommandRegistry } from './registry.ts'
export type {
  CommandArgs,
  CommandArtifact,
  CommandDefinition,
  CommandExecution,
  CommandResult,
  CommandSummary,
} from './types.ts'
export { COMMAND_NAME_PATTERN } from './types.ts'
