/**
 * RyHarness 子进程服务：全仓库跑起来的每一个子进程都从这一处启动、观测、终止。
 *
 * 覆盖的是 bash 命令、语言服务器、持久 shell、进程外子代理后端——它们在别的包
 * 里各有各的语义，但「怎么被启动、怎么被观测、怎么被收掉」是同一件事，
 * 所以收在这里做一处。
 *
 * 三层分工：
 * - **provider**（{@link SubprocessProvider}）：真正把进程跑起来的那一层，并如实
 *   汇报自己做不到什么。本机实现是 {@link LocalSubprocessProvider}。
 * - **service**（{@link SubprocessService}）：默认值、进程登记、整体收尾。
 * - **process range**（{@link ProcessRange}）：一组进程归谁管，能整体查活、整体终止。
 *
 * 本包**不做**两件事，理由写在 README 里：Win32 原生绑定（Job Object、受限令牌）
 * 要原生代码；真正的 PTY 归 `packages/terminal`。
 * @module @ryharness/subprocess
 */

export type { ScrubbedEnvironment, ScrubEnvironmentOptions } from './env.ts'
export { DEFAULT_ENV_ALLOWLIST, DEFAULT_SECRET_NAME_PATTERN, scrubEnvironment } from './env.ts'
export { resolveExecutable, WINDOWS_EXECUTABLE_EXTENSIONS } from './executable.ts'
export type { LocalSubprocessProviderOptions } from './local.ts'
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  KILL_GRACE_MS,
  LocalSubprocessProvider,
  localCapabilities,
  localProvider,
  spawnManaged,
} from './local.ts'
export type { CreateProcessRangeOptions } from './range.ts'
export { createProcessRange } from './range.ts'
export type { SubprocessServiceOptions } from './service.ts'
export { SubprocessService } from './service.ts'
export type {
  ExecutableResolution,
  ManagedProcess,
  ManagedRangeSupport,
  ProcessRange,
  ResolveExecutableOptions,
  SubprocessCapabilities,
  SubprocessError,
  SubprocessErrorCode,
  SubprocessProvider,
  SubprocessResult,
  SubprocessSpawnOptions,
  SubprocessStatus,
  TreeKillStrategy,
} from './types.ts'
