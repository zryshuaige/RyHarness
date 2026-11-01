/**
 * 提醒服务：建提醒、算下一次响、到点投递。
 *
 * 这一族把「提醒」这件事拆成三块，各归各家：
 * - **服务**（这一层）：什么时候响、响过几次、这条提醒归谁；
 * - **时间计算**（timing.ts）：五种触发方式各自怎么算下一次；
 * - **投递**（宿主的 `deliver` 回调）：到点了把那句话投进原会话。
 *
 * 服务**不碰会话存储**：会话里怎么写消息、怎么推给界面，是宿主的事。
 * 本包只负责「什么时候、说什么、投给谁」。
 *
 * 两件事在这一层做实：
 * - **跨重启存活**：提醒落在 {@link ScheduleStore} 里，重启后读回来，错过的时间按
 *   {@link MissedPolicy} 处理（跳过 / 补一次）。
 * - **删除要确认**：删一条提醒不可逆，所以删除接口要求显式确认（`confirmed: true`），
 *   不确认就报错——这是「确认后删」那条规则在本包的落点。
 * @module @ryharness/schedule/service
 */

import { randomUUID } from 'node:crypto'
import { FileScheduleStore, MemoryScheduleStore } from './storage.ts'
import { computeNextRun } from './timing.ts'
import type { MissedPolicy, ScheduleStatus, ScheduleStore, ScheduleTask, ScheduleTrigger } from './types.ts'
import { ScheduleError } from './types.ts'

/** 提醒服务的构造参数。 */
export interface ScheduleServiceOptions {
  /**
   * 存储后端：提醒存在这儿。
   *
   * 缺省是内存后端（进程死了就没）。要跨重启，给 {@link FileScheduleStore}
   * 或 {@link ScheduleServiceOptions.storePath}。
   */
  store?: ScheduleStore
  /** 存储文件路径：给了就用文件后端。 */
  storePath?: string
  /**
   * 投递回调：到点时把消息投进原会话。
   *
   * 包内不碰会话存储，投递的落地方式由宿主决定（落库、推界面、还是别的）。
   */
  deliver?: (scheduleId: string, conversationId: string, text: string) => void | Promise<void>
  /**
   * 错过时间（进程停着的时候到了点）的处理办法。
   *
   * - `skip`（缺省）：跳过错过的那些次，直接排到下一次；
   * - `catch-up`：把错过的那次补上（只补一条，不补一堆）。
   */
  missedPolicy?: MissedPolicy
  /** 时钟（测试注入用）。 */
  now?: () => number
  /** 提醒 id 生成（测试注入用）。 */
  newId?: () => string
}

/** 建提醒时的输入。 */
export interface ScheduleCreateInput {
  /** 归属会话：到点时消息投进这个会话。 */
  conversationId: string
  /** 正文：到点时投进会话的那句话。 */
  text: string
  /** 触发方式。 */
  trigger: ScheduleTrigger
  /** 标题（给人看的短句）。 */
  title?: string
}

/** 改提醒时的输入。 */
export interface ScheduleUpdateInput {
  /** 提醒 id。 */
  id: string
  /** 新正文。 */
  text?: string
  /** 新标题。 */
  title?: string
  /** 新触发方式。 */
  trigger?: ScheduleTrigger
  /** 新的启用状态（停用 / 启用）。 */
  enabled?: boolean
}

/** 一次投递的结果。 */
export interface ScheduleTickResult {
  /** 这次投递出去的提醒。 */
  readonly task: ScheduleTask
  /** 投给哪个会话。 */
  readonly conversationId: string
  /** 投出去的正文。 */
  readonly text: string
}

/**
 * 提醒服务。
 *
 * 一个实例管一批提醒。所有面向用户的查询都按会话过滤；跨会话的清���（宿主视角的
 * 「所有提醒」）由 `listAll()` 单独提供，不混在按会话的查询里。
 */
export class ScheduleService {
  private readonly store: ScheduleStore
  private readonly deliver:
    | ((scheduleId: string, conversationId: string, text: string) => void | Promise<void>)
    | undefined
  private readonly now: () => number
  private readonly newId: () => string
  private readonly missedPolicy: MissedPolicy
  private tasks: ScheduleTask[] = []

  constructor(options: ScheduleServiceOptions = {}) {
    if (options.store !== undefined) {
      this.store = options.store
    } else if (options.storePath !== undefined) {
      this.store = new FileScheduleStore({ filePath: options.storePath })
    } else {
      this.store = new MemoryScheduleStore()
    }
    this.deliver = options.deliver
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? (() => `sch-${randomUUID().slice(0, 8)}`)
    this.missedPolicy = options.missedPolicy ?? 'skip'
    this.tasks = [...this.store.load()]
    this.reconcileMissed()
  }

  /** 缺省的错过时间策略。 */
  get policy(): MissedPolicy {
    return this.missedPolicy
  }

  /**
   * 建一条提醒。
   * @param input - 会话、正文、触发方式与可选标题。
   * @returns 建好的提醒。
   */
  create(input: ScheduleCreateInput): ScheduleTask {
    const conversationId = requireText(input.conversationId, '会话 id')
    const text = requireText(input.text, '提醒内容')
    const at = this.now()
    if (input.trigger.kind === 'once' && input.trigger.at <= at) {
      throw new ScheduleError('INVALID_INPUT', '一次性提醒的时间得在将来：现在设一个已经过去的时刻，它永远不会响。')
    }
    const task: ScheduleTask = {
      id: this.newId(),
      conversationId,
      title: (input.title ?? '').trim(),
      text,
      trigger: input.trigger,
      status: 'active',
      createdAt: at,
      updatedAt: at,
      fireCount: 0,
    }
    const nextRunAt = computeNextRun(input.trigger, at, at)
    const withNext = nextRunAt === undefined ? { ...task, status: 'completed' as const } : { ...task, nextRunAt }
    this.tasks = [...this.tasks, withNext]
    this.persist()
    return withNext
  }

  /**
   * 列出某个会话的提醒。
   * @param conversationId - 会话 id。
   * @param includeDisabled - 是否也列出停用的。
   * @returns 提醒列表（按建立顺序）。
   */
  list(conversationId: string, includeDisabled = true): readonly ScheduleTask[] {
    return this.tasks.filter((task) => {
      if (task.conversationId !== conversationId) return false
      if (!includeDisabled && task.status === 'disabled') return false
      return true
    })
  }

  /**
   * 列出全部提醒（宿主视角：任务管理页看的就是它）。
   * @param includeDisabled - 是否也列出停用的。
   * @returns 提醒列表（按建立顺序）。
   */
  listAll(includeDisabled = true): readonly ScheduleTask[] {
    if (includeDisabled) return [...this.tasks]
    return this.tasks.filter((task) => {
      return task.status !== 'disabled'
    })
  }

  /**
   * 按 id 查一条提醒。
   * @param id - 提醒 id。
   * @returns 提醒；没有这条时 undefined。
   */
  get(id: string): ScheduleTask | undefined {
    return this.tasks.find((task) => {
      return task.id === id
    })
  }

  /**
   * 改一条提醒：正文、标题、触发方式或启用状态。
   *
   * 改了触发方式就重算下一次响的时刻；停用了就不再排下一次。
   * @param input - 提醒 id 与要改的字段。
   * @returns 改完的提醒。
   */
  update(input: ScheduleUpdateInput): ScheduleTask {
    const current = this.require(input.id)
    const at = this.now()
    let text = current.text
    let title = current.title
    let trigger = current.trigger
    let enabled = current.status !== 'disabled' && current.status !== 'completed'
    if (input.text !== undefined) {
      text = requireText(input.text, '提醒内容')
    }
    if (input.title !== undefined) {
      title = input.title.trim()
    }
    if (input.trigger !== undefined) {
      trigger = input.trigger
      // 触发方式换了，之前算好的下一次就不作数了。
      enabled = true
    }
    if (input.enabled !== undefined) {
      enabled = input.enabled
    }
    const status: ScheduleStatus = enabled ? 'active' : 'disabled'
    const nextRunAt = enabled ? computeNextRun(trigger, at, at) : undefined
    const updated: ScheduleTask = {
      ...current,
      title,
      text,
      trigger,
      status: status === 'active' && nextRunAt === undefined ? 'completed' : status,
      updatedAt: at,
      // 下一次要重新排：停用了就没有下一次（有也不作数）。
      nextRunAt,
    }
    this.tasks = this.tasks.map((task) => {
      return task.id === current.id ? updated : task
    })
    this.persist()
    return updated
  }

  /**
   * 停用一条提醒（不响，但留着）。
   * @param id - 提醒 id。
   * @returns 停用后的提醒。
   */
  disable(id: string): ScheduleTask {
    return this.update({ id, enabled: false })
  }

  /**
   * 启用一条提醒（重新排下一次）。
   * @param id - 提醒 id。
   * @returns 启用后的提醒。
   */
  enable(id: string): ScheduleTask {
    return this.update({ id, enabled: true })
  }

  /**
   * 删一条提醒。
   *
   * **删除要确认**：不可逆的操作不许「手一滑就没了」。没确认就抛
   * `CONFIRMATION_REQUIRED`，宿主/界面拿到这个码就知道该弹确认框。
   * @param id - 提醒 id。
   * @param confirmed - 是否已确认。
   * @returns 删掉了返回 true。
   */
  remove(id: string, confirmed: boolean): boolean {
    this.require(id)
    if (!confirmed) {
      throw new ScheduleError('CONFIRMATION_REQUIRED', '删提醒不可逆：确认之后再删（confirmed: true）。')
    }
    this.tasks = this.tasks.filter((task) => {
      return task.id !== id
    })
    this.persist()
    return true
  }

  /**
   * 到点了就投递：把所有到点的提醒发出去，并排下一次。
   *
   * 投递失败的提醒照旧排下一次——一次投递失败（会话没了、宿主挂了）不该让这条
   * 提醒从此再也不响。
   * @param now - 判定「到点」的时刻（Unix 毫秒）；缺省用服务自己的时钟。
   * @returns 这次投递出去的提醒。
   */
  async tick(now: number = this.now()): Promise<readonly ScheduleTickResult[]> {
    const due = this.tasks.filter((task) => {
      if (task.status !== 'active') return false
      if (task.nextRunAt === undefined) return false
      return task.nextRunAt <= now
    })
    const sent: ScheduleTickResult[] = []
    for (const task of due) {
      const text = task.text
      const updated = this.fire(task, now)
      if (this.deliver !== undefined) {
        try {
          await this.deliver(task.id, task.conversationId, text)
        } catch {
          // 投递失败不影响这条提醒继续排下一次。
        }
      }
      sent.push({ task: updated, conversationId: task.conversationId, text })
    }
    return sent
  }

  /**
   * 错过时间的处理：进程停着的时候到了点，现在开机了。
   *
   * - `skip`：跳过错过的那些次，直接排到下一次；
   * - `catch-up`：把错过的那次补上（只补一条）。
   *
   * 补的那次会在下一次 `tick()` 里投出去——所以宿主启动后记得 tick 一次。
   */
  private reconcileMissed(): void {
    const at = this.now()
    const next = this.tasks.map((task) => {
      if (task.status !== 'active') return task
      if (task.nextRunAt === undefined) return task
      if (task.nextRunAt > at) return task
      if (this.missedPolicy === 'catch-up') {
        // 补的那次就挂在已经过点的那个时刻上：下一次 tick 会把它投出去，
        // 投完再排下一次——只补一条，不补一堆。
        return task
      }
      const nextRunAt = computeNextRun(task.trigger, at, task.createdAt)
      if (nextRunAt === undefined) {
        return { ...task, status: 'completed' as const, nextRunAt: undefined }
      }
      return { ...task, nextRunAt }
    })
    this.tasks = next
    this.persist()
  }

  /**
   * 记一次响：次数 +1、排下一次。
   *
   * 一次性提醒响完就没有下一次了（状态转 completed）。
   */
  private fire(task: ScheduleTask, now: number): ScheduleTask {
    const nextRunAt = computeNextRun(task.trigger, now, task.createdAt)
    const updated: ScheduleTask = {
      ...task,
      status: nextRunAt === undefined ? 'completed' : 'active',
      updatedAt: now,
      lastRunAt: now,
      fireCount: task.fireCount + 1,
      // 一次性提醒响完就没有下一次了。
      nextRunAt,
    }
    this.tasks = this.tasks.map((candidate) => {
      return candidate.id === task.id ? updated : candidate
    })
    this.persist()
    return updated
  }

  /** 按 id 找一条，找不到就抛 NOT_FOUND。 */
  private require(id: string): ScheduleTask {
    const task = this.get(id)
    if (task === undefined) {
      throw new ScheduleError('NOT_FOUND', `没有这条提醒：${id}`)
    }
    return task
  }

  /** 落盘。 */
  private persist(): void {
    this.store.save(this.tasks)
  }
}

/** 必填文本不能为空。 */
function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new ScheduleError('INVALID_INPUT', `${label}不能为空。`)
  }
  return trimmed
}
