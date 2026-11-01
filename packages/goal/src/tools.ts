/**
 * 模型看得见的三件工具：`get_goal` / `create_goal` / `update_goal`。
 *
 * 这三件是目标这一族对模型的唯一入口。模型能提的要求只有两类：**看现在是什么**、
 * **把它改成什么**。至于什么时候改、改完记哪一笔，是服务的事——模型不该管，也管不了。
 *
 * 工具参数一律从上下文取会话 id（模型编不出来），所以「别的会话的目标」这条隔离
 * 在工具这一层是白送的：模型没有别的会话 id 可填。
 * @module @ryharness/goal/tools
 */

import { GOAL_STATUS_LABELS } from './service.ts'
import type { Goal, GoalStatus } from './types.ts'
import { GoalError } from './types.ts'

/** 读当前目标的工具名。 */
export const GOAL_GET_TOOL_NAME = 'get_goal'
/** 建目标的工具名。 */
export const GOAL_CREATE_TOOL_NAME = 'create_goal'
/** 改目标的工具名。 */
export const GOAL_UPDATE_TOOL_NAME = 'update_goal'

/** 模型看得见的三件工具的名字。 */
export const GOAL_TOOL_NAMES: readonly string[] = Object.freeze([
  GOAL_GET_TOOL_NAME,
  GOAL_CREATE_TOOL_NAME,
  GOAL_UPDATE_TOOL_NAME,
])

/** 工具执行里这一族关心的上下文。 */
export interface GoalToolContext {
  /** 当前会话 id：目标按会话归属。 */
  readonly conversationId?: string
}

/** 工具结果。 */
export interface GoalToolResult {
  /** 正文，作为 tool 消息进模型历史。 */
  readonly content: string
  /** 是不是错误结果。 */
  readonly isError?: boolean
}

/** 一个可注册的工具。 */
export interface GoalTool {
  /** 工具名（注册进工具表时用它）。 */
  readonly name: string
  /** 给模型看的一句话说明。 */
  readonly description: string
  /** JSON Schema（对象）。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: GoalToolContext): Promise<GoalToolResult>
}

/** 工具用的服务能力：只暴露工具真正要用的那几件。 */
export interface GoalToolHost {
  /** 读当前目标。 */
  get(sessionId: string): Goal | undefined
  /** 建目标。 */
  create(input: { sessionId: string; title: string; description?: string; criteria?: string }): Goal
  /** 改目标。 */
  update(input: {
    sessionId: string
    title?: string
    description?: string
    criteria?: string
    status?: GoalStatus
  }): Goal
}

/** 从参数里读字符串字段；不是字符串就当没给。 */
function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** 目标渲染成一段人能看懂的文字。 */
export function renderGoal(goal: Goal): string {
  const lines = [`目标：${goal.title}`, `状态：${GOAL_STATUS_LABELS[goal.status]}`]
  if (goal.description.length > 0) lines.push(`说明：${goal.description}`)
  if (goal.criteria.length > 0) lines.push(`完成判据：${goal.criteria}`)
  return lines.join('\n')
}

/**
 * 建 `get_goal` 工具：看这个会话现在有没有目标、是什么。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createGoalGetTool(host: GoalToolHost): GoalTool {
  return {
    name: GOAL_GET_TOOL_NAME,
    description:
      '看当前会话的目标：标题、状态、完成判据。' +
      '手上有一件要跨着做完的事时，先看这里确认「现在到底要做成什么样」，再决定要不要改。',
    parameters: { type: 'object', properties: {} },
    async execute(_args: unknown, ctx: GoalToolContext): Promise<GoalToolResult> {
      const sessionId = ctx.conversationId
      if (sessionId === undefined || sessionId.trim().length === 0) {
        return failure('目标只能在会话里使用：这次调用没有会话上下文。')
      }
      const goal = host.get(sessionId)
      if (goal === undefined) {
        return { content: '这个会话还没有目标。要定一个，用 create_goal。' }
      }
      return { content: renderGoal(goal) }
    },
  }
}

/**
 * 建 `create_goal` 工具：给这个会话定一个目标。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createGoalCreateTool(host: GoalToolHost): GoalTool {
  return {
    name: GOAL_CREATE_TOOL_NAME,
    description:
      '给当前会话定一个目标：这件事要做到什么程度算完。' +
      '参数 title 一句话说清要做什么，criteria 说清怎么算做完（可选但强烈建议写），description 写细节（可选）。' +
      '一个会话只能有一个目标：已经有目标时再建会失败，这时该用 update_goal 改。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题：这件事叫什么。' },
        description: { type: 'string', description: '可选：具体要做出什么。' },
        criteria: { type: 'string', description: '可选：完成判据——怎么算做完。' },
      },
      required: ['title'],
    },
    async execute(args: unknown, ctx: GoalToolContext): Promise<GoalToolResult> {
      const sessionId = ctx.conversationId
      if (sessionId === undefined || sessionId.trim().length === 0) {
        return failure('目标只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const title = stringField(parsed, 'title')
      if (title === undefined || title.trim().length === 0) {
        return failure('缺少 title：没有标题的目标没法跟人交代这件事是什么。')
      }
      const description = stringField(parsed, 'description')
      const criteria = stringField(parsed, 'criteria')
      try {
        const goal = host.create({
          sessionId,
          title,
          ...(description === undefined ? {} : { description }),
          ...(criteria === undefined ? {} : { criteria }),
        })
        return { content: `定了目标。\n${renderGoal(goal)}` }
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

/**
 * 建 `update_goal` 工具：改这个会话的目标。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createGoalUpdateTool(host: GoalToolHost): GoalTool {
  return {
    name: GOAL_UPDATE_TOOL_NAME,
    description:
      '改当前会话的目标：标题、说明、完成判据，或者换状态（active 进行中 / paused 暂停 / blocked 卡住 / completed 完成 / cleared 清除）。' +
      '要改标题或判据就传 title / description / criteria；要换状态就传 status。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '新标题：这件事叫什么。' },
        description: { type: 'string', description: '新说明：具体要做出什么。' },
        criteria: { type: 'string', description: '新完成判据：怎么算做完。' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'blocked', 'completed', 'cleared'],
          description: '新状态：active 进行中、paused 暂停、blocked 卡住、completed 完成、cleared 清除。',
        },
      },
    },
    async execute(args: unknown, ctx: GoalToolContext): Promise<GoalToolResult> {
      const sessionId = ctx.conversationId
      if (sessionId === undefined || sessionId.trim().length === 0) {
        return failure('目标只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const title = stringField(parsed, 'title')
      const description = stringField(parsed, 'description')
      const criteria = stringField(parsed, 'criteria')
      const status = stringField(parsed, 'status')
      if (status !== undefined && !isGoalStatus(status)) {
        return failure(`status 只能是 active / paused / blocked / completed / cleared 之一，收到的是「${status}」。`)
      }
      if (title === undefined && description === undefined && criteria === undefined && status === undefined) {
        return failure('什么都没传：至少给 title / description / criteria / status 里的一个。')
      }
      try {
        const goal = host.update({
          sessionId,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(criteria === undefined ? {} : { criteria }),
          ...(status === undefined ? {} : { status }),
        })
        return { content: `目标已更新。\n${renderGoal(goal)}` }
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

/**
 * 建这个会话看得见的三件工具。
 * @param host - 服务。
 * @returns 三件工具（按 get / create / update 排好）。
 */
export function createGoalTools(host: GoalToolHost): readonly GoalTool[] {
  return [createGoalGetTool(host), createGoalCreateTool(host), createGoalUpdateTool(host)]
}

/** 状态是不是这一族认识的那五档。 */
function isGoalStatus(value: string): value is GoalStatus {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'completed' || value === 'cleared'
}

/** 失败结果。 */
function failure(content: string): GoalToolResult {
  return { content, isError: true }
}

/** 领域错误转成一句人话；别的异常照原样抛出去。 */
function failureOf(error: unknown): GoalToolResult {
  if (error instanceof GoalError) return failure(error.message)
  throw error
}
