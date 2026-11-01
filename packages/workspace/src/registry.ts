/**
 * 工作区注册表：管住「有哪些项目目录、每个会话归到哪儿」。
 *
 * 这里回答两个问题：
 * - **有哪些工作区**：名字、根目录、建立时间。列表按建立时间排。
 * - **会话归到哪儿**：一个会话最多属于一个工作区；也可以不属于任何工作区
 *   （未分组），或者属于但被藏起来（藏起来不是删除，会话还在）。
 *
 * 三条硬规矩：
 * - **删工作区不删文件夹，也不删会话**。删的只是这条记录：用户的目录和历史
 *   不该因为界面上点了一下「移除」就没了。
 * - **根目录要像个根目录**：绝对路径、不是文件系统根、落在允许的范围内、
 *   真的存在。检查在 {@link assertAllowedRoot} 里。
 * - **工作区根是工具读写文件的边界**。这里给的是「这个会话的边界在哪儿」，
 *   真正的路径解析（连同符号链接/junction 的真实路径校验）在
 *   `@ryharness/tools` 那一层。
 *
 * 持久化落在一个 JSON 文件里（{@link WorkspaceStore}）；不给路径就只在内存里。
 * @module @ryharness/workspace/registry
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { WorkspaceNotFoundError } from './errors.ts'
import { assertAllowedRoot, resolveInWorkspace } from './paths.ts'
import { WORKSPACE_FILE_VERSION, WorkspaceStore } from './store.ts'
import type { SessionPlacement, Workspace, WorkspaceRegistryOptions } from './types.ts'

/**
 * 工作区注册表。
 */
export class WorkspaceRegistry {
  private readonly store: WorkspaceStore
  private readonly allowedRoots: readonly string[]
  private readonly now: () => number
  private readonly newId: () => string
  private readonly workspaces = new Map<string, Workspace>()
  private readonly placements = new Map<string, SessionPlacement>()

  /**
   * @param options - 配置。
   * @throws WorkspaceStoreError - 存的记录读不出来时。
   */
  constructor(options: WorkspaceRegistryOptions = {}) {
    this.store = new WorkspaceStore({ filePath: options.storePath })
    this.allowedRoots = (options.allowedRoots ?? []).map((root) => resolve(root))
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
    this.reload()
  }

  /**
   * 新建一个工作区。
   *
   * 根目录会先过一遍检查：不是绝对路径、是文件系统根、不在允许的范围内、
   * 或者根本不存在，都会当场报错，不会先记下来再让人一头雾水。
   * @param name - 给人看的名字。
   * @param rootPath - 根目录的绝对路径。
   * @returns 建好的工作区。
   * @throws WorkspacePathError - 根目录不合法时。
   */
  create(name: string, rootPath: string): Workspace {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('工作区的名字不能是空串')
    assertAllowedRoot(rootPath, this.allowedRoots)
    const workspace: Workspace = {
      id: this.newId(),
      name: trimmed,
      rootPath: resolve(rootPath),
      createdAt: this.now(),
    }
    this.workspaces.set(workspace.id, workspace)
    this.persist()
    return workspace
  }

  /**
   * 按 id 取一个工作区。
   * @param id - 工作区 id。
   * @returns 工作区；没有就是 `undefined`。
   */
  get(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  /**
   * 列出全部工作区。
   *
   * 按建立时间排；时间相同再按 id 排——「先建的在前面」是用户预期的顺序。
   * @returns 工作区列表。
   */
  list(): Workspace[] {
    return [...this.workspaces.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }

  /**
   * 给工作区改名。
   *
   * 只改名字：根目录是用户的地盘，改它得由用户明确提出来。
   * @param id - 工作区 id。
   * @param name - 新名字。
   * @returns 改完后的工作区。
   * @throws WorkspaceNotFoundError - 没有这个工作区时。
   */
  rename(id: string, name: string): Workspace {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('工作区的名字不能是空串')
    const existing = this.workspaces.get(id)
    if (existing === undefined) throw new WorkspaceNotFoundError(id)
    const renamed: Workspace = { ...existing, name: trimmed }
    this.workspaces.set(id, renamed)
    this.persist()
    return renamed
  }

  /**
   * 移除一个工作区。
   *
   * **只删记录**：文件夹不动，会话不动。原来属于它的会话变成未分组，
   * 历史还在，只是不再挂在任何项目下面。
   * @param id - 工作区 id。
   * @returns 真的移除掉了才为 true。
   */
  remove(id: string): boolean {
    if (!this.workspaces.delete(id)) return false
    for (const [sessionId, placement] of [...this.placements]) {
      if (placement.workspaceId === id) {
        this.placements.set(sessionId, { workspaceId: null, hidden: false })
      }
    }
    this.persist()
    return true
  }

  /**
   * 把一个会话归到某个工作区。
   *
   * 一个会话最多属于一个工作区：重新归到别处就是搬过去，不是多挂一份。
   * @param sessionId - 会话 id。
   * @param workspaceId - 工作区 id。
   * @returns 归好了为 true。
   * @throws WorkspaceNotFoundError - 没有这个工作区时。
   */
  assignSession(sessionId: string, workspaceId: string): boolean {
    if (sessionId.trim().length === 0) throw new Error('会话 id 不能是空串')
    if (!this.workspaces.has(workspaceId)) throw new WorkspaceNotFoundError(workspaceId)
    this.placements.set(sessionId, { workspaceId, hidden: false })
    this.persist()
    return true
  }

  /**
   * 把一个会话从工作区里摘出来（变成未分组）。
   *
   * 摘出来不是删掉：这个会话还在 `ungroupedSessions()` 里，历史也还在。
   * @param sessionId - 会话 id。
   * @returns 原来有归属才为 true。
   */
  unassignSession(sessionId: string): boolean {
    const placement = this.placements.get(sessionId)
    if (placement === undefined || placement.workspaceId === null) return false
    this.placements.set(sessionId, { workspaceId: null, hidden: false })
    this.persist()
    return true
  }

  /**
   * 把一个会话在工作区里藏起来。
   *
   * 藏起来只是不显示：这个会话还在，`ungroupedSessions()` 里也能找到它。
   * @param sessionId - 会话 id。
   * @returns 藏好了为 true（本来就没有归属是 false）。
   */
  hideSession(sessionId: string): boolean {
    const placement = this.placements.get(sessionId)
    if (placement === undefined || placement.workspaceId === null) return false
    this.placements.set(sessionId, { ...placement, hidden: true })
    this.persist()
    return true
  }

  /**
   * 把藏起来的会话放回工作区的分组里。
   * @param sessionId - 会话 id。
   * @returns 原来藏着才为 true。
   */
  showSession(sessionId: string): boolean {
    const placement = this.placements.get(sessionId)
    if (placement === undefined || !placement.hidden) return false
    this.placements.set(sessionId, { ...placement, hidden: false })
    this.persist()
    return true
  }

  /**
   * 一个会话属于哪个工作区。
   * @param sessionId - 会话 id。
   * @returns 工作区 id；没有归属就是 `undefined`。
   */
  workspaceOf(sessionId: string): string | undefined {
    return this.placements.get(sessionId)?.workspaceId ?? undefined
  }

  /**
   * 列出某个工作区下面的会话。
   *
   * 藏起来的会话不算在内。返回的顺序按会话 id 排——按时间排是会话存储那边
   * 的事（它才知道每个会话多新）。
   * @param workspaceId - 工作区 id。
   * @returns 会话 id 列表。
   */
  sessionsOf(workspaceId: string): string[] {
    const ids: string[] = []
    for (const [sessionId, placement] of this.placements) {
      if (placement.workspaceId === workspaceId && !placement.hidden) ids.push(sessionId)
    }
    return ids.sort()
  }

  /**
   * 列出没有被挂在任何工作区下面的会话。
   *
   * 三种算：本来就没归过、从工作区里摘出来的、被藏起来的。它们的共同点是
   * **还在**——用户还找得到，只是界面上不挂在某个项目下面。
   * @returns 会话 id 列表。
   */
  ungroupedSessions(): string[] {
    const ids: string[] = []
    for (const [sessionId, placement] of this.placements) {
      const orphan = placement.workspaceId === null || !this.workspaces.has(placement.workspaceId)
      if (orphan || placement.hidden) ids.push(sessionId)
    }
    return ids.sort()
  }

  /**
   * 把一条路径解析到这个会话所属的工作区之内。
   *
   * 这是「多个工作区」这件事的落点：同一个工具调用，落在哪个目录由会话
   * 归属的工作区决定。
   * @param sessionId - 会话 id。
   * @param path - 调用方给的路径（相对工作区根，或根内的绝对路径）。
   * @returns 规范化后的绝对路径。
   * @throws WorkspaceNotFoundError - 会话没有归属的工作区时。
   * @throws WorkspacePathError - 路径逃出了工作区根时。
   */
  resolveSessionPath(sessionId: string, path: string): string {
    const workspaceId = this.workspaceOf(sessionId)
    if (workspaceId === undefined) throw new WorkspaceNotFoundError(sessionId)
    const workspace = this.workspaces.get(workspaceId)
    if (workspace === undefined) throw new WorkspaceNotFoundError(workspaceId)
    return resolveInWorkspace(workspace, path)
  }

  /**
   * 从存储里重新读一遍。
   *
   * 别的进程改了文件（比如用户手动编辑）时用它同步一次。
   * @throws WorkspaceStoreError - 存的记录读不出来时。
   */
  reload(): void {
    const file = this.store.load()
    this.workspaces.clear()
    for (const workspace of file.workspaces) this.workspaces.set(workspace.id, workspace)
    this.placements.clear()
    for (const [sessionId, placement] of Object.entries(file.sessions)) {
      this.placements.set(sessionId, placement)
    }
  }

  /** 把当前状态写回存储。 */
  private persist(): void {
    this.store.save({
      version: WORKSPACE_FILE_VERSION,
      workspaces: this.list(),
      sessions: Object.fromEntries(this.placements),
    })
  }
}
