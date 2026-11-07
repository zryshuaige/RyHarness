/**
 * 沙箱路由：模式清单、会话级权限覆盖的读写。
 *
 * 分工说清楚：
 * - **档位**（permission preset）是助理的属性，用户在通讯录里选，决定这位助理平时
 *   能碰什么。
 * - **覆盖**（override）是会话的属性，用户在某个会话里临时收紧（例如让一位全权
 *   助理在这个会话里只读）。它在档位之上生效，撤掉就回到档位。
 *
 * 覆盖只存在内存里：它是「这一轮临时收紧了」的语义，重启后回到档位——这不是偷懒，
 * 是刻意不落库（落库会变成一个用户从没主动设置过的持久状态）。
 * @module @ryharness/server/routes/sandbox
 */

import { isSandboxMode, type SandboxMode } from '@ryharness/sandbox'
import type { SessionStore } from '@ryharness/session'
import { SandboxOverrideBody } from '../contract/sandbox.ts'
import { route } from '../route.ts'
import { HttpRequestError, json, type Router } from '../router.ts'

/** 沙箱路由的依赖。 */
export interface SandboxRoutesDeps {
  store: SessionStore
  /** 沙箱策略：会话覆盖的存放处。 */
  policy: SandboxPolicyLike
  /** 工作区根：模式说明里要写清边界。 */
  workspaceRoot: string
}

/** 沙箱策略的最小契约（路由不碰策略内部，只用它存/取覆盖）。 */
export interface SandboxPolicyLike {
  conversationMode(conversationId: string): SandboxMode | undefined
  setConversationMode(conversationId: string, mode: SandboxMode): void
  clearConversationMode(conversationId: string): void
  conversationOverrides(): Record<string, SandboxMode>
}

/**
 * 三个模式的说明。
 *
 * `strength` 字段是**必须给用户看的**：Windows 上只有围栏，没有内核级隔离。
 * 界面把两种强度显示成同一种「已隔离」是骗人。
 */
const MODE_VIEWS: ReadonlyArray<{
  id: SandboxMode
  name: string
  summary: string
  strength: 'kernel' | 'fence'
}> = [
  {
    id: 'read-only',
    name: '只读',
    summary: '不能写文件，不能执行命令。读文件、按名字找文件、按正则搜内容照常。',
    strength: 'fence',
  },
  {
    id: 'workspace-write',
    name: '工作区可写',
    summary: '可以写工作区里的文件，可以执行命令——命令被关在工作区里跑。',
    strength: 'fence',
  },
  {
    id: 'full-access',
    name: '不设围栏',
    summary: '命令照常跑，不套围栏。敏感操作仍要逐条审批。',
    strength: 'fence',
  },
]

/** 隔离强度说明：平台不同，强度不同。 */
const STRENGTH_NOTES: Record<'kernel' | 'fence', string> = {
  kernel: '内核级隔离：命令被关在一个只能看见工作区的沙箱里。',
  fence: '围栏级隔离：清空环境变量、限定工作目录、拦截明显的越界写目标。不是内核边界。',
}

/** 挂载沙箱路由。 */
export function registerSandboxRoutes(router: Router, deps: SandboxRoutesDeps): void {
  router.get('/api/sandbox/modes', async (_req, res) => {
    json(res, 200, {
      modes: MODE_VIEWS.map((view) => {
        return {
          id: view.id,
          name: view.name,
          summary: view.summary,
          strength: view.strength,
          strengthNote: STRENGTH_NOTES[view.strength],
        }
      }),
      workspaceRoot: deps.workspaceRoot,
    })
  })

  /**
   * 读一个会话的覆盖。
   *
   * 回的是「有没有覆盖」而不是「当前有效模式」：有效模式要按发言助理的档位算，
   * 群聊里每位成员档位不同，混成一个数会骗人。
   */
  router.get('/api/sandbox/conversations/:id', async (req, res) => {
    const conversationId = req.params.id ?? ''
    const conversation = deps.store.getConversation(conversationId)
    if (conversation === undefined) {
      throw new HttpRequestError(404, `没有这个会话：${conversationId}`, 'SANDBOX_UNKNOWN_CONVERSATION')
    }
    json(res, 200, {
      conversationId,
      override: deps.policy.conversationMode(conversationId) ?? null,
    })
  })

  /**
   * 设 / 撤一个会话的覆盖。
   *
   * `mode` 传 `null` 表示撤掉覆盖（回到助理自己的档位）；传字符串就设。
   * 「字符串或 null」由契约 schema 兜住；取值白名单是业务规则，报 400 并带
   * 机器码，不静默忽略——静默忽略会让人以为已经收紧了。
   */
  route(router, 'POST', '/api/sandbox/conversations/:id', { body: SandboxOverrideBody }, async (req, res) => {
    const conversationId = req.params.id ?? ''
    const conversation = deps.store.getConversation(conversationId)
    if (conversation === undefined) {
      throw new HttpRequestError(404, `没有这个会话：${conversationId}`, 'SANDBOX_UNKNOWN_CONVERSATION')
    }
    const raw = (await req.body()).mode
    if (raw === null) {
      deps.policy.clearConversationMode(conversationId)
      json(res, 200, { conversationId, override: null })
      return
    }
    if (!isSandboxMode(raw)) {
      throw new HttpRequestError(
        400,
        'mode 只能是 read-only / workspace-write / full-access，或者 null（撤掉覆盖）',
        'SANDBOX_BAD_MODE',
      )
    }
    deps.policy.setConversationMode(conversationId, raw)
    json(res, 200, { conversationId, override: raw })
  })

  /** 所有会话的覆盖一览。 */
  router.get('/api/sandbox/overrides', async (_req, res) => {
    json(res, 200, { overrides: deps.policy.conversationOverrides() })
  })
}
