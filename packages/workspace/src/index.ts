/**
 * RyHarness 工作区：多个项目目录 + 会话归属。
 *
 * 本包回答两个问题：
 * - **有哪些工作区**：一个项目目录加上一个名字，`{ id, name, rootPath, createdAt }`。
 * - **会话归到哪儿**：一个会话最多属于一个工作区，也可以不属于任何工作区。
 *
 * **工作区根目录是工具读写文件的边界**。`packages/tools` 那边已经有一个
 * `workspaceRoot`（单个工作区），这里是**多个**工作区：同一个会话落在哪个目录，
 * 由它归属的工作区决定。
 *
 * 路径边界只做**词法**判断（`..`、绝对路径、跨盘符、文件系统根）。
 * 符号链接与 Windows junction 的真实路径校验在 `@ryharness/tools` 的
 * `resolveTarget` 里——那一层才知道读写动作真正落在哪个文件上。
 *
 * 本包**不暴露给模型**：不注册工具、不进提示词。它是宿主侧的基础设施。
 * @module @ryharness/workspace
 */

export { WorkspaceNotFoundError, WorkspacePathError, WorkspaceStoreError } from './errors.ts'
export { assertAllowedRoot, isFilesystemRoot, isInsideRoot, resolveInWorkspace } from './paths.ts'
export { WorkspaceRegistry } from './registry.ts'
export type { WorkspaceFile } from './store.ts'
export { WORKSPACE_FILE_VERSION, WorkspaceStore } from './store.ts'
export type { SessionPlacement, Workspace, WorkspaceRegistryOptions } from './types.ts'
