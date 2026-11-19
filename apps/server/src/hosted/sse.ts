/**
 * 极简 SSE 解析器：读 `fetch` 的 body，按帧交出 `id` / `event` / `data`。
 *
 * 只做 RFC 允许的最小子集：`:` 开头的注释（服务端每 30 秒一帧 `: hb`）直接丢掉，
 * 空行收帧，字段值去掉一个前导空格。不引依赖——这里的字节量很小，引一个库反而
 * 多一层需要审计的代码。
 * @module @ryharness/server/hosted/sse
 */

/** 一帧 SSE 消息。 */
export interface SseFrame {
  /** 恢复游标（不透明字符串，原样回传）。 */
  id?: string
  /** 帧类型：普通事件是 KHA 事件类型，控制帧是 `control`，流错误是 `error`。 */
  event?: string
  /** 负载原文（普通帧是 KHA 事件的 JSON）。 */
  data?: string
}

/**
 * 把字节流解析成 SSE 帧。
 *
 * 取消由调用方通过 `AbortSignal` 打断 `fetch`，reader 会以 AbortError 结束；
 * 这里不吞掉它——上层用它区分"用户取消"与"连接坏了"。生成器被 `return()` 时
 * 会 `cancel()` 掉底层流，避免留下一条没人读的连接。
 * @param body - `fetch` 响应的 body。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let id: string | undefined
  let event: string | undefined
  const data: string[] = []

  const takeFrame = (): SseFrame | undefined => {
    if (data.length === 0) {
      id = undefined
      event = undefined
      return undefined
    }
    const frame: SseFrame = { data: data.join('\n') }
    if (id !== undefined) frame.id = id
    if (event !== undefined) frame.event = event
    id = undefined
    event = undefined
    data.length = 0
    return frame
  }

  const consumeLine = (raw: string): SseFrame | undefined => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) return takeFrame()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return undefined
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const frame = consumeLine(line)
        if (frame !== undefined) yield frame
        index = buffer.indexOf('\n')
      }
    }
    // 流结束时最后一帧可能没有空行收尾。
    if (buffer.length > 0) {
      const frame = consumeLine(buffer)
      if (frame !== undefined) yield frame
    }
    const tail = takeFrame()
    if (tail !== undefined) yield tail
  } finally {
    buffer = ''
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
