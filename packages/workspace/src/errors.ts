/**
 * 工作区这一族的错误。
 *
 * 分三类，处置方式不一样：
 * - **路径不合法**（根目录越界、路径逃出工作区）：调用方给的路径有问题，
 *   换个路径再来。
 * - **工作区不存在**：给个 id 就以为它在那儿，先查一下。
 * - **存坏了**（落盘的东西读不出来）：盘上的事实坏了，重写会把现场抹掉，
 *   得让人先看一眼现场。
 * @module @ryharness/workspace/errors
 */

/**
 * 路径不合法：根目录越界，或者一条路径逃出了工作区。
 *
 * 带路径：出事的到底是哪一条路径，得说清楚。
 */
export class WorkspacePathError extends Error {
  /** 出事的那条路径。 */
  readonly path: string

  constructor(path: string, reason: string) {
    super(`工作区路径不合法：${path} —— ${reason}`)
    this.name = 'WorkspacePathError'
    this.path = path
  }
}

/** 给了一个不存在的工作区 id。 */
export class WorkspaceNotFoundError extends Error {
  /** 找不到的那个工作区 id。 */
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super(`工作区不存在：${workspaceId}`)
    this.name = 'WorkspaceNotFoundError'
    this.workspaceId = workspaceId
  }
}

/**
 * 落盘的工作区记录读不出来。
 *
 * 带路径：出事的文件是哪一份得说清楚，否则用户只知道「工作区列表空了」。
 */
export class WorkspaceStoreError extends Error {
  /** 出事的那份文件的路径。 */
  readonly path: string

  constructor(path: string, reason: string) {
    super(`工作区记录损坏：${path} —— ${reason}`)
    this.name = 'WorkspaceStoreError'
    this.path = path
  }
}
