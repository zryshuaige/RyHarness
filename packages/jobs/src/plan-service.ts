/**
 * 计划模式：先探索设计，给出一份计划等人批，批了才执行。
 *
 * 模式是**按会话**的：一个会话开着计划模式，另一个会话照常干活，互不影响。
 * 这条模式本身不改工具清单（工具由宿主另配），它管的是「计划这件事批了没有」——
 * {@link PlanModeService.gate} 给出「现在能不能动手」的判定，宿主拿它决定要不要把
 * 这一轮继续跑下去。这跟 RyVibe 的盘问是同一类东西：人先回答，队伍才继续。
 *
 * 一份计划的生命周期：`proposed`（待批）→ `approved`（批了，执行）或 `rejected`
 * （打回，附一句反馈）。打回之后 agent 改一版重新交上来，版本号 +1——主人因此能
 * 分得清「这是改过的第二版」。
 * @module @ryharness/jobs/plan-service
 */

import type { Tool } from '@ryharness/agent'
import { messageOf } from './format.ts'
import {
  createPlanProposeTool,
  createPlanReadTool,
  PLAN_PROPOSE_TOOL_NAME,
  PLAN_READ_TOOL_NAME,
  type PlanToolHost,
} from './plan-tools.ts'
import type { PlanDraft, PlanGate, PlanSnapshot, PlanStatus, PlanStep } from './types.ts'

/** 计划模式服务的构造参数。 */
export interface PlanModeServiceOptions {
  /**
   * 计划状态变化时的宿主回调。
   *
   * 上层拿到它之后要做的事只有一件：把「待批 / 已批 / 被打回」写进会话，让人看得见
   * 这份计划并能回一句话。
   */
  onChange?: (plan: PlanSnapshot) => void | Promise<void>
}

/**
 * 计划模式服务。
 *
 * 一个实例管着所有会话的计划状态：谁开着模式、哪份计划在等批、批了没。
 */
export class PlanModeService implements PlanToolHost {
  /** 会话 → 当前计划。 */
  private readonly plans = new Map<string, PlanSnapshot>()
  /** 开着计划模式的会话。 */
  private readonly enabled = new Set<string>()
  /** 会话 → 已提交过的版本数：下一次提交的版本号 = 它 + 1。 */
  private readonly versions = new Map<string, number>()
  /** 宿主回调最近一次出的错。 */
  private callbackError: string | undefined

  /** 模型看得见的两件工具：`plan_propose` 与 `plan_read`。 */
  readonly modelTools: readonly Tool[]

  constructor(private readonly options: PlanModeServiceOptions = {}) {
    this.modelTools = [createPlanProposeTool(this), createPlanReadTool(this)]
  }

  /** 宿主回调最近一次出的错；没有则 undefined。 */
  get lastCallbackError(): string | undefined {
    return this.callbackError
  }

  /**
   * 给一个会话开计划模式。
   *
   * 只有这一个会话受影响：别的会话照常做事。
   * @param conversationId - 会话 id。
   */
  enable(conversationId: string): void {
    this.enabled.add(conversationId)
  }

  /**
   * 给一个会话关计划模式。
   *
   * 关掉之后计划还在（人批过的记录留着），但不再拦着动手。
   * @param conversationId - 会话 id。
   */
  disable(conversationId: string): void {
    this.enabled.delete(conversationId)
  }

  /**
   * 这个会话开着计划模式吗。
   * @param conversationId - 会话 id。
   * @returns 开着为 true。
   */
  isEnabled(conversationId: string): boolean {
    return this.enabled.has(conversationId)
  }

  /**
   * 交一份计划上去等人批。
   *
   * 每次提交都是新的一版：版本号 +1，状态回到「待批」。哪怕上一版已经批过了也一样——
   * 改了计划就得让人重新看一眼。
   * @param conversationId - 会话 id。
   * @param draft - 计划标题与步骤清单。
   * @returns 新一版计划的快照。
   */
  propose(conversationId: string, draft: PlanDraft, agentId?: string): PlanSnapshot {
    const title = draft.title.trim()
    if (title.length === 0) throw new Error('计划没有标题：得有一句话说清要做什么。')
    const steps: PlanStep[] = draft.steps.map((step) => {
      const stepTitle = step.title.trim()
      const detail = step.detail?.trim()
      return {
        title: stepTitle,
        ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      }
    })
    if (steps.length === 0) throw new Error('计划没有步骤：写清要做哪几步，人才好批。')
    if (steps.some((step) => step.title.length === 0)) {
      throw new Error('计划里有一步没写标题：每一步都要有一句话说清要做什么。')
    }
    const version = (this.versions.get(conversationId) ?? 0) + 1
    this.versions.set(conversationId, version)
    const plan: PlanSnapshot = {
      conversationId,
      ...(agentId === undefined || agentId.length === 0 ? {} : { agentId }),
      version,
      title,
      steps,
      status: 'proposed',
      createdAt: Date.now(),
    }
    this.plans.set(conversationId, plan)
    this.notify(plan)
    return plan
  }

  /**
   * 批了这份计划。
   * @param conversationId - 会话 id。
   * @returns 批完之后的计划快照；没有计划时 undefined。
   */
  approve(conversationId: string): PlanSnapshot | undefined {
    const plan = this.plans.get(conversationId)
    if (plan === undefined) return undefined
    if (plan.status === 'approved') return plan
    const decided: PlanSnapshot = { ...plan, status: 'approved', decidedAt: Date.now() }
    this.plans.set(conversationId, decided)
    this.notify(decided)
    return decided
  }

  /**
   * 打回这份计划，让 agent 改。
   *
   * 反馈会留着：agent 下一版要照着它改，所以反馈不是可选项。
   * @param conversationId - 会话 id。
   * @param feedback - 人写的反馈（打回原因）。
   * @returns 打回之后的计划快照；没有计划时 undefined。
   */
  reject(conversationId: string, feedback: string): PlanSnapshot | undefined {
    const plan = this.plans.get(conversationId)
    if (plan === undefined) return undefined
    const why = feedback.trim()
    const decided: PlanSnapshot = {
      ...plan,
      status: 'rejected',
      decidedAt: Date.now(),
      feedback: why.length === 0 ? '没写原因，但没批。' : why,
    }
    this.plans.set(conversationId, decided)
    this.notify(decided)
    return decided
  }

  /**
   * 当前这份计划。
   * @param conversationId - 会话 id。
   * @returns 计划快照；还没有计划时 undefined。
   */
  current(conversationId: string): PlanSnapshot | undefined {
    const plan = this.plans.get(conversationId)
    if (plan === undefined) return undefined
    return { ...plan, steps: plan.steps.map((step) => ({ ...step })) }
  }

  /**
   * 当前计划的状态。
   * @param conversationId - 会话 id。
   * @returns 状态；没有计划时是 `none`。
   */
  status(conversationId: string): PlanStatus {
    return this.plans.get(conversationId)?.status ?? 'none'
  }

  /**
   * 「现在能不能动手」的判定。
   *
   * 计划模式没开的会话不受影响；开了的会话在计划被批之前一律拦着——这就是「批了才
   * 执行」这条承诺的落点。
   * @param conversationId - 会话 id。
   * @returns 判定结果与（不能动手时的）一句人话原因。
   */
  gate(conversationId: string): PlanGate {
    if (!this.enabled.has(conversationId)) return { allowed: true }
    const plan = this.plans.get(conversationId)
    if (plan === undefined) {
      return {
        allowed: false,
        reason: '计划模式开着：先把方案想清楚，用 plan_propose 交一份计划出来。',
      }
    }
    if (plan.status === 'approved') return { allowed: true }
    if (plan.status === 'rejected') {
      return {
        allowed: false,
        reason: `计划被打回了：${plan.feedback ?? '人没说原因'}。改一版新的再交上来。`,
      }
    }
    return { allowed: false, reason: '计划已经提交，等人批准；批准之前不要动手。' }
  }

  /** 通知宿主：计划的状态变了。 */
  private notify(plan: PlanSnapshot): void {
    const handler = this.options.onChange
    if (handler === undefined) return
    try {
      // 宿主回调自己的失败与计划无关：接住就行，别把计划的状态改掉。
      void Promise.resolve(handler(plan)).catch((error: unknown) => {
        this.callbackError = messageOf(error)
      })
    } catch (error) {
      this.callbackError = messageOf(error)
    }
  }
}

/** 模型看得见的两件工具的名字。 */
export const PLAN_TOOL_NAMES: readonly string[] = Object.freeze([PLAN_PROPOSE_TOOL_NAME, PLAN_READ_TOOL_NAME])
