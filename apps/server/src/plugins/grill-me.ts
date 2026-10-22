/**
 * 内置插件：盘问（grill me）。
 *
 * 这个插件提供两样东西：
 * 1. **一条 skill**「grill me」——把一句模糊的需求盘问成能开工的方案的工作法
 *    （正文见 ../vibe/skills.ts）。skill 是「不需要写代码的那部分能力」：它直接
 *    进 agent 的系统提示。
 * 2. **一个工具** `grill`——把问题送到用户面前（带选项，用户点一下就是答案）。
 *
 * 为什么不用现成的 `ask_user` 就够了：`ask_user` 允许问开放题、允许一轮问很多题、
 * 也不管总共问了几轮。而 RyVibe 的产品承诺是「用户全程只需要点几下」——所以
 * 盘问工具自己带三条硬约束：**每题必带选项、一轮最多两题、最多两轮**。
 * 约束落在工具里（模型绕不过去），而不是写在 skill 正文里（模型可能不听）。
 *
 * 工具只对「正在进行的那次 RyVibe」可用：它靠会话 id 反查 RyVibe 的记录，
 * 查不到就是硬错误。助理自己的工具清单是常驻的，不会为了这个功能页被改掉。
 * @module @ryharness/server/plugins/grill-me
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import type { VibeStore } from '../vibe/store.ts'
import type { QuestionStore } from './ask-user-store.ts'
import type { PluginEntry } from './host.ts'
import { GRILL_ME_SKILL, GRILL_ME_SKILL_ID, GRILL_TOOL_NAME, SCAFFOLD_TOOL_NAME } from './skills.ts'
import type { TodoStore } from './todo-store.ts'
import { createScaffoldTool } from './vibe-scaffold.ts'

export const GRILL_ME_PLUGIN_ID = 'grill-me'

/** 盘问工具的名字。方法与工具绑在一起（见 skills.ts 的 SkillSpec.tools）。 */
export { GRILL_TOOL_NAME }

/** 盘问的选项数：少于两个没法选，多于五个用户会开始读题。 */
export const MIN_GRILL_OPTIONS = 2
export const MAX_GRILL_OPTIONS = 5
/** 问题的字数上限：太长用户在卡片上读不完。 */
export const MAX_GRILL_QUESTION = 120

/** 工具回给模型的停止信号：问够了就别再问，去出方案。 */
export const GRILL_STOP = '这一轮的问题已经问够了（或者已经问满两轮）。不要再问用户；请直接给出你的结论或方案。'

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === 'string'
    })
  )
}

function failure(content: string): ToolResult {
  return { content, isError: true }
}

/**
 * `grill` 工具：提一个带选项的问题，等用户点选。
 *
 * 会话与发起者来自 ToolContext（AgentLoop 每轮注入），模型不能自己编：问题要落到
 * 正确的会话里，答案也只会回到问问题的那位 agent。
 */
export function createGrillTool(deps: { questions: QuestionStore; vibe: VibeStore }): Tool {
  return {
    name: GRILL_TOOL_NAME,
    description: [
      '盘问用户：把一句模糊的需求问清楚，好让它能开工。',
      '一次提 1 个问题，必须带 2–5 个选项（用户点一下就是答案，不要让他写字）；',
      '选项要覆盖不同方向，最后一个留给「都不对 / 我自己说」。',
      '这一轮最多提 4 个问题，问完就停手去出方案——一轮问完，不要挤牙膏，也不要分两轮。',
      '只在这一次 RyVibe 里用；普通聊天不要调用它。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，一句话说清，最多 120 字。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: MIN_GRILL_OPTIONS,
          maxItems: MAX_GRILL_OPTIONS,
          description: '2–5 个选项，用户点一个即可；不要传空数组，也不要省略。',
        },
      },
      required: ['question', 'options'],
    },
    // 同一条消息里的多条提问也要按顺序落盘：并发写会让问题在文件里的次序随机。
    executionMode: 'sequential',
    execute: async (args, context: ToolContext): Promise<ToolResult> => {
      const conversationId = context.conversationId
      if (conversationId === undefined || conversationId.length === 0) {
        return failure('盘问只能在会话里使用：这次调用没有会话上下文。')
      }
      const session = deps.vibe.byConversation(conversationId)
      if (session === undefined) {
        return failure('这个会话不是一次 RyVibe，grill 不能用。请按你原本的职责做事。')
      }
      const parsed = argsOf(args)
      const question = parsed.question
      if (typeof question !== 'string' || question.trim().length === 0) {
        return failure('question 是必填的，且不能为空。')
      }
      // 长度自己先卡一道：描述里承诺了 120 字，就得真的挡住。落到存储层才报错的话，
      // 名额已经被占掉了（见下面的回滚），模型会白重试到这一轮问不动为止。
      if ([...question.trim()].length > MAX_GRILL_QUESTION) {
        return failure(`问题最多 ${MAX_GRILL_QUESTION} 字，说短一点。`)
      }
      const options = parsed.options
      if (!isStringArray(options) || options.length < MIN_GRILL_OPTIONS || options.length > MAX_GRILL_OPTIONS) {
        return failure(`options 必须带 ${MIN_GRILL_OPTIONS}–${MAX_GRILL_OPTIONS} 个选项：用户是点选的，不写字。`)
      }
      // 先占名额：提问存储里没有「删掉一道题」这个动作，先记后判会留下一道
      // 用户其实不该看到的题。
      const allowed = await deps.vibe.reserveAsk(session.id)
      if (!allowed) return failure(GRILL_STOP)
      try {
        const entry = await deps.questions.ask({
          conversationId,
          ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
          question: question.trim(),
          options,
        })
        await deps.vibe.noteQuestion(session.id, entry.id)
        return {
          content:
            '这个问题已经进到卡片里，等这一轮的问题都问完，用户会一次看到并一起回答；本轮到此为止，请不要再问别的。',
        }
      } catch (error) {
        // 落题失败要把名额还回去：不然模型问了个超长问题就把本轮的名额白吃了，
        // 用户一个问题都没被问到，而界面上还写着「小队想先问清楚几件事」。
        await deps.vibe.releaseAsk(session.id)
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** 盘问插件的依赖：提问存储与 RyVibe 存储由组合根持有。 */
export interface GrillMePluginDeps {
  questions: QuestionStore
  vibe: VibeStore
  /** 待办存储：落盘时把任务清单写进去（与待办插件共用同一份）。 */
  todos: TodoStore
  /** 工作区根目录：项目骨架落在这里。 */
  workspaceRoot: string
}

/** 盘问插件入口：工具 + 一条 skill，全部随插件 fiber 装卸。 */
export function grillMePlugin(deps: GrillMePluginDeps): PluginEntry {
  return {
    id: GRILL_ME_PLUGIN_ID,
    name: '盘问与落地（RyVibe）',
    description:
      '给助理一套 RyVibe 的工作法：需求不够清楚时用带选项的问题问清楚再动手，方案定了就落成一个能打开的项目骨架。',
    group: 'feature',
    capabilities: {
      tools: [GRILL_TOOL_NAME, SCAFFOLD_TOOL_NAME],
    },
    skills: [GRILL_ME_SKILL],
    impact: '关闭后 RyVibe 不再会盘问用户，也不再落盘项目——它会按自己的理解直接给一段方案。已有记录保留。',
    inject: ['tools'],
    apply: (ctx: Context) => {
      ctx.tools.register(createGrillTool(deps))
      ctx.tools.register(
        createScaffoldTool({
          vibe: deps.vibe,
          todos: deps.todos,
          workspaceRoot: deps.workspaceRoot,
        }),
      )
    },
  }
}

export { GRILL_ME_SKILL_ID }
