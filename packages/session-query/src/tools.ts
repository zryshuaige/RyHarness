/**
 * 模型看得见的三件工具：`session_search` / `session_read` / `session_trace`。
 *
 * 这三件是会话历史查询对模型的入口。模型能提的要求只有三类：**搜**（找哪句话）、
 * **读**（把那条消息原样取出来）、**追**（这条消息前后还有什么）。再多的花样
 * （导出、批量统计）不是模型在对话里需要做的事。
 *
 * 工具一律从上下文取会话 id（模型编不出来），所以「查到别的会话」这条隔离
 * 在工具这一层是白送的：模型没有别的会话 id 可填。要跨会话搜时，模型必须显式
 * 说明——那是一次有代价的动作，代价是它自己决定承担的。
 * @module @ryharness/session-query/tools
 */

import type { StoredMessage } from '@ryharness/session'
import type { RelationTrace, RelationTraceOptions, SearchOptions, SearchResult } from './types.ts'

/** 搜索历史的工具名。 */
export const SESSION_SEARCH_TOOL_NAME = 'session_search'
/** 读一条消息的工具名。 */
export const SESSION_READ_TOOL_NAME = 'session_read'
/** 追一条消息关系的工具名。 */
export const SESSION_TRACE_TOOL_NAME = 'session_trace'

/** 模型看得见的三件工具的名字。 */
export const SESSION_QUERY_TOOL_NAMES: readonly string[] = Object.freeze([
  SESSION_SEARCH_TOOL_NAME,
  SESSION_READ_TOOL_NAME,
  SESSION_TRACE_TOOL_NAME,
])

/** 工具执行里这一族关心的上下文。 */
export interface SessionQueryToolContext {
  /** 当前会话 id：默认只在当前会话里查。 */
  readonly conversationId?: string
}

/** 工具结果。 */
export interface SessionQueryToolResult {
  /** 正文，作为 tool 消息进模型历史。 */
  readonly content: string
  /** 是不是错误结果。 */
  readonly isError?: boolean
}

/** 一个可注册的工具。 */
export interface SessionQueryTool {
  /** 工具名（注册进工具表时用它）。 */
  readonly name: string
  /** 给模型看的一句话说明。 */
  readonly description: string
  /** JSON Schema（对象）。 */
  readonly parameters: Record<string, unknown>
  /** 执行。 */
  execute(args: unknown, ctx: SessionQueryToolContext): Promise<SessionQueryToolResult>
}

/** 工具用的服务能力：只暴露工具真正要用的那几件。 */
export interface SessionQueryToolHost {
  /** 搜正文。 */
  search(query: string, options?: SearchOptions): SearchResult
  /** 按 id 取一条消息。 */
  getMessage(messageId: string, options?: { conversationId?: string }): StoredMessage | undefined
  /** 追一条消息和谁有关系。 */
  traceRelations(
    messageId: string,
    options?: RelationTraceOptions & { conversationId?: string },
  ): RelationTrace | undefined
}

/**
 * 建 `session_search` 工具：搜历史正文。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createSessionSearchTool(host: SessionQueryToolHost): SessionQueryTool {
  return {
    name: SESSION_SEARCH_TOOL_NAME,
    description:
      '搜会话历史里的正文（关键词，不是语义检索）。' +
      '返回命中片段、来自哪个会话与哪条消息。' +
      '默认只在当前会话里搜；要跨会话搜，把 allSessions 设为 true。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的关键词。' },
        allSessions: {
          type: 'boolean',
          description: '是否跨所有会话搜（默认 false = 只搜当前会话）。',
        },
        limit: { type: 'number', description: '最多返回几条（默认 10）。' },
      },
      required: ['query'],
    },
    async execute(args: unknown, ctx: SessionQueryToolContext): Promise<SessionQueryToolResult> {
      const parsed = toRecord(args)
      const query = readString(parsed, 'query')
      if (query === undefined || query.trim().length === 0) {
        return failure('缺少 query：没有关键词没法搜。')
      }
      const allSessions = parsed.allSessions === true
      const limit = readNumber(parsed, 'limit') ?? 10
      const conversationId = allSessions ? undefined : ctx.conversationId
      const result = host.search(query, {
        ...(conversationId === undefined ? {} : { conversationId }),
        limit,
      })
      if (result.hits.length === 0) {
        return { content: `没搜到「${result.query}」。` }
      }
      const lines = [`搜到 ${result.hits.length} 条：`, '']
      for (const hit of result.hits) {
        lines.push(
          `- [${hit.conversationId} #${hit.seq}] ${formatTime(hit.createdAt)}：${hit.snippet.replace(/\n/g, ' ')}`,
        )
      }
      return { content: lines.join('\n') }
    },
  }
}

/**
 * 建 `session_read` 工具：把一条消息原样取出来。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createSessionReadTool(host: SessionQueryToolHost): SessionQueryTool {
  return {
    name: SESSION_READ_TOOL_NAME,
    description: '按消息 id 读一条消息的原文。' + '消息 id 从搜索结果或关系追踪结果里拿。' + '默认只在当前会话里找。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '要读的消息 id。' },
        allSessions: {
          type: 'boolean',
          description: '是否跨所有会话找（默认 false = 只在当前会话里找）。',
        },
      },
      required: ['messageId'],
    },
    async execute(args: unknown, ctx: SessionQueryToolContext): Promise<SessionQueryToolResult> {
      const parsed = toRecord(args)
      const messageId = readString(parsed, 'messageId')
      if (messageId === undefined || messageId.length === 0) {
        return failure('缺少 messageId：没有 id 读不了消息。')
      }
      const allSessions = parsed.allSessions === true
      const conversationId = allSessions ? undefined : ctx.conversationId
      const message = host.getMessage(messageId, {
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      if (message === undefined) {
        return failure(`没找到消息 ${messageId}。`)
      }
      return { content: renderMessage(message) }
    },
  }
}

/**
 * 建 `session_trace` 工具：追一条消息和谁有关系。
 * @param host - 服务。
 * @returns 满足工具契约的工具。
 */
export function createSessionTraceTool(host: SessionQueryToolHost): SessionQueryTool {
  return {
    name: SESSION_TRACE_TOOL_NAME,
    description:
      '追一条消息和谁有关系：同一轮里的消息、它回复的那条、引用了它的那些，以及前后文。' +
      '想知道「这句话是在回应什么」「后面接着发生了什么」时用它。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '要追的消息 id。' },
        contextSize: { type: 'number', description: '前后文各取几条（默认 2）。' },
        allSessions: {
          type: 'boolean',
          description: '是否跨所有会话找（默认 false = 只在当前会话里找）。',
        },
      },
      required: ['messageId'],
    },
    async execute(args: unknown, ctx: SessionQueryToolContext): Promise<SessionQueryToolResult> {
      const parsed = toRecord(args)
      const messageId = readString(parsed, 'messageId')
      if (messageId === undefined || messageId.length === 0) {
        return failure('缺少 messageId：没有 id 追不了关系。')
      }
      const allSessions = parsed.allSessions === true
      const conversationId = allSessions ? undefined : ctx.conversationId
      const contextSize = readNumber(parsed, 'contextSize')
      const trace = host.traceRelations(messageId, {
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(contextSize === undefined ? {} : { contextSize }),
      })
      if (trace === undefined) {
        return failure(`没找到消息 ${messageId}。`)
      }
      const lines = [renderMessage(trace.message), '']
      if (trace.repliesTo !== undefined) {
        lines.push('它回复的是：', renderMessage(trace.repliesTo), '')
      }
      if (trace.turnMessages.length > 0) {
        lines.push('同一轮里的其它消息：', ...trace.turnMessages.map(renderMessage), '')
      }
      if (trace.referencedBy.length > 0) {
        lines.push('引用了它的：', ...trace.referencedBy.map(renderMessage), '')
      }
      if (trace.before.length > 0) {
        lines.push('它前面：', ...trace.before.map(renderMessage), '')
      }
      if (trace.after.length > 0) {
        lines.push('它后面：', ...trace.after.map(renderMessage), '')
      }
      return { content: lines.join('\n') }
    },
  }
}

/**
 * 建这个族看得见的三件工具。
 * @param host - 服务。
 * @returns 三件工具（按 search / read / trace 排好）。
 */
export function createSessionQueryTools(host: SessionQueryToolHost): readonly SessionQueryTool[] {
  return [createSessionSearchTool(host), createSessionReadTool(host), createSessionTraceTool(host)]
}

/** 把消息渲染成一段人能看懂的文字。 */
export function renderMessage(message: StoredMessage): string {
  const who = senderLabel(message)
  const head = `[${formatTime(message.createdAt)}] ${who}（${message.id}）：`
  const body = renderBody(message)
  return body.length === 0 ? head : `${head}\n${body}`
}

/** 消息正文：文本块拼起来，工具调用与工具结果另起一行说明。 */
function renderBody(message: StoredMessage): string {
  const lines: string[] = []
  for (const block of message.contentBlocks) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown; name?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') {
      lines.push(record.text)
    } else if (record.type === 'tool-call' && typeof record.name === 'string') {
      lines.push(`（调用工具 ${record.name}）`)
    }
  }
  if (message.toolCallId !== undefined) {
    lines.push(`（工具结果 ${message.toolCallId}）`)
  }
  return lines.join('\n')
}

/** 发言者的显示名。 */
function senderLabel(message: StoredMessage): string {
  if (message.senderType === 'user') return '用户'
  if (message.senderType === 'system') return '系统'
  return message.senderId === undefined ? '助理' : `助理 ${message.senderId}`
}

/** 时间戳格式化成 `YYYY-MM-DD HH:mm:ss`（本地时间）。 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => {
    return value.toString().padStart(2, '0')
  }
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 参数不是对象时按空对象处理。 */
function toRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/** 从参数里读字符串字段；不是字符串就当没给。 */
function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** 从参数里读数字字段；不是有限数字就当没给。 */
function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 失败结果。 */
function failure(content: string): SessionQueryToolResult {
  return { content, isError: true }
}
