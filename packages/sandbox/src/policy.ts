/**
 * 沙箱策略：部署默认值 + 每会话覆盖 + 逐次判定的落点。
 *
 * 模式从哪儿来，优先级是：**会话覆盖 > 助理的权限档位 > 部署默认值**。
 * 会话覆盖放在最上面，是因为它是「这一轮临时收紧了」——用户在会话里点了个「只读模式」，
 * 不该被助理自己的档位盖回去。
 * @module @ryharness/sandbox/policy
 */

import {
  modeForTier,
  type PermissionTier,
  type SandboxDecision,
  type SandboxMode,
  type SandboxRequest,
} from './types.ts'

/** 策略的构造参数。 */
export interface SandboxPolicyOptions {
  /** 工作区根：可写模式的边界。 */
  workspaceRoot: string
  /** 部署默认值（缺省 = 工作区可写）。 */
  defaultMode?: SandboxMode
}

/** 判定一次调用时的上下文。 */
export interface SandboxContext {
  /** 会话 id（用于取会话覆盖）。 */
  conversationId?: string
  /** 助理 id。 */
  agentId?: string
  /** 助理自己的权限档位。 */
  tier?: PermissionTier
}

/**
 * 沙箱策略。
 *
 * 无外部依赖，可以直接 new 出来用；宿主（服务端）持有一份，按会话改档位。
 */
export class SandboxPolicy {
  private readonly workspaceRoot: string
  private readonly defaultMode: SandboxMode
  private readonly conversationModes = new Map<string, SandboxMode>()

  constructor(options: SandboxPolicyOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.defaultMode = options.defaultMode ?? 'workspace-write'
  }

  /** 这次调用的有效模式。 */
  modeFor(context: SandboxContext): SandboxMode {
    if (context.conversationId !== undefined) {
      const override = this.conversationModes.get(context.conversationId)
      if (override !== undefined) return override
    }
    if (context.tier !== undefined) return modeForTier(context.tier)
    return this.defaultMode
  }

  /** 给某个会话临时设档（用户在这一轮收紧了权限）。 */
  setConversationMode(conversationId: string, mode: SandboxMode): void {
    this.conversationModes.set(conversationId, mode)
  }

  /** 撤掉会话覆盖，回到助理档位。 */
  clearConversationMode(conversationId: string): void {
    this.conversationModes.delete(conversationId)
  }

  /**
   * 这个会话有没有覆盖。
   *
   * 宿主用它在每轮开跑前取一次：**没有覆盖就返回 undefined**，让助理自己的档位
   * 说了算——宿主不该在这里替助理选一个档位，否则「助理是只读」和「这个会话临时
   * 只读」就分不开了。
   */
  conversationMode(conversationId: string): SandboxMode | undefined {
    return this.conversationModes.get(conversationId)
  }

  /** 当前所有会话覆盖（给「我的」页显示用）。 */
  conversationOverrides(): Record<string, SandboxMode> {
    const result: Record<string, SandboxMode> = {}
    for (const [conversationId, mode] of this.conversationModes) result[conversationId] = mode
    return result
  }

  /**
   * 判定一次操作能不能做。
   *
   * 判定口径（与模式一一对应）：
   * - 读文件：任何模式都放行（**边界仍由工作区限定管着**，沙箱不重复做路径逃逸判定）。
   * - 写文件：`read-only` 拒；`workspace-write` 放行但要求路径在工作区内；`full-access` 放行。
   * - 执行命令：`read-only` 拒；`workspace-write` 放行但要套围栏；`full-access` 放行不套。
   * - 出网：按模式放行（围栏层再按后端能力决定要不要断网）。
   * @param request - 要判定的操作。
   * @param context - 这次调用的上下文。
   * @returns 判定结果。
   */
  decide(request: SandboxRequest, context: SandboxContext): SandboxDecision {
    const mode = this.modeFor(context)
    const canEscalate = request.escalation === 'ask'
    if (mode === 'full-access') {
      return { allowed: true, mode, confined: false }
    }
    switch (request.operation) {
      case 'fs-read':
        return { allowed: true, mode, confined: true }
      case 'fs-write': {
        if (mode === 'read-only') {
          return {
            allowed: false,
            reason: '当前权限是「只读」：写文件需要用户提权。',
            canEscalate,
          }
        }
        if (request.path !== undefined && !this.isInsideWorkspace(request.path)) {
          return {
            allowed: false,
            reason: '工作区之外不能写。',
            canEscalate,
          }
        }
        return { allowed: true, mode, confined: true }
      }
      case 'process-spawn': {
        if (mode === 'read-only') {
          return {
            allowed: false,
            reason: '当前权限是「只读」：执行命令需要用户提权。',
            canEscalate,
          }
        }
        return { allowed: true, mode, confined: true }
      }
      case 'network':
        return { allowed: true, mode, confined: true }
    }
  }

  /** 路径是不是落在工作区里（词法层；符号链接那一层由 fs 工具自己管）。 */
  private isInsideWorkspace(path: string): boolean {
    const normalized = path.replace(/\\/g, '/').toLowerCase()
    const root = this.workspaceRoot.replace(/\\/g, '/').toLowerCase()
    return normalized === root || normalized.startsWith(root.endsWith('/') ? root : `${root}/`)
  }
}
