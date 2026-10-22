/**
 * 待办路由的纯 handler 工厂：列表 / 勾选 / 清空 / 撤销清空。
 *
 * 路由由 `todo` 插件经 RouteRegistry 挂载；插件关闭后三条路由一起 404，文件里的
 * 清单保留。这里只做 HTTP 入参校验与错误映射：conversationId 必须是真实存在的
 * 会话（避免往一份永远没人看的清单里写数据），done 必须是布尔值。
 * @module @ryharness/server/routes/todos
 */

import {
  MAX_CONVERSATION_ID_LENGTH,
  MAX_TODO_TEXT_LENGTH,
  TodoError,
  type TodoItem,
  type TodoStore,
} from '../plugins/todo-store.ts'
import { type Handler, HttpRequestError, json, strField } from '../router.ts'

/** 待办路由的依赖。 */
export interface TodoRoutesDeps {
  store: TodoStore
  conversationExists(conversationId: string): boolean
}

/** 三条路由的 handler。 */
export interface TodoHandlers {
  list: Handler
  setDone: Handler
  clear: Handler
  /** 撤销清空：把一批待办原样写回。 */
  restore: Handler
}

/** conversationId 校验：非空、长度受限、会话必须存在。 */
function requireConversationId(value: string | null | undefined, deps: TodoRoutesDeps): string {
  const conversationId = typeof value === 'string' ? value.trim() : ''
  if (conversationId.length === 0) {
    throw new HttpRequestError(400, 'conversationId 是必填的', 'TODO_BAD_REQUEST')
  }
  if (conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
    throw new HttpRequestError(400, 'conversationId 太长了', 'TODO_BAD_REQUEST')
  }
  if (!deps.conversationExists(conversationId)) {
    throw new HttpRequestError(404, `没有这个会话：${conversationId}`, 'TODO_UNKNOWN_CONVERSATION')
  }
  return conversationId
}

/** 把存储层错误翻成 4xx；其余错误继续冒泡成 500。 */
function sendTodoFailure(error: unknown): never {
  if (error instanceof TodoError) {
    if (error.code === 'NOT_FOUND') throw new HttpRequestError(404, error.message, 'TODO_NOT_FOUND')
    throw new HttpRequestError(400, error.message, 'TODO_BAD_REQUEST')
  }
  throw error
}

/** 造出三条路由的 handler。 */
export function createTodoHandlers(deps: TodoRoutesDeps): TodoHandlers {
  const list: Handler = async (req, res) => {
    const conversationId = requireConversationId(req.query.get('conversationId'), deps)
    json(res, 200, deps.store.list(conversationId))
  }

  const setDone: Handler = async (req, res) => {
    const body = await req.body()
    const conversationId = requireConversationId(strField(body, 'conversationId'), deps)
    const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).done : undefined
    if (typeof value !== 'boolean') {
      throw new HttpRequestError(400, 'done 必须是布尔值', 'TODO_BAD_REQUEST')
    }
    const id = req.params.id ?? ''
    if (id.length === 0) throw new HttpRequestError(400, '待办 id 是必填的', 'TODO_BAD_REQUEST')
    try {
      json(res, 200, await deps.store.setDone(conversationId, id, value))
    } catch (error) {
      sendTodoFailure(error)
    }
  }

  const clear: Handler = async (req, res) => {
    const conversationId = requireConversationId(req.query.get('conversationId'), deps)
    try {
      json(res, 200, await deps.store.clear(conversationId))
    } catch (error) {
      sendTodoFailure(error)
    }
  }

  /**
   * 撤销清空：把被清掉的那批待办原样写回。
   *
   * 入参是客户端回传的那几条（清空前它自己就有），逐条校验形状——这是写路径，
   * 不能让一段畸形 JSON 变成清单里的垃圾行。
   */
  const restore: Handler = async (req, res) => {
    const body = (await req.body()) as { conversationId?: unknown; items?: unknown }
    const conversationId = requireConversationId(
      typeof body.conversationId === 'string' ? body.conversationId : undefined,
      deps,
    )
    const raw = Array.isArray(body.items) ? body.items : []
    const items: TodoItem[] = []
    for (const entry of raw) {
      const candidate = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
      const text = typeof candidate.text === 'string' ? candidate.text : ''
      if (id.length === 0 || text.trim().length === 0) {
        throw new HttpRequestError(400, '待办的 id 与内容都是必填的', 'TODO_BAD_REQUEST')
      }
      if (text.length > MAX_TODO_TEXT_LENGTH) {
        throw new HttpRequestError(400, `待办内容最多 ${MAX_TODO_TEXT_LENGTH} 字`, 'TODO_BAD_REQUEST')
      }
      items.push({
        id,
        text,
        done: candidate.done === true,
        createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      })
    }
    try {
      json(res, 200, await deps.store.restore(conversationId, items))
    } catch (error) {
      sendTodoFailure(error)
    }
  }

  return { list, setDone, clear, restore }
}
