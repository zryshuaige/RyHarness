/**
 * `/goal` 命令：人直接看与控制目标，**不花模型一轮**。
 *
 * 这一族做的是「人是主人」这件事：主人想看目标现在什么样、想把它停掉或标完成，
 * 不该先跟模型解释一遍再等模型转述。命令直接跑服务，结果给界面看。
 *
 * 命令定义是**纯数据**（名字、说明、execute 函数），形状与 `@ryharness/commands`
 * 的命令定义一致，宿主拿它直接注册即可——本包不依赖那个包，宿主想改字段形状也随它。
 * @module @ryharness/goal/command
 */

import type { GoalService } from './service.ts'
import { GOAL_STATUS_LABELS } from './service.ts'
import { GoalError } from './types.ts'

/** `/goal` 的命令名。 */
export const GOAL_COMMAND_NAME = 'goal'

/** 命令拿到的参数（与 `@ryharness/commands` 的形状一致）。 */
export interface GoalCommandArgs {
  /** 去掉命令名之后的首尾空白参数文本。 */
  readonly input: string
  /** 参数原文（保留分隔空白）。 */
  readonly raw: string
  /** 整行原始输入。 */
  readonly line: string
  /** 这次执行的上下文（宿主给的；形状与 `@ryharness/commands` 的 CommandContext 一致）。 */
  readonly context?: GoalCommandContext
}

/** 命令执行时的上下文（宿主给的）。 */
export interface GoalCommandContext {
  /** 当前会话 id。 */
  readonly sessionId?: string
}

/** 命令跑完的结果。 */
export interface GoalCommandResult {
  /** 给界面看的文本。 */
  readonly text: string
  /** 是否出错。缺省即没出错。 */
  readonly isError?: boolean
}

/**
 * 一条命令的定义。
 *
 * 形状刻意与 `@ryharness/commands` 的 `CommandDefinition` 对齐：宿主把它塞进命令
 * 注册表就能用，本包不必依赖命令包。
 */
export interface GoalCommandDefinition {
  /** 命令名（不含斜杠）。 */
  readonly name: string
  /** 一句话说明：这条命令干什么。 */
  readonly description: string
  /** 别名（不含斜杠）。 */
  readonly aliases?: readonly string[]
  /** 执行。 */
  execute(args: GoalCommandArgs): Promise<GoalCommandResult>
}

/** 建命令时的依赖。 */
export interface GoalCommandOptions {
  /**
   * 当前会话 id 的取法。
   *
   * 目标按会话归属，所以命令必须知道「这是哪个会话的命令」——命令本身没有会话上下文，
   * 宿主给一个取法（从界面状态、从 HTTP 请求、从当前打开的会话）。
   *
   * 上下文由宿主在**这次执行**里传进来（`args.context`），不是宿主自己记一份全局
   * 「当前会话」：两个会话同时敲命令时，全局那份会张冠李戴。
   */
  readonly resolveSessionId: (context?: GoalCommandContext) => string | undefined
}

/**
 * 建 `/goal` 命令。
 *
 * 支持的写法：
 * - `/goal` 或 `/goal list`：看当前目标（标题、状态、完成判据）与最近几次改动；
 * - `/goal set <标题>`：定目标（没有就建，有了就改标题）；
 * - `/goal stop`：暂停；
 * - `/goal resume`：恢复；
 * - `/goal complete`：标记完成；
 * - `/goal clear`：清除。
 *
 * @param service - 目标服务。
 * @param options - 会话 id 的取法。
 * @returns 可直接注册的命令定义。
 */
export function createGoalCommand(service: GoalService, options: GoalCommandOptions): GoalCommandDefinition {
  return {
    name: GOAL_COMMAND_NAME,
    description:
      '看与控制当前会话的目标：/goal 看现状，/goal set <标题> 定目标，/goal stop 暂停，/goal complete 完成。',
    async execute(args: GoalCommandArgs): Promise<GoalCommandResult> {
      const sessionId = options.resolveSessionId(args.context)
      if (sessionId === undefined || sessionId.trim().length === 0) {
        return { text: '目标按会话归属：这条命令得在一个会话里用。', isError: true }
      }
      const [verb = 'list', ...rest] = args.input
        .trim()
        .split(/\s+/u)
        .filter((part) => {
          return part.length > 0
        })
      try {
        if (verb === 'list' || verb === 'show') return showGoal(service, sessionId)
        if (verb === 'set') return setGoal(service, sessionId, rest.join(' '))
        if (verb === 'stop' || verb === 'pause') return changeStatus(service, sessionId, 'paused', '目标已暂停。')
        if (verb === 'resume' || verb === 'start') return changeStatus(service, sessionId, 'active', '目标已恢复。')
        if (verb === 'complete' || verb === 'done')
          return changeStatus(service, sessionId, 'completed', '目标已标记完成。')
        if (verb === 'clear') return changeStatus(service, sessionId, 'cleared', '目标已清除（记录留在历史里）。')
        return {
          text: '用法：/goal（看现状）、/goal set <标题>、/goal stop、/goal resume、/goal complete、/goal clear。',
          isError: true,
        }
      } catch (error) {
        if (error instanceof GoalError) return { text: error.message, isError: true }
        throw error
      }
    },
  }
}

/** 看现状：目标本身 + 最近几次改动。 */
function showGoal(service: GoalService, sessionId: string): GoalCommandResult {
  const goal = service.get(sessionId)
  if (goal === undefined) {
    return { text: '这个会话还没有目标。用 /goal set <标题> 定一个。' }
  }
  const lines = [`目标：${goal.title}`, `状态：${GOAL_STATUS_LABELS[goal.status]}`]
  if (goal.description.length > 0) lines.push(`说明：${goal.description}`)
  if (goal.criteria.length > 0) lines.push(`完成判据：${goal.criteria}`)
  const history = service.history(sessionId)
  const recent = history.slice(-3)
  if (recent.length > 0) {
    lines.push('最近改动：')
    for (const change of recent) lines.push(`- ${change.summary}`)
  }
  return { text: lines.join('\n') }
}

/** 定目标：没有就建，有了就改标题。 */
function setGoal(service: GoalService, sessionId: string, title: string): GoalCommandResult {
  if (title.trim().length === 0) {
    return { text: '要定目标得给个标题：/goal set <标题>。', isError: true }
  }
  const existing = service.get(sessionId)
  if (existing === undefined || existing.status === 'cleared') {
    const goal = service.create({ sessionId, title })
    return { text: `目标已定：${goal.title}\n状态：${GOAL_STATUS_LABELS[goal.status]}` }
  }
  const goal = service.update({ sessionId, title })
  return { text: `目标已改：${goal.title}\n状态：${GOAL_STATUS_LABELS[goal.status]}` }
}

/** 换状态，并说明结果。 */
function changeStatus(
  service: GoalService,
  sessionId: string,
  status: 'paused' | 'active' | 'completed' | 'cleared',
  okText: string,
): GoalCommandResult {
  const goal = service.update({ sessionId, status })
  return { text: `${okText}\n目标：${goal.title}\n状态：${GOAL_STATUS_LABELS[goal.status]}` }
}
