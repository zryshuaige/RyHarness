/**
 * stdio 上的 JSON-RPC 线路层：把对象编码成一行、把字节流切成一行、认出回包。
 *
 * 为什么单独拎一层：stdio 没有消息边界，一次 read 可能带回半行、三行，或者
 * 一行里混着上一行的尾巴。把切分逻辑放到连接代码外面，才能在测试里直接喂
 * 「半行 + 整行 + 半行」这种真会遇到的输入——连接层于是只剩「收到一行 → 分发」。
 * @module @ryharness/mcp/protocol
 */

import { isPlainObject } from './json.ts'
import type { JsonRpcResponse } from './types.ts'

/** 把一条消息编码成「一行 JSON + 换行」。 */
export function encodeLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`
}

/** 一行的辨认结果：要么是合法回包，要么给出一句能给人看的失败原因。 */
export type ParsedLine = { ok: true; message: JsonRpcResponse } | { ok: false; reason: string }

/**
 * 认一行是不是 JSON-RPC 回包。
 *
 * 只收回包（带 id）：server 主动发来的通知本包用不上，落在 dispatch 里被忽略，
 * 不该在这里当成错误。
 */
export function parseLine(line: string): ParsedLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, reason: `这一行不是合法 JSON：${line.slice(0, 120)}` }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: '这一行不是 JSON 对象' }
  }
  if (parsed.jsonrpc !== '2.0') {
    return { ok: false, reason: '这一行缺少 jsonrpc="2.0" 标记' }
  }
  const rawId = parsed.id
  const id = typeof rawId === 'number' || typeof rawId === 'string' ? rawId : null
  const rawError = isPlainObject(parsed.error) ? parsed.error : undefined
  const error =
    rawError === undefined
      ? undefined
      : {
          code: typeof rawError.code === 'number' ? rawError.code : 0,
          message: typeof rawError.message === 'string' ? rawError.message : '服务端没有说明错误原因',
          data: rawError.data,
        }
  return { ok: true, message: { jsonrpc: '2.0', id, result: parsed.result, error } }
}

/**
 * 按行切分器：喂进任意片段，吐出这次凑齐的完整行。
 *
 * stdio 的现实是「一次 data 事件不等于一行」——切分逻辑必须留在缓冲区里，
 * 等到换行符出现才把一行交出去。
 */
export class LineSplitter {
  private buffer = ''

  /** 喂进一段文本，返回本次凑齐的完整行（不含换行符）。 */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    return lines
  }

  /** 流结束时把没以换行收尾的残余交出来（协议错乱时的取证材料）。 */
  flush(): string[] {
    if (this.buffer.length === 0) return []
    const rest = this.buffer
    this.buffer = ''
    return [rest.endsWith('\r') ? rest.slice(0, -1) : rest]
  }
}
