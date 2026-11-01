/**
 * 沙箱模式：助理的权限在**执行层**的口径。
 *
 * 上游 dsh 把这件事拆成四层：服务契约（模式与逐次调用的策略）、平台后端
 * （Linux bwrap→Landlock、macOS Seatbelt、Windows 受限令牌）、共享策略（部署默认值 +
 * 每会话覆盖）、Windows 写限制。我们这轮补前三层，第四层的 Windows 部分说清边界。
 *
 * 三个模式（与 `@ryharness/agent` 的权限档位一一对应）：
 * - `read-only`：只读。写文件与执行命令都不行。
 * - `workspace-write`：工作区可写。命令可以跑，但被关在工作区里。
 * - `full-access`：不设围栏（命令仍然逐条要人点头）。
 *
 * 「关在工作区里」这句话的分量要说清楚：**POSIX 上是内核级隔离**（bwrap 把根目录
 * 只读挂载、只把工作区挂成可写），**Windows 上目前只是围栏**（清空环境 + 限定工作
 * 目录 + 拦截明显的越界写目标）——真正的内核边界要受限令牌/AppContainer，那需要原生
 * 代码，安装包里不打算背这个。哪一档是什么强度，写在 `Confinement.kernelLevel` 上，
 * 别让界面显示成同一种样子。
 * @module @ryharness/sandbox/types
 */

/** 沙箱模式。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'full-access'

/** 全部沙箱模式（界面下拉、接口校验共用这一份）。 */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full-access']

/**
 * 是不是一个合法沙箱模式。
 *
 * 接口入参要用它收窄：外部来的字符串不能直接当模式用。
 */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** 权限档位 id（与 `@ryharness/agent` 的 PermissionPreset 同名）。 */
export type PermissionTier = 'read-only' | 'workspace-write' | 'full-access'

/**
 * 档位 → 沙箱模式。
 *
 * 一一对应，但分开两个名字是有原因的：档位是**用户看到的选择**，模式是**执行层的
 * 事实**。以后两者要分开走（比如「工作区可写 + 每条命令都要批准」），改这一张表就行。
 */
export function modeForTier(tier: PermissionTier | undefined): SandboxMode {
  switch (tier) {
    case 'read-only':
      return 'read-only'
    case 'workspace-write':
      return 'workspace-write'
    case 'full-access':
      return 'full-access'
    default:
      return 'workspace-write'
  }
}

/** 被沙箱判定拦下的操作类型。 */
export type SandboxOperation = 'fs-read' | 'fs-write' | 'process-spawn' | 'network'

/** 一次要判定的操作。 */
export interface SandboxRequest {
  /** 这是一次什么操作。 */
  operation: SandboxOperation
  /** 涉及的文件路径（fs 类操作）。 */
  path?: string
  /** 要执行的命令（process 类操作）。 */
  command?: string
  /**
   * 被拦下之后要不要问用户。
   *
   * `ask` = 可以提权：宿主把这次调用拿去问用户，批了就以 full-access 跑一次。
   * `none` = 不问，直接拒。
   */
  escalation?: 'none' | 'ask'
}

/** 判定结果。 */
export type SandboxDecision =
  | {
      readonly allowed: true
      readonly mode: SandboxMode
      /** 这次执行要不要套围栏。 */
      readonly confined: boolean
    }
  | {
      readonly allowed: false
      /** 一句能直接给用户看的中文原因。 */
      readonly reason: string
      /** 能不能通过提权放行。 */
      readonly canEscalate: boolean
    }
