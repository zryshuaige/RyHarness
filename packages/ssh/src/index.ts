/**
 * RyHarness 远程 POSIX 能力：在另一台 POSIX 机器上跑命令、读写文件。
 *
 * 三块：
 * - **连接契约**（{@link SshConnection}）：有哪些操作、失败长什么样。宿主可以自己实现。
 * - **命令行后端**（{@link CliSshConnection}）：用本机的 `ssh` 可执行文件跑远程命令，
 *   不引 ssh2 这类原生模块。
 * - **边界**（{@link resolveRemotePath} / {@link validateSshHost}）：路径默认关在远端根目录里，
 *   主机名不许被当成 ssh 选项注入，凭据不进 argv。
 *
 * 本包**不碰**凭据管理、端口转发与长连接：凭据由宿主给，端口转发不做，命令行后端每次
 * 操作起一个 ssh 进程。
 * @module @ryharness/ssh
 */

export type { CliSshConnectionOptions, SshRawRun } from './cli.ts'
export {
  CliSshConnection,
  classifyRemoteFailure,
  DEFAULT_MAX_OUTPUT_BYTES,
  errorCode,
  SSH_ENV_ALLOWLIST,
} from './cli.ts'
export type { SshErrorCode } from './errors.ts'
export { isSshError, SshError } from './errors.ts'
export type { SshTarget } from './host.ts'
export { buildSshTarget, userFromHost, validateSshHost } from './host.ts'
export { isInsideRoot, normalizeRemotePath, resolveRemotePath } from './paths.ts'
export type { SshSpawnFn } from './process.ts'
export { defaultSpawn, killProcessTree } from './process.ts'
export type { Base64DecodeFlag } from './remote.ts'
export {
  buildListCommand,
  buildReadCommand,
  buildWriteCommand,
  decodeBase64Payload,
  parseListOutput,
  shellQuote,
} from './remote.ts'
export type {
  SshAgentCredential,
  SshCommandOptions,
  SshConnection,
  SshConnectionConfig,
  SshCredential,
  SshExecResult,
  SshFileEntry,
  SshHostKeyPolicy,
  SshKeyCredential,
  SshPasswordCredential,
  SshReadOptions,
  SshWriteOptions,
} from './types.ts'
