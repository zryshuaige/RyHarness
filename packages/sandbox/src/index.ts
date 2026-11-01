/**
 * RyHarness 沙箱：助理的权限在执行层的口径。
 *
 * 三块：
 * - **契约与策略**（{@link SandboxPolicy}）：模式从哪儿来（会话覆盖 > 助理档位 >
 *   部署默认值）、一次操作能不能做。
 * - **本地后端**（{@link confine}）：把进程关进模式允许的范围。POSIX 上是 bubblewrap
 *   的内核级隔离，Windows 上是围栏（强度写在 `kernelLevel` 上，别混为一谈）。
 * - **提权词汇**：被拦下的操作可以交给宿主去问用户，批了就以全权跑一次。
 *
 * 本包不碰存储、不碰请求组装，也不认识 agent 与会话——它只回答「这次能不能做、
 * 该怎么跑」。
 * @module @ryharness/sandbox
 */

export type { Confinement, ConfinementInput } from './local.ts'
export {
  bubblewrapAvailable,
  bubblewrapConfinement,
  confine,
  ENV_ALLOWLIST,
  fenceConfinement,
  findOutsideWriteTarget,
  scrubEnv,
} from './local.ts'
export type { SandboxContext, SandboxPolicyOptions } from './policy.ts'
export { SandboxPolicy } from './policy.ts'
export type {
  PermissionTier,
  SandboxDecision,
  SandboxMode,
  SandboxOperation,
  SandboxRequest,
} from './types.ts'
export { isSandboxMode, modeForTier, SANDBOX_MODES } from './types.ts'
