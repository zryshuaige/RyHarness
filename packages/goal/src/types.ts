/**
 * 目标这一族的公共类型。
 *
 * 「目标」是**一个会话要完成的那件事**，不是排程：它记的是「做到什么程度算完」，
 * 而不是「什么时候提醒我」。所以这一族的字段只有状态、判据和时间，没有触发点。
 *
 * 三件事分得很清：
 * - **目标**（{@link Goal}）：当前这一件要完成的事，带状态与完成判据；
 * - **变更**（{@link GoalChange}）：每次改动留一笔（什么时候改了什么），供人回看；
 * - **存储**（{@link GoalStore}）：目标要跨重启还在，所以它必须能被存下来再读回来。
 *
 * 归属按会话：别的会话的目标既看不见也动不了。服务的方法都要求带 `sessionId`，
 * 存储也是按会话分开的——隔离在服务这一层就做掉，不靠调用方自觉。
 * @module @ryharness/goal/types
 */

/**
 * 目标的状态。
 *
 * 五档，按「这事儿现在怎么样」分：
 * - `active`：在推进；
 * - `paused`：人按了暂停，暂时不推；
 * - `blocked`：卡住了（缺东西、等别人、等授权）；
 * - `completed`：做完了；
 * - `cleared`：人不要了（清掉，但记录留着）。
 */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'cleared'

/** 一次变更做了什么。 */
export type GoalAction = 'created' | 'updated' | 'paused' | 'resumed' | 'completed' | 'blocked' | 'cleared'

/** 一个会话的目标。 */
export interface Goal {
  /** 目标 id（同一服务内唯一）。 */
  readonly id: string
  /** 归属的会话 id：别的会话看不见也动不了它。 */
  readonly sessionId: string
  /** 一句话标题：这件事叫什么。 */
  readonly title: string
  /** 展开说：具体要做出什么。 */
  readonly description: string
  /** 完成判据：怎么算做完。空串表示没写。 */
  readonly criteria: string
  /** 当前状态。 */
  readonly status: GoalStatus
  /** 建立时刻（Unix 毫秒）。 */
  readonly createdAt: number
  /** 最近一次改动时刻（Unix 毫秒）。 */
  readonly updatedAt: number
}

/** 一次变更的记录。 */
export interface GoalChange {
  /** 变更时刻（Unix 毫秒）。 */
  readonly at: number
  /** 做了什么。 */
  readonly action: GoalAction
  /** 涉及的目标 id。 */
  readonly goalId: string
  /** 一句话说明（中文，给人看）。 */
  readonly summary: string
  /** 变更前的状态；纯文本编辑时没有。 */
  readonly from?: GoalStatus
  /** 变更后的状态；纯文本编辑时没有。 */
  readonly to?: GoalStatus
}

/**
 * 一个会话的目标档案：当前目标 + 它的变更历史。
 *
 * 目标被清除后仍然留在这里（`goal.status === 'cleared'`）：清掉的是「这件事」，
 * 不是「这段经历」。人回头想看「当时到底定了什么」，靠的就是这份历史。
 */
export interface GoalRecord {
  /** 当前目标；这个会话还没建过目标时没有。 */
  readonly goal?: Goal
  /** 变更历史（按时间正序）。 */
  readonly history: readonly GoalChange[]
}

/**
 * 目标的存储后端。
 *
 * 目标要跨重启还在，所以它必须能落盘。这个接口就是那条缝：宿主可以给文件后端
 * （{@link FileGoalStore}），也可以给内存后端（{@link MemoryGoalStore}），还可以
 * 自己实现一个（数据库、远端同步都成）。
 *
 * 存储按会话分开：一个会话一份档案，别的会话的记录读写时根本不会被碰到。
 */
export interface GoalStore {
  /**
   * 读一个会话的档案。
   * @param sessionId - 会话 id。
   * @returns 档案；这个会话还没有记录时 undefined。
   */
  load(sessionId: string): GoalRecord | undefined
  /**
   * 写回一个会话的档案（覆盖）。
   * @param sessionId - 会话 id。
   * @param record - 档案。
   */
  save(sessionId: string, record: GoalRecord): void
  /**
   * 列出所有有档案的会话 id。
   *
   * 这是**宿主视角**的清单（设置页、运维排查用）；面向用户的一律按会话过滤。
   * @returns 会话 id 列表。
   */
  listSessions(): readonly string[]
}

/** 目标这一族的错误码。 */
export type GoalErrorCode =
  /** 这个会话已经有活着的目标了。 */
  | 'ALREADY_EXISTS'
  /** 目标不存在。 */
  | 'NOT_FOUND'
  /** 这个状态不允许改成目标状态。 */
  | 'INVALID_TRANSITION'
  /** 参数不合法。 */
  | 'INVALID_INPUT'

/** 目标这一族的错误：带机器可读的码，界面与工具据此给不同的说法。 */
export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GoalError'
  }
}
