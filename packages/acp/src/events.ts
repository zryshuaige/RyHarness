/**
 * ACP 的事件形状。
 *
 * 事件是这一层对外承诺的东西：**字段名固定、带版本号**。编辑器拿到一条事件
 * 就该知道这是什么、字段在哪——所以这里每个事件都带 `version`、`kind` 与
 * `seq`（序号，用来判断有没有漏收）。
 *
 * 收到不认识的事件时**丢掉并报一声**，不猜、不炸——对端升级了协议不该让整个
 * 会话垮掉。
 * @module @ryharness/acp/events
 */

/** 事件格式版本。 */
export const ACP_EVENT_VERSION = 1

/** 工具调用的状态。 */
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** 工具的种类。 */
export type AcpToolKind = 'read' | 'edit' | 'execute' | 'other'

/** 一轮为什么停。 */
export type AcpStopReason = 'end_turn' | 'cancelled' | 'error'

/** 每个事件都有的那几个字段。 */
export interface AcpEventBase {
  /** 事件格式版本。 */
  readonly version: typeof ACP_EVENT_VERSION
  /** 属于哪个会话。 */
  readonly sessionId: string
  /** 会话内的序号，从 1 开始。 */
  readonly seq: number
}

/** 一段文本增量。 */
export interface AcpMessageChunkEvent extends AcpEventBase {
  readonly kind: 'message_chunk'
  /** 这一段的文本。 */
  readonly text: string
}

/** 一次工具调用（开始或状态变化）。 */
export interface AcpToolCallEvent extends AcpEventBase {
  readonly kind: 'tool_call'
  /** 工具调用的 id，与工具结果对得上。 */
  readonly callId: string
  /** 人看的标题。 */
  readonly title: string
  /** 当前状态。 */
  readonly status: AcpToolCallStatus
  /** 工具的种类。 */
  readonly toolKind?: AcpToolKind
}

/** 一次工具调用的结果。 */
export interface AcpToolResultEvent extends AcpEventBase {
  readonly kind: 'tool_result'
  /** 对应哪次工具调用。 */
  readonly callId: string
  /** 成功还是失败。 */
  readonly status: 'completed' | 'failed'
  /** 结果正文。 */
  readonly content: string
}

/** 一轮结束。 */
export interface AcpCompletedEvent extends AcpEventBase {
  readonly kind: 'completed'
  /** 为什么停。 */
  readonly stopReason: AcpStopReason
}

/** 出错了。 */
export interface AcpErrorEvent extends AcpEventBase {
  readonly kind: 'error'
  /** 机器码。 */
  readonly code: string
  /** 人看的说明。 */
  readonly message: string
}

/** 全部事件。 */
export type AcpEvent = AcpMessageChunkEvent | AcpToolCallEvent | AcpToolResultEvent | AcpCompletedEvent | AcpErrorEvent

/**
 * 读一个对象上的字符串字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是字符串时是 undefined。
 */
function readString(source: object, key: string): string | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * 读一个对象上的数字字段。
 * @param source - 对象。
 * @param key - 字段名。
 * @returns 字段值；不是数字时是 undefined。
 */
function readNumber(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key)
  return typeof value === 'number' ? value : undefined
}

/**
 * 读公共字段。
 * @param source - 事件对象。
 * @returns 公共字段；形状不对时是 undefined。
 */
function readBase(source: object): { sessionId: string; seq: number } | undefined {
  if (readNumber(source, 'version') !== ACP_EVENT_VERSION) return undefined
  const sessionId = readString(source, 'sessionId')
  const seq = readNumber(source, 'seq')
  if (sessionId === undefined || seq === undefined) return undefined
  return { sessionId, seq }
}

/**
 * 判断一个字符串是不是某个联合类型里的一个。
 * @param value - 字符串。
 * @param allowed - 允许的值。
 * @returns 是不是其中之一。
 */
function isOneOf<T extends string>(value: string | undefined, allowed: readonly T[]): value is T {
  const list: readonly string[] = allowed
  return value !== undefined && list.includes(value)
}

/**
 * 解析一条事件。
 *
 * 形状不对就返回 undefined——调用方据此丢掉这条事件，而不是拿半条数据去用。
 * @param value - 线上的事件。
 * @returns 解析出来的事件；不认识就是 undefined。
 */
export function parseAcpEvent(value: unknown): AcpEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const kind = readString(value, 'kind')
  const base = readBase(value)
  if (base === undefined) return undefined
  const common: { version: typeof ACP_EVENT_VERSION; sessionId: string; seq: number } = {
    version: ACP_EVENT_VERSION,
    sessionId: base.sessionId,
    seq: base.seq,
  }
  switch (kind) {
    case 'message_chunk': {
      const text = readString(value, 'text')
      if (text === undefined) return undefined
      return { ...common, kind: 'message_chunk', text }
    }
    case 'tool_call': {
      const callId = readString(value, 'callId')
      const title = readString(value, 'title')
      const status = readString(value, 'status')
      if (callId === undefined || title === undefined) return undefined
      if (!isOneOf(status, ['pending', 'in_progress', 'completed', 'failed'] as const)) return undefined
      const toolKind = readString(value, 'toolKind')
      const kindValue = isOneOf(toolKind, ['read', 'edit', 'execute', 'other'] as const) ? toolKind : undefined
      return {
        ...common,
        kind: 'tool_call',
        callId,
        title,
        status,
        ...(kindValue === undefined ? {} : { toolKind: kindValue }),
      }
    }
    case 'tool_result': {
      const callId = readString(value, 'callId')
      const status = readString(value, 'status')
      const content = readString(value, 'content')
      if (callId === undefined || content === undefined) return undefined
      if (!isOneOf(status, ['completed', 'failed'] as const)) return undefined
      return { ...common, kind: 'tool_result', callId, status, content }
    }
    case 'completed': {
      const stopReason = readString(value, 'stopReason')
      if (!isOneOf(stopReason, ['end_turn', 'cancelled', 'error'] as const)) return undefined
      return { ...common, kind: 'completed', stopReason }
    }
    case 'error': {
      const code = readString(value, 'code')
      const message = readString(value, 'message')
      if (code === undefined || message === undefined) return undefined
      return { ...common, kind: 'error', code, message }
    }
    default:
      return undefined
  }
}

/**
 * 判断一个事件是不是文本增量。
 * @param event - 事件。
 * @returns 是不是文本增量。
 */
export function isMessageChunk(event: AcpEvent | undefined): event is AcpMessageChunkEvent {
  return event?.kind === 'message_chunk'
}

/**
 * 判断一个事件是不是工具调用。
 * @param event - 事件。
 * @returns 是不是工具调用。
 */
export function isToolCall(event: AcpEvent | undefined): event is AcpToolCallEvent {
  return event?.kind === 'tool_call'
}

/**
 * 判断一个事件是不是工具结果。
 * @param event - 事件。
 * @returns 是不是工具结果。
 */
export function isToolResult(event: AcpEvent | undefined): event is AcpToolResultEvent {
  return event?.kind === 'tool_result'
}

/**
 * 判断一个事件是不是一轮结束。
 * @param event - 事件。
 * @returns 是不是一轮结束。
 */
export function isCompleted(event: AcpEvent | undefined): event is AcpCompletedEvent {
  return event?.kind === 'completed'
}

/**
 * 判断一个事件是不是出错。
 * @param event - 事件。
 * @returns 是不是出错。
 */
export function isError(event: AcpEvent | undefined): event is AcpErrorEvent {
  return event?.kind === 'error'
}
