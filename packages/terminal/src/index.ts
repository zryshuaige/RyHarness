/**
 * `@ryharness/terminal` —— 让助理能**保持交互式 shell / REPL 会话活着**。
 *
 * 一次性命令（跑完就退出）和持久会话是两回事：后者的价值在于**跨多次工具调用
 * 保留状态**——工作目录、环境变量、已经起着的子进程都还在。
 *
 * 这一族分两层：
 *
 * - {@link TerminalService}：会话归谁、别人能不能碰、关的时候有没有等干净。
 * - {@link TerminalBackend}（本包自带 {@link LocalShellBackend}）：怎么把 shell 起
 *   起来、怎么知道它真的就绪了、怎么把输出读出来。
 *
 * **边界先说清楚**：本包的本地后端走**管道模式**，不是真 PTY（node-pty 是原生模块，
 * 本项目不引）。因此不能跑 vim/top 这类全屏交互程序；管道模式下也没有 tty 的行
 * 规程，所以 Ctrl-C 不是靠写 `\x03` 实现的，而是去终止前台那个命令进程。
 * 详见 README。
 *
 * @module @ryharness/terminal
 */

export type { TerminalBufferOptions } from './buffer.ts'
export { DEFAULT_BUFFER_MAX_BYTES, DEFAULT_MAX_READ_BYTES, TerminalBuffer } from './buffer.ts'
export type { TerminalErrorCode } from './errors.ts'
export { isTerminalError, TerminalError } from './errors.ts'
export type { LocalShellBackendOptions } from './local.ts'
export { LocalShellBackend, PIPE_MODE_CAPABILITIES, shellCandidates } from './local.ts'
export type { TerminalServiceOptions } from './service.ts'
export { TerminalService } from './service.ts'
export type { ProcessTree, ShellDialect } from './shell.ts'
export {
  BASH_DIALECT,
  CD_FAILED_MARKER,
  dialectOf,
  findDescendantPids,
  isBashStartupNoise,
  isConsoleHost,
  isInputEcho,
  normalizeShellPath,
  PWSH_DIALECT,
  runCapture,
  shellQuote,
  stripAnsi,
} from './shell.ts'
export type {
  TerminalBackend,
  TerminalBackendCapabilities,
  TerminalBackendSession,
  TerminalBackendSpec,
  TerminalCreateRequest,
  TerminalOwner,
  TerminalReadResult,
  TerminalSession,
  TerminalSessionState,
  TerminalShellDialect,
  TerminalTruncationReason,
} from './types.ts'
