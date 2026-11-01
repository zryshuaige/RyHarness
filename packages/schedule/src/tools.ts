/**
 * 模型看得见的四件工具：`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。
 *
 * 这四件是提醒这一族对模型的唯一入口。模型能提的要求只有两类：**立个提醒**、
 * **看看有哪些提醒**。什么时候响由触发方式决定，响的时候怎么投由宿主决定。
 *
 * 参数一律从上下文取会话 id（模型编不出来），所以「别的会话的提醒」这条隔离
 * 在工具这一层是白送的：模型没有别的会话 id 可填。
 * @module @ryharness/schedule/tools
 */

import { describeTrigger } from './timing.ts'
import type { ScheduleTask, ScheduleTrigger } from './types.ts'
import { ScheduleError } from './types.ts'

/** 建提醒的工具名。 */
export const SCHEDULE_CREATE_TOOL_NAME = 'schedule_create'
/** 列提醒的工具名。 */
export const SCHEDULE_LIST_TOOL_NAME = 'schedule_list'
/** 改提醒的工具名。 */
export const SCHEDULE_UPDATE_TOOL_NAME = 'schedule_update'
/** 删提醒的工具名。 */
export const SCHEDULE_DELETE_TOOL_NAME = 'schedule_delete'

/** 模型看得见的四件工具的名字。 */
export const SCHEDULE_TOOL_NAMES: readonly string[] = Object.freeze([
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_UPDATE_TOOL_NAME,
  SCHEDULE_DELETE_TOOL_NAME,
])

/** 工具执行里这一族关心的上下文。 */
export interface ScheduleToolContext {
  /** 当前会话 id：提醒按会话归属。 */
  readonly conversationId?: string
}

/** 工具结果。 */
export interface ScheduleToolResult {
  /** 正文，作为 tool 消息进模型历史。 */
  readonly content: string
  /** 是不是错误结果。 */
  readonly isError?: boolean
}

/** 一个可注册的工具。 */
export interface ScheduleTool {
  /** 工具名（注册进工具表时用它）。 */
  readonly name: string
  /** 给模型看的一句话说明。 */
  readonly description: string
  /** JSON Schema（对象）。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: ScheduleToolContext): Promise<ScheduleToolResult>
}

/** 工具用的服务能力。 */
export interface ScheduleToolHost {
  /** 建提醒。 */
  create(input: { conversationId: string; text: string; trigger: ScheduleTrigger; title?: string }): ScheduleTask
  /** 列某会话的提醒。 */
  list(conversationId: string, includeDisabled: boolean): readonly ScheduleTask[]
  /** 按 id 查一条提醒。 */
  get(id: string): ScheduleTask | undefined
  /** 改提醒。 */
  update(input: {
    id: string
    text?: string
    title?: string
    trigger?: ScheduleTrigger
    enabled?: boolean
  }): ScheduleTask
  /** 删提醒（要确认）。 */
  remove(id: string, confirmed: boolean): boolean
}

/** 从参数里读字符串字段；不是字符串就当没给。 */
function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** 从参数里读数字字段；不是有限数字就当没给。 */
function numberField(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从参数里读布尔字段；不是布尔就当没给。 */
function booleanField(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** 一条提醒渲染成一行文字。 */
export function renderTask(task: ScheduleTask): string {
  const status = task.status === 'active' ? '启用中' : task.status === 'disabled' ? '已停用' : '已完成'
  const next = task.nextRunAt === undefined ? '不再响' : new Date(task.nextRunAt).toLocaleString('zh-CN')
  return `- [${task.id}] ${task.text}（${describeTrigger(task.trigger)}；${status}；下次 ${next}；已响 ${task.fireCount} 次）`
}

/**
 * 解析触发方式：模型给的是「自然语言 + 几个字段」，这里收成一个触发对象。
 *
 * 收不拢就报一条能照着改的错：模型最怕的是「参数没生效但也没报错」。
 * @param args - 工具参数。
 * @returns 触发方式。
 */
export function parseTrigger(args: Record<string, unknown>): ScheduleTrigger {
  const kind = stringField(args, 'kind')
  if (kind === undefined || kind.trim().length === 0) {
    throw new ScheduleError('INVALID_INPUT', '要说明什么时候响：kind 取 once / interval / daily / weekly / cron 之一。')
  }
  if (kind === 'once') {
    const at = numberField(args, 'at')
    if (at === undefined) {
      throw new ScheduleError('INVALID_INPUT', '一次性提醒要给 at（Unix 毫秒时间戳），且得在将来。')
    }
    return { kind: 'once', at }
  }
  if (kind === 'interval') {
    const everyMinutes = numberField(args, 'every_minutes')
    if (everyMinutes === undefined || everyMinutes <= 0) {
      throw new ScheduleError('INVALID_INPUT', '固定间隔要给 every_minutes（正数分钟）。')
    }
    return { kind: 'interval', everyMs: Math.round(everyMinutes * 60_000) }
  }
  if (kind === 'daily') {
    const time = stringField(args, 'time')
    if (time === undefined) {
      throw new ScheduleError('INVALID_INPUT', '每日提醒要给 time（HH:MM）。')
    }
    return { kind: 'daily', time }
  }
  if (kind === 'weekly') {
    const time = stringField(args, 'time')
    const weekday = numberField(args, 'weekday')
    if (time === undefined) {
      throw new ScheduleError('INVALID_INPUT', '每周提醒要给 time（HH:MM）。')
    }
    if (weekday === undefined) {
      throw new ScheduleError('INVALID_INPUT', '每周提醒要给 weekday（0 是周日，6 是周六）。')
    }
    return { kind: 'weekly', weekday, time }
  }
  if (kind === 'cron') {
    const expression = stringField(args, 'cron')
    if (expression === undefined) {
      throw new ScheduleError('INVALID_INPUT', 'cron 提醒要给 cron（五段表达式：分 时 日 月 周）。')
    }
    return { kind: 'cron', expression }
  }
  throw new ScheduleError('INVALID_INPUT', `kind 只能是 once / interval / daily / weekly / cron（收到「${kind}」）。`)
}

/**
 * 建 `schedule_create` 工具：立一个提醒。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createScheduleCreateTool(host: ScheduleToolHost): ScheduleTool {
  return {
    name: SCHEDULE_CREATE_TOOL_NAME,
    description:
      '给当前会话立一个提醒，到点时这句话会作为一条后续消息投回这个会话。' +
      '参数 text 是到点时要说的话；kind 说明什么时候响：once（一次性，给 at 时间戳）、' +
      'interval（固定间隔，给 every_minutes）、daily（每天几点，给 time）、weekly（每周几，给 weekday 与 time）、cron（给 cron 表达式）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '到点时投进这个会话的那句话。' },
        kind: {
          type: 'string',
          enum: ['once', 'interval', 'daily', 'weekly', 'cron'],
          description: '什么时候响：once 一次性、interval 固定间隔、daily 每天、weekly 每周、cron 表达式。',
        },
        at: { type: 'number', description: 'kind=once 时用：Unix 毫秒时间戳（要在将来）。' },
        every_minutes: { type: 'number', description: 'kind=interval 时用：每隔多少分钟。' },
        time: { type: 'string', description: 'kind=daily / weekly 时用：几点（HH:MM）。' },
        weekday: { type: 'number', description: 'kind=weekly 时用：星期几（0 是周日，6 是周六）。' },
        cron: { type: 'string', description: 'kind=cron 时用：五段表达式（分 时 日 月 周）。' },
      },
      required: ['text', 'kind'],
    },
    async execute(args: unknown, ctx: ScheduleToolContext): Promise<ScheduleToolResult> {
      const conversationId = ctx.conversationId
      if (conversationId === undefined || conversationId.trim().length === 0) {
        return failure('提醒只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const text = stringField(parsed, 'text')
      if (text === undefined || text.trim().length === 0) {
        return failure('缺少 text：提醒得说清楚到点时讲什么。')
      }
      try {
        const trigger = parseTrigger(parsed)
        const title = stringField(parsed, 'title')
        const task = host.create({
          conversationId,
          text,
          trigger,
          ...(title === undefined ? {} : { title }),
        })
        return { content: `提醒已立。\n${renderTask(task)}` }
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

/**
 * 建 `schedule_list` 工具：看这个会话有哪些提醒。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createScheduleListTool(host: ScheduleToolHost): ScheduleTool {
  return {
    name: SCHEDULE_LIST_TOOL_NAME,
    description:
      '列出当前会话的提醒：内容、什么时候响、启用还是停用、响过几次。' +
      '用户问「我有哪些提醒」「那个提醒还在吗」时用它。',
    parameters: {
      type: 'object',
      properties: {
        include_disabled: {
          type: 'boolean',
          description: '是否也列出已停用的提醒；缺省列出全部。',
        },
      },
    },
    async execute(args: unknown, ctx: ScheduleToolContext): Promise<ScheduleToolResult> {
      const conversationId = ctx.conversationId
      if (conversationId === undefined || conversationId.trim().length === 0) {
        return failure('提醒只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const includeDisabled = booleanField(parsed, 'include_disabled')
      const tasks = host.list(conversationId, includeDisabled ?? true)
      if (tasks.length === 0) {
        return { content: '这个会话还没有提醒。' }
      }
      return {
        content: [`这个会话的提醒（共 ${tasks.length} 条）：`, ...tasks.map((task) => renderTask(task))].join('\n'),
      }
    },
  }
}

/**
 * 建 `schedule_update` 工具：改一条提醒。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createScheduleUpdateTool(host: ScheduleToolHost): ScheduleTool {
  return {
    name: SCHEDULE_UPDATE_TOOL_NAME,
    description:
      '改当前会话的一条提醒：改内容（text）、改什么时候响（跟 create 一样的 kind 与那几个字段）、' +
      '或者停用 / 启用（enabled）。参数 id 指明改哪一条。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改的提醒 id（用 schedule_list 查）。' },
        text: { type: 'string', description: '新的提醒内容。' },
        title: { type: 'string', description: '新的标题。' },
        enabled: { type: 'boolean', description: 'true 启用、false 停用。' },
        kind: {
          type: 'string',
          enum: ['once', 'interval', 'daily', 'weekly', 'cron'],
          description: '新的触发方式；给了就按新的重排下一次。',
        },
        at: { type: 'number', description: 'kind=once 时用：Unix 毫秒时间戳。' },
        every_minutes: { type: 'number', description: 'kind=interval 时用：每隔多少分钟。' },
        time: { type: 'string', description: 'kind=daily / weekly 时用：几点（HH:MM）。' },
        weekday: { type: 'number', description: 'kind=weekly 时用：星期几（0 是周日，6 是周六）。' },
        cron: { type: 'string', description: 'kind=cron 时用：五段表达式。' },
      },
      required: ['id'],
    },
    async execute(args: unknown, ctx: ScheduleToolContext): Promise<ScheduleToolResult> {
      const conversationId = ctx.conversationId
      if (conversationId === undefined || conversationId.trim().length === 0) {
        return failure('提醒只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const id = stringField(parsed, 'id')
      if (id === undefined || id.trim().length === 0) {
        return failure('缺少 id：先 schedule_list 查一下要改哪一条。')
      }
      const text = stringField(parsed, 'text')
      const title = stringField(parsed, 'title')
      const enabled = booleanField(parsed, 'enabled')
      const kind = stringField(parsed, 'kind')
      try {
        const owned = ownTask(host, id, conversationId)
        if (owned === undefined) {
          return failure(`这条提醒不属于当前会话，或者已经不在了：${id}`)
        }
        const trigger = kind === undefined ? undefined : parseTrigger(parsed)
        const task = host.update({
          id,
          ...(text === undefined ? {} : { text }),
          ...(title === undefined ? {} : { title }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(trigger === undefined ? {} : { trigger }),
        })
        return { content: `提醒已改。\n${renderTask(task)}` }
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

/**
 * 建 `schedule_delete` 工具：删一条提醒。
 *
 * 删除不可逆，所以工具要求显式带 `confirmed: true`：没带就返回一句让人去确认的话，
 * 而不是默默删掉。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createScheduleDeleteTool(host: ScheduleToolHost): ScheduleTool {
  return {
    name: SCHEDULE_DELETE_TOOL_NAME,
    description:
      '删掉当前会话的一条提醒。删除不可逆，所以必须带 confirmed=true——先跟用户确认再删。' +
      '用户只是要「先别提醒了」时用 schedule_update 把 enabled 设成 false。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删的提醒 id（用 schedule_list 查）。' },
        confirmed: { type: 'boolean', description: '确认删除：必须为 true，否则不会真删。' },
      },
      required: ['id'],
    },
    async execute(args: unknown, ctx: ScheduleToolContext): Promise<ScheduleToolResult> {
      const conversationId = ctx.conversationId
      if (conversationId === undefined || conversationId.trim().length === 0) {
        return failure('提醒只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const id = stringField(parsed, 'id')
      if (id === undefined || id.trim().length === 0) {
        return failure('缺少 id：先 schedule_list 查一下要删哪一条。')
      }
      const confirmed = booleanField(parsed, 'confirmed') === true
      try {
        const owned = ownTask(host, id, conversationId)
        if (owned === undefined) {
          return failure(`这条提醒不属于当前会话，或者已经不在了：${id}`)
        }
        host.remove(id, confirmed)
        return { content: `提醒 ${id} 已删除。` }
      } catch (error) {
        return failureOf(error)
      }
    },
  }
}

/**
 * 建这个族看得见的四件工具。
 * @param host - 服务。
 * @returns 四件工具（按 create / list / update / delete 排好）。
 */
export function createScheduleTools(host: ScheduleToolHost): readonly ScheduleTool[] {
  return [
    createScheduleCreateTool(host),
    createScheduleListTool(host),
    createScheduleUpdateTool(host),
    createScheduleDeleteTool(host),
  ]
}

/** 失败结果。 */
function failure(content: string): ScheduleToolResult {
  return { content, isError: true }
}

/**
 * 取出这条提醒，并核对它是不是当前会话的。
 *
 * 归属按会话：别的会话的提醒既不该被看见，也不该被改掉或删掉。
 * @returns 属于当前会话的提醒；不是或已经不在了时 undefined。
 */
function ownTask(host: ScheduleToolHost, id: string, conversationId: string): ScheduleTask | undefined {
  const task = host.get(id)
  if (task === undefined) return undefined
  if (task.conversationId !== conversationId) return undefined
  return task
}

/** 领域错误转成一句人话；别的异常照原样抛出去。 */
function failureOf(error: unknown): ScheduleToolResult {
  if (error instanceof ScheduleError) return failure(error.message)
  throw error
}
