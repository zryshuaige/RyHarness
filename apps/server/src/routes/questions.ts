/**
 * 提问路由：列表与回答。
 *
 * 路由由 `ask-user` 插件经 RouteRegistry 挂载，插件关闭后一起 404；问题文件
 * 本身保留。这里只做 HTTP 入参校验与错误映射，存储语义在 {@link QuestionStore}。
 * @module @ryharness/server/routes/questions
 */

import {
  MAX_CONVERSATION_ID_LENGTH,
  QuestionError,
  type QuestionStatus,
  type QuestionStore,
} from '../plugins/ask-user-store.ts'
import { type Handler, HttpRequestError, json } from '../router.ts'

/** 提问路由的依赖。 */
export interface QuestionRoutesDeps {
  store: QuestionStore
  conversationExists(conversationId: string): boolean
}

/** 两条路由的 handler。 */
export interface QuestionHandlers {
  list: Handler
  answer: Handler
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === 'string'
    })
  )
}

/** conversationId 校验：非空、长度受限、会话必须存在。 */
function requireConversationId(value: string | null | undefined, deps: QuestionRoutesDeps): string {
  const conversationId = typeof value === 'string' ? value.trim() : ''
  if (conversationId.length === 0) {
    throw new HttpRequestError(400, 'conversationId 是必填的', 'QUESTION_BAD_REQUEST')
  }
  if (conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
    throw new HttpRequestError(400, 'conversationId 太长了', 'QUESTION_BAD_REQUEST')
  }
  if (!deps.conversationExists(conversationId)) {
    throw new HttpRequestError(404, `没有这个会话：${conversationId}`, 'QUESTION_UNKNOWN_CONVERSATION')
  }
  return conversationId
}

/** 把存储层错误翻成 4xx；其余错误继续冒泡成 500。 */
function sendQuestionFailure(error: unknown): never {
  if (error instanceof QuestionError) {
    if (error.code === 'NOT_FOUND') throw new HttpRequestError(404, error.message, 'QUESTION_NOT_FOUND')
    throw new HttpRequestError(400, error.message, 'QUESTION_BAD_REQUEST')
  }
  throw error
}

/** 造出两条路由的 handler。 */
export function createQuestionHandlers(deps: QuestionRoutesDeps): QuestionHandlers {
  const list: Handler = async (req, res) => {
    const conversationId = requireConversationId(req.query.get('conversationId'), deps)
    const requested = req.query.get('status') ?? 'all'
    if (requested !== 'pending' && requested !== 'answered' && requested !== 'all') {
      throw new HttpRequestError(400, 'status 只能是 pending / answered / all', 'QUESTION_BAD_REQUEST')
    }
    json(res, 200, { questions: deps.store.list(conversationId, requested as QuestionStatus) })
  }

  const answer: Handler = async (req, res) => {
    const id = req.params.id ?? ''
    if (id.length === 0) throw new HttpRequestError(400, '提问 id 是必填的', 'QUESTION_BAD_REQUEST')
    const body = await req.body()
    if (!isRecord(body)) {
      throw new HttpRequestError(400, '请求体必须是 JSON 对象', 'QUESTION_BAD_REQUEST')
    }
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim().length === 0) {
      throw new HttpRequestError(400, '回答内容不能为空', 'QUESTION_BAD_REQUEST')
    }
    const selected = body.selected
    if (selected !== undefined && !isStringArray(selected)) {
      throw new HttpRequestError(400, 'selected 必须是字符串数组', 'QUESTION_BAD_REQUEST')
    }
    try {
      const question = await deps.store.answer(id, {
        text,
        ...(selected === undefined ? {} : { selected }),
      })
      json(res, 200, question)
    } catch (error) {
      sendQuestionFailure(error)
    }
  }

  return { list, answer }
}
