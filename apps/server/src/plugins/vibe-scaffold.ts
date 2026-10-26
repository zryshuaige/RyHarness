/**
 * 内置插件：产物落盘、验收与版本快照（RyVibe 的交付闸）。
 *
 * 这个工具是「一句话做出完整产品」这句话能兑现的那一步：小队出完方案，如果只
 * 停在 Markdown 上，用户手上拿到的仍然是一段**描述**——点不开、没法接着改、也没
 * 有一份"接下来做什么"的清单。所以方案定稿后必须调用它：
 *
 * 1. 在工作区里落一个项目目录（README / 方案 / 任务清单 / 首个能打开的页面）；
 * 2. 把任务清单逐条写进**待办插件**的清单——用户不用去别的页面找，它就在聊天页
 *    右侧，能打勾。
 *
 * 约束落在工具入参校验里（模型绕不过去）：任务条数、每条长度、文档长度都有上限，
 * 目录名由工具自己推导（项目名来自模型，`../../etc` 这种名字不能直接当路径用）。
 * @module @ryharness/server/plugins/vibe-scaffold
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import {
  DELIVERABLE_KINDS,
  type DeliverableKind,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_SUMMARY_LENGTH,
  MAX_PROJECT_TASK_LENGTH,
  MAX_PROJECT_TASKS,
  MIN_PROJECT_TASKS,
  scaffoldProject,
} from '../vibe/project.ts'
import type { VibeStore } from '../vibe/store.ts'
import { validateVibeProject } from '../vibe/validation.ts'
import { SCAFFOLD_TOOL_NAME } from './skills.ts'
import type { TodoStore } from './todo-store.ts'

/** 单份文档（README / 方案 / 页面）的字数上限。 */
const MAX_DOC_LENGTH = 60_000
/** 交付物文件名的字数上限：Windows 的路径上限 255 字符，超了整个落盘会抛 ENOENT。 */
const MAX_ARTIFACT_NAME_LENGTH = 60

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function failure(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * 任务清单：模型给的是一个字符串数组。
 *
 * 数组里混进空串或超长的行时**丢掉那一行**而不是整批失败：模型一次给十条、
 * 其中一条超了 120 字时，退回去让它重写十遍，比少收一条糟得多。
 */
function tasksOf(args: Record<string, unknown>): string[] | undefined {
  const raw = args.tasks
  if (!Array.isArray(raw)) return undefined
  const tasks: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text.length === 0) continue
    if (text.length > MAX_PROJECT_TASK_LENGTH) continue
    if (tasks.includes(text)) continue
    tasks.push(text)
  }
  return tasks
}

/**
 * `vibe_scaffold` 工具：把方案落成一个能打开的项目骨架。
 *
 * 会话 id 来自 ToolContext，模型不能自己编：骨架必须落在这一次 RyVibe 名下，
 * 任务清单也必须进这一个会话的待办。
 */
export function createScaffoldTool(deps: {
  vibe: VibeStore
  todos: TodoStore
  /** 工作区根目录（绝对路径）：骨架落在这里。 */
  workspaceRoot: string
}): Tool {
  return {
    name: SCAFFOLD_TOOL_NAME,
    description: [
      '把实际产物落成文件并验收；骨架、空章节、TODO 展示页和无效表格会被退回：',
      '先看用户要的到底是什么形态，再按形态给字段——**填错字段会被挡回来，不会被悄悄丢掉**：',
      '· app（一个能打开的小程序）：readme / plan（方案正文）/ page（那个 HTML 页面）；',
      '· doc（一份文档：方案、报告、邮件）：content 放正文，artifactName 给文件名；',
      '· sheet（一张表或清单）：content 放 CSV，artifactName 给文件名；',
      '· flow（一个以后照着做的流程）：content 放步骤，artifactName 给文件名。',
      '不管哪种形态，任务清单都会逐条写进当前会话的待办（用户能在聊天页右侧看到并打勾）。',
      '形态想清楚了才调用它——每个项目只落一次，重复调用会覆盖同名目录。',
      '只在这一次 RyVibe 里用；普通聊天不要调用它。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: `项目名（最多 ${MAX_PROJECT_NAME_LENGTH} 字），会当目录名用。`,
        },
        summary: {
          type: 'string',
          description: `一句话说明这个产品做什么（最多 ${MAX_PROJECT_SUMMARY_LENGTH} 字）。`,
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          minItems: MIN_PROJECT_TASKS,
          maxItems: MAX_PROJECT_TASKS,
          description: `第一版要做的事，${MIN_PROJECT_TASKS}–${MAX_PROJECT_TASKS} 条，每条一句话（最多 ${MAX_PROJECT_TASK_LENGTH} 字）。`,
        },
        readme: {
          type: 'string',
          description: 'README 正文（Markdown）；不给就按项目名、说明与任务清单自动生成一份。',
        },
        plan: {
          type: 'string',
          description: 'app 形态的方案正文（Markdown）；其他形态别填这个。',
        },
        page: {
          type: 'string',
          description: 'app 形态的页面 HTML；其他形态别填这个。',
        },
        deliverable: {
          type: 'string',
          enum: [...DELIVERABLE_KINDS],
          description:
            '用户到底要个什么东西：app=一个能打开的小程序，doc=一份文档（方案/报告/邮件），sheet=一张表或清单，flow=一个以后照着做的流程。按你问到的「最后要的东西是个什么」给，别一律当软件。',
        },
        artifactName: {
          type: 'string',
          description: '交付物的文件名（不含扩展名）；doc/sheet/flow 时用得上。',
        },
        content: {
          type: 'string',
          description: '交付物正文：doc/flow 用 Markdown，sheet 用 CSV。给了就用它给的，别拿别的东西顶替。',
        },
      },
      required: ['name', 'summary', 'tasks'],
    },
    // 落盘与写待办都要按顺序：并发调用会把两个项目写进同一个目录。
    executionMode: 'sequential',
    execute: async (args, context: ToolContext): Promise<ToolResult> => {
      const conversationId = context.conversationId
      if (conversationId === undefined || conversationId.length === 0) {
        return failure('落盘只能在会话里使用：这次调用没有会话上下文。')
      }
      const session = deps.vibe.byConversation(conversationId)
      if (session === undefined) {
        return failure('这个会话不是一次 RyVibe，落盘工具不能用。请按你原本的职责做事。')
      }
      const parsed = argsOf(args)
      const name = stringField(parsed, 'name')?.trim() ?? ''
      if (name.length === 0) return failure('name 是必填的：项目得有个名字。')
      if (name.length > MAX_PROJECT_NAME_LENGTH) {
        return failure(`项目名最多 ${MAX_PROJECT_NAME_LENGTH} 字，说短一点。`)
      }
      const summary = stringField(parsed, 'summary')?.trim() ?? ''
      if (summary.length === 0) return failure('summary 是必填的：一句话说清这个产品做什么。')
      if (summary.length > MAX_PROJECT_SUMMARY_LENGTH) {
        return failure(`一句话说明最多 ${MAX_PROJECT_SUMMARY_LENGTH} 字。`)
      }
      const tasks = tasksOf(parsed)
      if (tasks === undefined) return failure('tasks 是必填的：一个字符串数组。')
      if (tasks.length < MIN_PROJECT_TASKS) {
        return failure(`至少给 ${MIN_PROJECT_TASKS} 条任务：没有任务的骨架不算产品。`)
      }
      if (tasks.length > MAX_PROJECT_TASKS) {
        return failure(`任务最多 ${MAX_PROJECT_TASKS} 条，先挑出第一版真正要做的。`)
      }
      const readme = stringField(parsed, 'readme')?.trim()
      const plan = stringField(parsed, 'plan')?.trim()
      const page = stringField(parsed, 'page')?.trim()
      const content = stringField(parsed, 'content')?.trim()
      const artifactName = stringField(parsed, 'artifactName')?.trim()
      const deliverable = stringField(parsed, 'deliverable')?.trim()
      if (
        deliverable !== undefined &&
        deliverable.length > 0 &&
        !DELIVERABLE_KINDS.includes(deliverable as DeliverableKind)
      ) {
        return failure(`deliverable 只能是 ${DELIVERABLE_KINDS.join(' / ')}。`)
      }
      if (readme !== undefined && readme.length > MAX_DOC_LENGTH) {
        return failure(`README 太长了（${readme.length} 字，上限 ${MAX_DOC_LENGTH}）。`)
      }
      if (plan !== undefined && plan.length > MAX_DOC_LENGTH) {
        return failure(`方案正文太长了（${plan.length} 字，上限 ${MAX_DOC_LENGTH}）。`)
      }
      if (page !== undefined && page.length > MAX_DOC_LENGTH) {
        return failure(`页面代码太长了（${page.length} 字，上限 ${MAX_DOC_LENGTH}）。`)
      }
      if (content !== undefined && content.length > MAX_DOC_LENGTH) {
        return failure(`交付物正文太长了（${content.length} 字，上限 ${MAX_DOC_LENGTH}）。`)
      }
      if (artifactName !== undefined && artifactName.length > MAX_ARTIFACT_NAME_LENGTH) {
        return failure(`交付物文件名最多 ${MAX_ARTIFACT_NAME_LENGTH} 字，说短一点。`)
      }
      // **形态与字段对不上就说出来**：静默丢掉正文是最坏的一种失败——用户拿到一个
      // 空骨架，回执还说"已落盘"，他不会知道自己的内容没了。
      const kind: DeliverableKind =
        deliverable === undefined || deliverable.length === 0 ? 'app' : (deliverable as DeliverableKind)
      if (kind === 'app') {
        if (content !== undefined && content.length > 0) {
          return failure('app 形态不收 content：那个 HTML 页面放 page，方案正文放 plan。')
        }
        if (page === undefined || page.length === 0) {
          return failure('app 形态要给出实现核心交互的完整 page HTML；只给方案或 TODO 展示页不算交付。')
        }
      } else {
        if ((page !== undefined && page.length > 0) || (plan !== undefined && plan.length > 0)) {
          return failure(`${kind} 形态不写页面和方案：正文放 content，文件名放 artifactName。`)
        }
        if (content === undefined || content.length === 0) {
          return failure(`${kind} 形态要把正文给出来：正文放 content（sheet 用 CSV，其余用 Markdown）。`)
        }
      }
      const project = scaffoldProject({
        workspaceRoot: deps.workspaceRoot,
        name,
        summary,
        tasks,
        ...(deliverable === undefined || deliverable.length === 0 ? {} : { deliverable: kind }),
        ...(artifactName === undefined || artifactName.length === 0 ? {} : { artifactName }),
        ...(content === undefined || content.length === 0 ? {} : { content }),
        ...(readme === undefined || readme.length === 0 ? {} : { readme }),
        ...(plan === undefined || plan.length === 0 ? {} : { plan }),
        ...(page === undefined || page.length === 0 ? {} : { page }),
      })
      await deps.vibe.setStage(session.id, 'verify')
      const validation = validateVibeProject(project)
      if (!validation.ok) {
        await deps.vibe.setStage(session.id, 'execute', validation.summary)
        return failure(`产物还没有通过验收：${validation.summary}。请修正实际内容后重新调用本工具，不要只解释原因。`)
      }
      await deps.vibe.setProject(session.id, project, validation)
      // 任务清单进待办：同一句话已经在清单里就不重复加（模型重出一版时会再调一次）。
      const existing = deps.todos.list(conversationId)
      let added = 0
      for (const task of tasks) {
        const duplicated = existing.items.some((item) => {
          return item.text === task
        })
        if (duplicated) continue
        await deps.todos.add(conversationId, task)
        added += 1
      }
      const files = project.files
        .map((file) => {
          return file.name
        })
        .join('、')
      return {
        content: [
          `项目已落在 ${project.dir}：${files}。`,
          added > 0 ? `任务清单已写进当前会话的待办（新增 ${added} 条）。` : '任务清单已经在待办里，没有重复添加。',
          '接下来用一段话说清这个产品的样子（用户在页面上会看到），不用再重复文件内容。',
        ].join('\n'),
      }
    },
  }
}
