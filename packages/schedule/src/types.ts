/**
 * 提醒这一族的公共类型。
 *
 * 提醒的语义是「到点了，在原来的会话里说一句」。所以这一族的类型只有三样东西：
 * - **触发方式**（{@link ScheduleTrigger}）：什么时候响。五种：一次性、固定间隔、
 *   每日、每周、cron。
 * - **任务**（{@link ScheduleTask}）：一条提醒：说什么、给谁、什么时候响、响过几次。
 *
 * 提醒跟目标一样是**按会话归属**的：它要投进原会话，别人不该顺手改掉它。
 * @module @ryharness/schedule/types
 */

/** 提醒的状态。 */
export type ScheduleStatus =
  /** 在跑：到点会响。 */
  | 'active'
  /** 停用：人把它按掉了，暂时不响。 */
  | 'disabled'
  /** 一次性提醒已经响过了。 */
  | 'completed'

/** 触发方式：什么时候响。 */
export type ScheduleTrigger =
  /** 一次性：某个时刻响一次。 */
  | { readonly kind: 'once'; readonly at: number }
  /** 固定间隔：每隔一段时间响一次（对齐到建立时刻，不漂移）。 */
  | { readonly kind: 'interval'; readonly everyMs: number }
  /** 每日：每天某个钟点（本地时间 `HH:MM`）响。 */
  | { readonly kind: 'daily'; readonly time: string }
  /** 每周：每周某天的某个钟点（本地时间 `HH:MM`）响。 */
  | { readonly kind: 'weekly'; readonly weekday: number; readonly time: string }
  /** cron：五段表达式（分 时 日 月 周）。 */
  | { readonly kind: 'cron'; readonly expression: string }

/** 一条提醒。 */
export interface ScheduleTask {
  /** 提醒 id（同一服务内唯一）。 */
  readonly id: string
  /** 归属会话：到点时消息投进这个会话。 */
  readonly conversationId: string
  /** 标题（给人看的短句）。 */
  readonly title: string
  /** 正文：到点时投进会话的那句话。 */
  readonly text: string
  /** 触发方式。 */
  readonly trigger: ScheduleTrigger
  /** 当前状态。 */
  readonly status: ScheduleStatus
  /** 建立时刻（Unix 毫秒）。 */
  readonly createdAt: number
  /** 最近一次改动时刻（Unix 毫秒）。 */
  readonly updatedAt: number
  /** 下次响的时刻（Unix 毫秒）；一次性提醒响完后没有。 */
  readonly nextRunAt?: number
  /** 上次响的时刻（Unix 毫秒）；还没响过就没有。 */
  readonly lastRunAt?: number
  /** 响过几次。 */
  readonly fireCount: number
}

/** 错过时间（进程停着）时的处理办法。 */
export type MissedPolicy =
  /** 跳过：错过的那些次不补，直接排到下一次。 */
  | 'skip'
  /** 补一次：把错过的那次补上（只补一条，不补一堆）。 */
  | 'catch-up'

/** 提醒这一族的错误码。 */
export type ScheduleErrorCode =
  /** 参数不合法（时间格式错、cron 解析不了、间隔不合法等）。 */
  | 'INVALID_INPUT'
  /** 没有这条提醒。 */
  | 'NOT_FOUND'
  /** 这个状态不允许改成目标状态。 */
  | 'INVALID_TRANSITION'
  /** 删除需要确认。 */
  | 'CONFIRMATION_REQUIRED'

/** 提醒这一族的错误：带机器可读的码，宿主据此映射 HTTP 状态。 */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/**
 * 提醒的存储后端。
 *
 * 提醒要跨 Host 重启存活，所以它必须能落盘。这个接口就是那条缝：宿主给文件后端
 * （{@link FileScheduleStore}）或内存后端（{@link MemoryScheduleStore}）都行。
 */
export interface ScheduleStore {
  /**
   * 读出全部提醒。
   * @returns 提醒列表；还没有时空数组。
   */
  load(): readonly ScheduleTask[]
  /**
   * 写回全部提醒（覆盖）。
   * @param tasks - 提醒列表。
   */
  save(tasks: readonly ScheduleTask[]): void
}
