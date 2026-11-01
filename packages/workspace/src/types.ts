/**
 * 工作区的数据形状：一个工作区是什么、一个会话怎么归到它下面。
 *
 * 三层：
 * - **工作区（{@link Workspace}）**：一个项目目录，加上一个能给人看的名字。
 *   `rootPath` 是工具读写文件的边界，`name` 是界面上显示的那行字。
 * - **归属（{@link SessionPlacement}）**：一个会话属于哪个工作区，以及要不要
 *   在分组里藏着它。藏起来不等于删掉——会话还在，只是不出现在这个项目下面。
 * - **配置（{@link WorkspaceRegistryOptions}）**：存哪儿、允许哪些根目录、时钟。
 * @module @ryharness/workspace/types
 */

/**
 * 一个工作区。
 *
 * `id` 在整个注册表里唯一；`rootPath` 是绝对路径，指向一个真实存在的目录。
 */
export interface Workspace {
  /** 工作区 id。 */
  readonly id: string
  /** 给人看的名字。 */
  readonly name: string
  /** 根目录的绝对路径。工具读写文件的边界就是它。 */
  readonly rootPath: string
  /** 建立时间（毫秒）。列表按它排。 */
  readonly createdAt: number
}

/**
 * 一个会话在工作区里的归属。
 *
 * `workspaceId` 为 `null` 表示**未分组**：这个会话还在，只是不挂在任何项目下面。
 * 没有归属的会话叫「未分组」：它照常存在，只是不挂在任何项目下面。
 */
export interface SessionPlacement {
  /** 属于哪个工作区；`null` 表示未分组。 */
  readonly workspaceId: string | null
  /** 是不是被藏起来了。藏起来只是不显示，不是删除。 */
  readonly hidden: boolean
}

/** 工作区注册表的配置。 */
export interface WorkspaceRegistryOptions {
  /**
   * 存记录的 JSON 文件路径。
   *
   * 不给就只在内存里：进程退出就没了（测试与一次性脚本用）。
   */
  readonly storePath?: string
  /**
   * 允许的工作区根范围。
   *
   * 给了之后，工作区的根目录必须落在其中某一个里面。**不给就没有这一层限制**，
   * 但根目录仍然不能是文件系统根（`/` 或 `C:\`）。
   */
  readonly allowedRoots?: readonly string[]
  /** 时钟。默认 `Date.now`；测试里换成固定值好断言时间戳。 */
  readonly now?: () => number
  /** 工作区 id 的生成器。默认用随机 UUID。 */
  readonly newId?: () => string
}
