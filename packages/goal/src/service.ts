/**
 * 目标服务：一个会话一个目标，跨重启还在。
 *
 * 这层要办的事很少，但每件都不能含糊：
 * - **一个会话至多一个当前目标**：再建一个要么改现有的，要么先清掉——不能有两个「当前目标」；
 * - **归属按会话**：别的会话的目标看不见也动不了，隔离做在服务这一层，不靠调用方自觉；
 * - **跨重启还在**：目标与它的变更历史都落在 {@link GoalStore} 里，重启后读回来还是那条；
 * - **每次改动留一笔**：改了什么、什么时候改的，人回头能看明白（`/goal` 就靠这个讲清楚来龙去脉）。
 *
 * 状态机是显式的（见 {@link ALLOWED_TRANSITIONS}）：完成就是完成，不能从「完成」跳回
 * 「进行中」——目标记的是**状态**，不是待办清单。
 * @module @ryharness/goal/service
 */

import { randomUUID } from 'node:crypto'
import { FileGoalStore, MemoryGoalStore } from './storage.ts'
import { type Goal, type GoalAction, type GoalChange, GoalError, type GoalStatus, type GoalStore } from './types.ts'

/** 目标服务的构造参数。 */
export interface GoalServiceOptions {
  /**
   * 存储后端：目标与历史都存在这儿。
   *
   * 缺省是内存后端（进程死了就没）。要跨重启，就给
   * {@link FileGoalStore} 或 {@link GoalServiceOptions.storePath}。
   */
  store?: GoalStore
  /**
   * 存储文件路径：给了就用文件后端，方便宿主只给一个路径。
   *
   * 与 `store` 同时给时以 `store` 为准。
   */
  storePath?: string
  /** 时钟（测试注入用）。 */
  now?: () => number
  /** 目标 id 生成（测试注入用）。 */
  newId?: () => string
}

/** 建目标时必填的字段。 */
export interface GoalCreateInput {
  /** 归属会话。 */
  sessionId: string
  /** 一句话标题：这件事叫什么。 */
  title: string
  /** 展开说：具体要做出什么。 */
  description?: string
  /** 完成判据：怎么算做完。 */
  criteria?: string
}

/** 改目标时可改的字段；都不给就是空操作。 */
export interface GoalUpdateInput {
  /** 归属会话。 */
  sessionId: string
  /** 新标题。 */
  title?: string
  /** 新描述。 */
  description?: string
  /** 新完成判据。 */
  criteria?: string
  /** 新状态（必须是合法流转）。 */
  status?: GoalStatus
}

/**
 * 合法状态流转。
 *
 * `completed` 与 `cleared` 是终态：`completed` 只能被清掉，`cleared` 谁也回不去。
 * 「完成」不是「暂停」——目标记的是这件事的状态，不是待办清单里的一个勾。
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = Object.freeze({
  active: ['paused', 'blocked', 'completed', 'cleared'],
  paused: ['active', 'blocked', 'completed', 'cleared'],
  blocked: ['active', 'completed', 'cleared'],
  completed: ['cleared'],
  cleared: [],
})

/** 状态的中文说法（给界面与命令用）。 */
export const GOAL_STATUS_LABELS: Readonly<Record<GoalStatus, string>> = Object.freeze({
  active: '进行中',
  paused: '已暂停',
  blocked: '卡住了',
  completed: '已完成',
  cleared: '已清除',
})

/**
 * 目标服务。
 *
 * 一个实例管一批会话的目标。所有方法都要求带 `sessionId`：归属就是会话，
 * 拿别人的会话 id 来问也只会得到「没有这个目标」。
 */
export class GoalService {
  private readonly store: GoalStore
  private readonly now: () => number
  private readonly newId: () => string

  constructor(options: GoalServiceOptions = {}) {
    if (options.store !== undefined) {
      this.store = options.store
    } else if (options.storePath !== undefined) {
      this.store = new FileGoalStore({ filePath: options.storePath })
    } else {
      this.store = new MemoryGoalStore()
    }
    this.now = options.now ?? (() => Date.now())
    this.newId = options.newId ?? (() => `goal-${randomUUID().slice(0, 8)}`)
  }

  /**
   * 读一个会话的当前目标。
   * @param sessionId - 会话 id。
   * @returns 目标；这个会话还没建过目标时 undefined。
   */
  get(sessionId: string): Goal | undefined {
    const record = this.store.load(sessionId)
    return record?.goal
  }

  /**
   * 读一个会话的变更历史（按时间正序）。
   * @param sessionId - 会话 id。
   * @returns 历史条目；没有就空数组。
   */
  history(sessionId: string): readonly GoalChange[] {
    const record = this.store.load(sessionId)
    return record?.history ?? []
  }

  /**
   * 建一个目标。
   *
   * 已经有活着的目标（未清除）时再建一个会报错：两个「当前目标」没法同时成立，
   * 要改就用 `update`。
   * @param input - 会话、标题与可选的描述与判据。
   * @returns 建好的目标。
   */
  create(input: GoalCreateInput): Goal {
    const sessionId = requireSessionId(input.sessionId)
    const title = requireText(input.title, '目标标题')
    const record = this.store.load(sessionId)
    const current = record?.goal
    if (current !== undefined && current.status !== 'cleared') {
      throw new GoalError(
        'ALREADY_EXISTS',
        `这个会话已经有目标「${current.title}」了：改它用 update_goal，清掉重来用 status=cleared。`,
      )
    }
    const at = this.now()
    const goal: Goal = {
      id: this.newId(),
      sessionId,
      title,
      description: (input.description ?? '').trim(),
      criteria: (input.criteria ?? '').trim(),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }
    const history = [...(record?.history ?? []), change(at, 'created', goal.id, `定了目标「${title}」`)]
    this.store.save(sessionId, { goal, history })
    return goal
  }

  /**
   * 改目标：标题、描述、完成判据与状态。
   *
   * 状态只能按 {@link ALLOWED_TRANSITIONS} 流转；改不动会抛 `INVALID_TRANSITION`。
   * @param input - 会话与要改的字段。
   * @returns 改完的目标。
   */
  update(input: GoalUpdateInput): Goal {
    const sessionId = requireSessionId(input.sessionId)
    const record = this.store.load(sessionId)
    const current = record?.goal
    if (current === undefined) {
      throw new GoalError('NOT_FOUND', '这个会话还没有目标：先用 create_goal 定一个。')
    }
    const at = this.now()
    const touched: string[] = []
    let title = current.title
    let description = current.description
    let criteria = current.criteria
    if (input.title !== undefined) {
      const next = requireText(input.title, '目标标题')
      if (next !== current.title) {
        title = next
        touched.push('标题')
      }
    }
    if (input.description !== undefined) {
      const next = input.description.trim()
      if (next !== current.description) {
        description = next
        touched.push('描述')
      }
    }
    if (input.criteria !== undefined) {
      const next = input.criteria.trim()
      if (next !== current.criteria) {
        criteria = next
        touched.push('完成判据')
      }
    }
    let status = current.status
    if (input.status !== undefined && input.status !== current.status) {
      status = this.nextStatus(current.status, input.status)
    }
    // 终态目标不许再改文案：做完的事就是做完的，回头要改就重新定一个。
    if ((current.status === 'completed' || current.status === 'cleared') && touched.length > 0) {
      throw new GoalError(
        'INVALID_TRANSITION',
        `目标已经是「${GOAL_STATUS_LABELS[current.status]}」了，不能再改${touched.join('、')}。`,
      )
    }
    const goal: Goal = {
      ...current,
      title,
      description,
      criteria,
      status,
      updatedAt: at,
    }
    const history = [...(record?.history ?? [])]
    if (status !== current.status) {
      history.push(statusChange(at, current.status, status, goal.id))
    }
    if (touched.length > 0) {
      history.push(change(at, 'updated', goal.id, `改了${touched.join('、')}`))
    }
    this.store.save(sessionId, { goal, history })
    return goal
  }

  /**
   * 暂停目标：暂时不推，但事没完。
   * @param sessionId - 会话 id。
   * @returns 暂停后的目标。
   */
  pause(sessionId: string): Goal {
    return this.update({ sessionId, status: 'paused' })
  }

  /**
   * 恢复目标：从暂停或卡住回到进行中。
   * @param sessionId - 会话 id。
   * @returns 恢复后的目标。
   */
  resume(sessionId: string): Goal {
    return this.update({ sessionId, status: 'active' })
  }

  /**
   * 标记完成：这件事做完了。
   * @param sessionId - 会话 id。
   * @returns 完成后的目标。
   */
  complete(sessionId: string): Goal {
    return this.update({ sessionId, status: 'completed' })
  }

  /**
   * 标记卡住：缺东西、等别人、等授权。
   * @param sessionId - 会话 id。
   * @returns 标记后的目标。
   */
  block(sessionId: string): Goal {
    return this.update({ sessionId, status: 'blocked' })
  }

  /**
   * 清除目标：不要这件事了。记录留在历史里，人回头还能看到当时定了什么。
   * @param sessionId - 会话 id。
   * @returns 清除后的目标。
   */
  clear(sessionId: string): Goal {
    return this.update({ sessionId, status: 'cleared' })
  }

  /**
   * 状态能不能这么改。
   *
   * 同一个状态改到自己不算流转（返回原状态，不留历史）。
   */
  private nextStatus(from: GoalStatus, to: GoalStatus): GoalStatus {
    const allowed = ALLOWED_TRANSITIONS[from]
    if (!allowed.includes(to)) {
      throw new GoalError(
        'INVALID_TRANSITION',
        `目标现在是「${GOAL_STATUS_LABELS[from]}」，不能改成「${GOAL_STATUS_LABELS[to]}」。`,
      )
    }
    return to
  }
}

/** 会话 id 不能为空。 */
function requireSessionId(sessionId: string): string {
  const trimmed = sessionId.trim()
  if (trimmed.length === 0) {
    throw new GoalError('INVALID_INPUT', '会话 id 是必填的：目标按会话归属，没有会话就没有归属。')
  }
  return trimmed
}

/** 必填文本不能为空。 */
function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new GoalError('INVALID_INPUT', `${label}不能为空。`)
  }
  return trimmed
}

/** 造一条变更记录。 */
function change(at: number, action: GoalAction, goalId: string, summary: string): GoalChange {
  return { at, action, goalId, summary }
}

/** 造一条状态变更记录（带前后状态）。 */
function statusChange(at: number, from: GoalStatus, to: GoalStatus, goalId: string): GoalChange {
  const action = statusAction(to)
  return {
    at,
    action,
    goalId,
    summary: `目标从「${GOAL_STATUS_LABELS[from]}」变成「${GOAL_STATUS_LABELS[to]}」`,
    from,
    to,
  }
}

/** 目标变成某个状态时对应的动作名。 */
function statusAction(to: GoalStatus): GoalAction {
  if (to === 'paused') return 'paused'
  if (to === 'active') return 'resumed'
  if (to === 'completed') return 'completed'
  if (to === 'blocked') return 'blocked'
  return 'cleared'
}
