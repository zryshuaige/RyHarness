/**
 * KHA 事件 → 本客户端能用的字段。
 *
 * 远端契约是 beta，负载按 `Record<string, unknown>` 收，这里只做防御式读取：
 * 认不出的形状返回 undefined，调用方跳过该事件，整轮对话不因为多了一个字段崩掉。
 * @module @ryharness/server/hosted/bridge
 */

import type { KhaEvent } from './types.ts'

/** 一块内容里能读出来的文本（图片/视频只留一句占位）。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'image') parts.push('〔图片〕')
    else if (record.type === 'video') parts.push('〔视频〕')
    else if (record.type === 'file') parts.push(`〔文件${typeof record.name === 'string' ? `：${record.name}` : ''}〕`)
    else if (record.type === 'artifact')
      parts.push(`〔产物${typeof record.name === 'string' ? `：${record.name}` : ''}〕`)
  }
  return parts.join('\n')
}

/** `agent.message` / `agent.thinking` 的正文。 */
export function messageText(event: KhaEvent): string {
  return contentText(event.data?.content)
}

/** 实时增量。 */
export interface KhaDelta {
  kind: 'text' | 'thinking' | 'tool_use'
  delta: string
  toolUseId?: string
  name?: string
}

/** 读一帧 `agent.delta`。 */
export function readDelta(event: KhaEvent): KhaDelta | undefined {
  const data = event.data
  if (data === undefined) return undefined
  const kind = data.kind
  if (kind !== 'text' && kind !== 'thinking' && kind !== 'tool_use') return undefined
  const delta =
    typeof data.delta === 'string' ? data.delta : typeof data.input_delta === 'string' ? data.input_delta : ''
  return {
    kind,
    delta,
    ...(typeof data.tool_use_id === 'string' ? { toolUseId: data.tool_use_id } : {}),
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
  }
}

/** 一次工具调用。 */
export interface KhaToolUse {
  callId: string
  name: string
  input: unknown
  /** 来自远端权限评估；`always_ask` 时线程会暂停等确认。 */
  permission?: string
}

/** 读一帧 `agent.tool_use`。 */
export function readToolUse(event: KhaEvent): KhaToolUse | undefined {
  const toolUse = event.data?.tool_use
  if (typeof toolUse !== 'object' || toolUse === null) return undefined
  const record = toolUse as Record<string, unknown>
  if (typeof record.name !== 'string') return undefined
  const callId = typeof record.id === 'string' ? record.id : event.id
  return {
    callId,
    name: record.name,
    input: record.input ?? {},
    ...(typeof event.data?.evaluated_permission === 'string' ? { permission: event.data.evaluated_permission } : {}),
  }
}

/** 一次工具结果。 */
export interface KhaToolResult {
  callId: string
  name?: string
  content: string
  isError: boolean
}

/** 读一帧 `agent.tool_result`。 */
export function readToolResult(event: KhaEvent): KhaToolResult | undefined {
  const result = event.data?.tool_result
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as Record<string, unknown>
  const callId = typeof record.id === 'string' ? record.id : event.id
  const text = contentText(record.content) || contentText(record.structured_content)
  return {
    callId,
    content: text.length === 0 ? '（工具没有返回文本）' : text,
    isError: record.is_error === true,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  }
}

/** 自定义工具调用（由本客户端执行）。 */
export interface KhaCustomToolUse {
  eventId: string
  name: string
  input: unknown
}

/** 读一帧 `agent.custom_tool_use`。 */
export function readCustomToolUse(event: KhaEvent): KhaCustomToolUse | undefined {
  const data = event.data
  if (data === undefined || typeof data.name !== 'string') return undefined
  return { eventId: event.id, name: data.name, input: data.input ?? {} }
}

/** 会话状态。 */
export interface KhaStatus {
  status: 'idle' | 'running' | 'terminated'
  stopReason?: { type: string; eventIds: string[] }
}

/** 读一帧 `session.status`。 */
export function readStatus(event: KhaEvent): KhaStatus | undefined {
  const data = event.data
  if (data === undefined) return undefined
  const status = data.status
  if (status !== 'idle' && status !== 'running' && status !== 'terminated') return undefined
  const stop = data.stop_reason
  const stopReason =
    typeof stop === 'object' && stop !== null
      ? {
          type:
            typeof (stop as Record<string, unknown>).type === 'string'
              ? String((stop as Record<string, unknown>).type)
              : '',
          eventIds: Array.isArray((stop as Record<string, unknown>).event_ids)
            ? ((stop as Record<string, unknown>).event_ids as unknown[]).filter(
                (id): id is string => typeof id === 'string',
              )
            : [],
        }
      : undefined
  return { status, ...(stopReason === undefined ? {} : { stopReason }) }
}

/** 读一帧 `session.error`。 */
export function readError(event: KhaEvent): { type: string; message: string } | undefined {
  const data = event.data
  if (data === undefined) return undefined
  return {
    type: typeof data.error_type === 'string' ? data.error_type : 'session_error',
    message: typeof data.message === 'string' ? data.message : '远端会话执行失败',
  }
}

/** 从工具结果里读结构化产物（`type: 'artifact'` 的块）。 */
export function artifactRefs(event: KhaEvent): { id?: string; name?: string }[] {
  const result = event.data?.tool_result
  if (typeof result !== 'object' || result === null) return []
  const structured = (result as Record<string, unknown>).structured_content
  if (!Array.isArray(structured)) return []
  return structured.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    if (record.type !== 'artifact') return []
    return [
      {
        ...(typeof record.id === 'string' ? { id: record.id } : {}),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
      },
    ]
  })
}

/** 工具入参转成事件里那个 JSON 字符串。 */
export function inputJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}
