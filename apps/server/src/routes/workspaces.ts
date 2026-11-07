/**
 * 工作区路由：项目目录的清单与会话归属。
 *
 * 三组接口：
 * - `GET /api/workspaces`：列出所有工作区（名字、根目录、建了多久、下面几个会话）；
 * - `POST /api/workspaces`：新建一个工作区（给名字与根目录）；
 * - `PATCH /api/conversations/:id/workspace`：把会话归到某个工作区，或摘出来。
 *
 * **归属存两处**：会话行上的 `workspace_id`（`packages/session` 的库）与
 * {@link WorkspaceRegistry} 里的归属表。两者说的是同一件事，所以每次改动都
 * **一起写**——只写一处就会出现「界面显示在一个项目下、工具却在另一个目录里
 * 干活」这种最难查的错位。
 *
 * **根目录要像个根目录**：绝对路径、不是文件系统根、真的存在。这三条由
 * `packages/workspace` 的 `assertAllowedRoot` 检查，不合法当场报错，不先记下来
 * 再让人一头雾水。
 * @module @ryharness/server/routes/workspaces
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionStore } from '@ryharness/session'
import type { Workspace, WorkspaceRegistry } from '@ryharness/workspace'
import { WorkspaceAssignBody, WorkspaceCreateBody } from '../contract/workspaces.ts'
import { route } from '../route.ts'
import { HttpRequestError, json, type Router } from '../router.ts'

/** 工作区路由的依赖。 */
export interface WorkspaceRoutesDeps {
  /** 工作区注册表。 */
  readonly registry: WorkspaceRegistry
  /** 会话存储：归属写在会话行上。 */
  readonly store: SessionStore
}

/** 一个工作区的对外视图。 */
interface WorkspaceView {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  readonly createdAt: number
  /** 这个工作区下面有几个会话。 */
  readonly sessionCount: number
  /** 根目录现在还在不在（用户可能把目录挪走或删了）。 */
  readonly rootExists: boolean
}

/**
 * 装配工作区路由。
 * @param router - 路由表。
 * @param deps - 依赖。
 */
export function registerWorkspaceRoutes(router: Router, deps: WorkspaceRoutesDeps): void {
  const { registry, store } = deps

  /** 工作区的视图。 */
  const view = (workspace: Workspace): WorkspaceView => ({
    id: workspace.id,
    name: workspace.name,
    rootPath: workspace.rootPath,
    createdAt: workspace.createdAt,
    sessionCount: registry.sessionsOf(workspace.id).length,
    rootExists: existsSync(workspace.rootPath),
  })

  /**
   * 列出所有工作区。
   *
   * 连「未归属」的会话一起给：界面上要能显示「有几个会话还没归到任何项目下」，
   * 否则那些会话在项目视图里就凭空消失了。
   */
  router.get('/api/workspaces', async (_req, res) => {
    const workspaces = registry.list().map(view)
    const ungrouped = registry.ungroupedSessions().filter((sessionId) => store.getConversation(sessionId) !== undefined)
    json(res, 200, { workspaces, ungroupedSessionCount: ungrouped.length })
  })

  /**
   * 新建一个工作区。
   *
   * 字段类型由契约 schema 兜住；名字与根目录非空、目录真实存在、根目录合法
   * 是业务规则，各自的 400 与机器码保持原样。
   */
  route(router, 'POST', '/api/workspaces', { body: WorkspaceCreateBody }, async (req, res) => {
    const body = await req.body()
    const name = (body.name ?? '').trim()
    const rootPath = (body.rootPath ?? '').trim()
    if (name.length === 0) {
      throw new HttpRequestError(400, '工作区需要一个名字。', 'MISSING_NAME')
    }
    if (rootPath.length === 0) {
      throw new HttpRequestError(400, '工作区需要一个根目录（绝对路径）。', 'MISSING_ROOT')
    }
    if (!existsSync(resolve(rootPath))) {
      throw new HttpRequestError(400, `这个目录不存在：${rootPath}`, 'ROOT_NOT_FOUND')
    }
    let workspace: Workspace
    try {
      workspace = registry.create(name, rootPath)
    } catch (error) {
      throw new HttpRequestError(
        400,
        `这个根目录不能用作工作区：${error instanceof Error ? error.message : String(error)}`,
        'INVALID_ROOT',
      )
    }
    json(res, 201, { workspace: view(workspace) })
  })

  /**
   * 把会话归到某个工作区（或摘出来）。
   *
   * **两处一起写**：会话行的 `workspace_id` 与注册表里的归属表。少写一处就会
   * 出现「界面与工具看到的不是同一个工作区」——那种错位极难查，所以这里宁可
   * 回滚也不能只写一半。
   */
  route(router, 'PATCH', '/api/conversations/:id/workspace', { body: WorkspaceAssignBody }, async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const body = await req.body()
    // 空串与 null 都视同「摘出来」——与手写时代「没给就是摘」同一个落点。
    const raw = body.workspaceId
    const workspaceId = typeof raw === 'string' && raw.length > 0 ? raw : undefined
    if (workspaceId !== undefined && registry.get(workspaceId) === undefined) {
      json(res, 404, { error: 'workspace not found' })
      return
    }
    // 先写注册表（它会校验工作区存在），再写会话行。任一步失败就回滚前者。
    const previous = registry.workspaceOf(conversationId)
    try {
      if (workspaceId === undefined) registry.unassignSession(conversationId)
      else registry.assignSession(conversationId, workspaceId)
    } catch (error) {
      throw new HttpRequestError(
        400,
        `归属没改成：${error instanceof Error ? error.message : String(error)}`,
        'ASSIGN_FAILED',
      )
    }
    if (!store.setConversationWorkspace(conversationId, workspaceId)) {
      // 回滚注册表：不能让两处说法不一致。
      if (previous === undefined) registry.unassignSession(conversationId)
      else registry.assignSession(conversationId, previous)
      json(res, 404, { error: 'conversation not found' })
      return
    }
    json(res, 200, {
      conversationId,
      workspaceId: workspaceId ?? null,
      workspace: workspaceId === undefined ? null : view(registry.get(workspaceId) as Workspace),
    })
  })
}
