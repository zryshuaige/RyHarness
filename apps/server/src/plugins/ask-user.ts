/**
 * 内置插件：向用户提问。
 *
 * `ask_user` 不挂起本轮：工具只负责把问题落盘并立刻返回，用户回答走 HTTP
 * 路由；下一轮用户消息进入模型前，协调器把「你此前问过…；用户回答…」注入
 * 发起提问的那个 agent 的系统提示。这样待答状态不会占住一个 turn，也不会让
 * 对话链在等一个可能几小时后才来的回答。
 *
 * 问题与回答都归插件 fiber 之外的文件：关闭插件后工具/路由一起下线，记录保留；
 * 重新打开后仍能读回。存储细节见 {@link QuestionStore}。
 * @module @ryharness/server/plugins/ask-user
 */

import type { Tool, ToolContext, ToolResult } from '@ryharness/agent'
import type { Context } from '@ryharness/cordis'
import { createQuestionHandlers } from '../routes/questions.ts'
import { QuestionError, type QuestionStore } from './ask-user-store.ts'
import type { PluginEntry } from './host.ts'

export const ASK_USER_PLUGIN_ID = 'ask-user'

/**
 * 工具调用后立刻回给模型的话：明确「本轮结束」，避免它继续等回答。
 *
 * 第一版还没有专用问题卡，所以明确要求模型在回复里把问题复述给用户——
 * 否则用户只会看到一条「问题卡已发出」的工具行，却找不到问题本身。
 */
export const ASK_USER_RESULT = '已记录这个问题，正在等用户回答；本轮结束。请在你的回复里把问题与选项复述给用户。'

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

function failure(content: string): ToolResult {
  return { content, isError: true }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === 'string'
    })
  )
}

/**
 * `ask_user` 工具：把一个问题（可带 2–6 个选项）交给用户。
 *
 * 会话与发起者来自 ToolContext（AgentLoop 每轮注入），模型不能自己编：问题卡
 * 要落到正确的会话里，群聊里答案也只能回到问问题的那位 agent。
 */
export function createAskUserTool(store: QuestionStore): Tool {
  return {
    name: 'ask_user',
    description:
      '向用户提一个问题，等待用户回答后继续。需要用户确认、补充信息、或从几个选项里做选择时使用；调用后本轮立即结束，用户回答会在下一轮告诉你。不要用它提问自己能查到或能自行决定的事。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要问用户的问题，一句话说清，最多 200 字。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 6,
          description: '可选项，2–6 项、每项最多 80 字；只问开放问题时不要传。',
        },
        multiple: {
          type: 'boolean',
          description: '是否允许多选；只在传了 options 时有意义，缺省单选。',
        },
      },
      required: ['question'],
    },
    // 同一条消息里的多条提问也要按顺序落盘：并发写会让问题在文件里的次序随机。
    executionMode: 'sequential',
    execute: async (args, context: ToolContext): Promise<ToolResult> => {
      const conversationId = context.conversationId
      if (conversationId === undefined || conversationId.length === 0) {
        return failure('提问只能在会话里使用：这次调用没有会话上下文。')
      }
      const parsed = argsOf(args)
      const question = parsed.question
      if (typeof question !== 'string' || question.trim().length === 0) {
        return failure('question 是必填的，且不能为空。')
      }
      const options = parsed.options
      if (options !== undefined && !isStringArray(options)) {
        return failure('options 必须是字符串数组（2–6 项）。')
      }
      const multiple = parsed.multiple
      if (multiple !== undefined && typeof multiple !== 'boolean') {
        return failure('multiple 必须是布尔值。')
      }
      try {
        await store.ask({
          conversationId,
          ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
          question,
          ...(options === undefined ? {} : { options }),
          ...(multiple === undefined ? {} : { multiple }),
        })
        // 只回这句固定文案：它同时是给模型的停止信号；问题 id 供 UI 从
        // GET /api/questions 取，不塞进工具结果改变其语义。
        return { content: ASK_USER_RESULT }
      } catch (error) {
        if (error instanceof QuestionError) return failure(error.message)
        throw error
      }
    },
  }
}

/** 提问插件的依赖：存储由组合根持有（协调器注入同一份数据）。 */
export interface AskUserPluginDeps {
  store: QuestionStore
  conversationExists(conversationId: string): boolean
}

/** 提问插件入口：工具 + 两条路由，全部随插件 fiber 装卸。 */
export function askUserPlugin(deps: AskUserPluginDeps): PluginEntry {
  return {
    id: ASK_USER_PLUGIN_ID,
    name: '向你提问',
    description: '让助理在需要确认或补充信息时向你发一张问题卡；回答会在下一轮自动回到它手里。',
    group: 'feature',
    capabilities: {
      tools: ['ask_user'],
      routes: ['GET /api/questions', 'POST /api/questions/:id/answer'],
    },
    impact: '关闭后助理将无法向你提问，已有的问题记录保留；重新打开后恢复。',
    inject: ['tools', 'routes'],
    apply: (ctx: Context) => {
      ctx.tools.register(createAskUserTool(deps.store))
      const handlers = createQuestionHandlers({ store: deps.store, conversationExists: deps.conversationExists })
      ctx.routes.register('GET', '/api/questions', handlers.list)
      ctx.routes.register('POST', '/api/questions/:id/answer', handlers.answer)
    },
  }
}
