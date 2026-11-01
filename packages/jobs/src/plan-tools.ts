/**
 * 模型看得见的两件工具：交一份计划上去、读当前计划状态。
 *
 * 这两件工具是计划模式对外的唯一入口。它们只管「计划这份东西」，不管「什么时候
 * 可以动手」——那是宿主拿 {@link PlanModeService.gate} 决定的。
 * @module @ryharness/jobs/plan-tools
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { PlanDraft, PlanGate, PlanSnapshot, PlanStatus, PlanStep } from './types.ts'

/** 提交计划的工具名。 */
export const PLAN_PROPOSE_TOOL_NAME = 'plan_propose'

/** 读计划状态的工具名。 */
export const PLAN_READ_TOOL_NAME = 'plan_read'

/** 工具用到的服务能力。 */
export interface PlanToolHost {
  /** 交一份计划上去等人批。 */
  propose(conversationId: string, draft: PlanDraft, agentId?: string): PlanSnapshot
  /** 当前这份计划。 */
  current(conversationId: string): PlanSnapshot | undefined
  /** 当前计划的状态。 */
  status(conversationId: string): PlanStatus
  /** 现在能不能动手。 */
  gate(conversationId: string): PlanGate
  /** 这个会话开着计划模式吗。 */
  isEnabled(conversationId: string): boolean
}

/** 会话 id：计划是按会话的，没有会话 id 时用空串（自成一路）。 */
function conversationOf(ctx: ToolContext): string {
  return ctx.conversationId ?? ''
}

/** 解析计划草稿；参数不合法时返回 undefined。 */
function parseDraft(args: unknown): PlanDraft | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const title = record.title
  if (typeof title !== 'string' || title.trim().length === 0) return undefined
  const rawSteps = record.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return undefined
  const steps: PlanStep[] = []
  for (const raw of rawSteps) {
    if (typeof raw === 'string') {
      // 空标题的步骤原样带过去：由服务统一报错，模型看到的是「哪一步没写标题」，
      // 而不是一句含糊的「参数不对」。
      steps.push({ title: raw.trim() })
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const stepTitle = item.title
    if (typeof stepTitle !== 'string') continue
    const detail = item.detail
    steps.push({
      title: stepTitle.trim(),
      ...(typeof detail === 'string' && detail.trim().length > 0 ? { detail: detail.trim() } : {}),
    })
  }
  if (steps.length === 0) return undefined
  return { title: title.trim(), steps }
}

/** 一份计划给模型看的正文。 */
function renderPlan(plan: PlanSnapshot): string {
  const lines = plan.steps.map((step, index) => {
    const detail = step.detail === undefined ? '' : `（${step.detail}）`
    return `${index + 1}. ${step.title}${detail}`
  })
  return [`【计划 v${plan.version}·${plan.title}】`, ...lines].join('\n')
}

/**
 * 建 `plan_propose` 工具：交一份计划上去等人批。
 *
 * 交上去之后**不要动手**——人会先看一遍；被打回就按反馈改一版新的。
 * @param host - 服务（提供 propose）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createPlanProposeTool(host: PlanToolHost): Tool {
  return {
    name: PLAN_PROPOSE_TOOL_NAME,
    description:
      '交一份计划上去等人批。计划模式开着的时候，先把方案想清楚，用这件工具把标题和步骤交上来，' +
      '人批了才动手；没批之前不要执行任何步骤。被打回了就按反馈改一版新的再交。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题：一句话说清要做什么。' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '这一步要做什么。' },
              detail: { type: 'string', description: '可选：这一步怎么做、注意什么。' },
            },
            required: ['title'],
          },
          description: '步骤清单，每步写清要做什么。',
        },
      },
      required: ['title', 'steps'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const draft = parseDraft(args)
      if (draft === undefined) {
        return {
          content: '计划参数不对：要有 title 和至少一步（每步一个 title）。',
          isError: true,
        }
      }
      try {
        const plan = host.propose(conversationOf(ctx), draft, ctx.agentId)
        return {
          content: [
            `计划 v${plan.version} 已提交，等人批：`,
            renderPlan(plan),
            '批准之前不要执行；被打回了就用 plan_read 看反馈，改一版新的再交。',
          ].join('\n'),
        }
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : '交计划失败了。',
          isError: true,
        }
      }
    },
  }
}

/**
 * 建 `plan_read` 工具：读当前这份计划与它的状态。
 * @param host - 服务（提供 current / status / gate）。
 * @returns 满足 `Tool` 契约的工具。
 */
export function createPlanReadTool(host: PlanToolHost): Tool {
  return {
    name: PLAN_READ_TOOL_NAME,
    description: '读这次对话当前的计划：标题、步骤、状态（待批 / 已批 / 被打回），以及被打回时人给的反馈。',
    parameters: { type: 'object', properties: {} },
    async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const conversationId = conversationOf(ctx)
      const plan = host.current(conversationId)
      const gate = host.gate(conversationId)
      if (plan === undefined) {
        const mode = host.isEnabled(conversationId) ? '计划模式开着，但还没有计划。' : '这次对话还没有计划。'
        return { content: mode }
      }
      const lines = [renderPlan(plan), `状态：${host.status(conversationId)}`]
      if (plan.feedback !== undefined) lines.push(`被打回的反馈：${plan.feedback}`)
      if (gate.allowed) lines.push('现在可以动手了。')
      else if (gate.reason !== undefined) lines.push(gate.reason)
      return { content: lines.join('\n') }
    },
  }
}
