/**
 * ACP 事件的解析：形状固定，认不出来就丢掉。
 */
import { describe, expect, it } from 'vitest'
import {
  ACP_EVENT_VERSION,
  isCompleted,
  isError,
  isMessageChunk,
  isToolCall,
  isToolResult,
  parseAcpEvent,
} from '../src/index.ts'

/** 一个能用的消息增量。 */
const chunk = { version: 1, sessionId: 's1', seq: 1, kind: 'message_chunk', text: '你好' }

describe('ACP 事件解析', () => {
  it('文本增量解析出来', () => {
    const event = parseAcpEvent(chunk)
    expect(event).toEqual(chunk)
    expect(isMessageChunk(event)).toBe(true)
  })

  it('工具调用解析出来', () => {
    const event = parseAcpEvent({
      version: 1,
      sessionId: 's1',
      seq: 2,
      kind: 'tool_call',
      callId: 'c1',
      title: '读文件',
      status: 'in_progress',
      toolKind: 'read',
    })
    expect(event).toMatchObject({ kind: 'tool_call', callId: 'c1', status: 'in_progress' })
    expect(isToolCall(event)).toBe(true)
  })

  it('工具结果解析出来', () => {
    const event = parseAcpEvent({
      version: 1,
      sessionId: 's1',
      seq: 3,
      kind: 'tool_result',
      callId: 'c1',
      status: 'completed',
      content: '正文',
    })
    expect(event).toMatchObject({ kind: 'tool_result', content: '正文' })
    expect(isToolResult(event)).toBe(true)
  })

  it('完成与错误解析出来', () => {
    const done = parseAcpEvent({ version: 1, sessionId: 's1', seq: 4, kind: 'completed', stopReason: 'end_turn' })
    expect(isCompleted(done)).toBe(true)
    const failed = parseAcpEvent({ version: 1, sessionId: 's1', seq: 5, kind: 'error', code: 'x', message: '坏了' })
    expect(isError(failed)).toBe(true)
  })

  it('版本不对的不要', () => {
    expect(parseAcpEvent({ ...chunk, version: 2 })).toBeUndefined()
  })

  it('缺字段的不要', () => {
    expect(parseAcpEvent({ version: 1, sessionId: 's1', seq: 1, kind: 'message_chunk' })).toBeUndefined()
    expect(parseAcpEvent({ version: 1, kind: 'message_chunk', text: 'x' })).toBeUndefined()
  })

  it('不认识的事件类型不要', () => {
    expect(parseAcpEvent({ ...chunk, kind: '别的' })).toBeUndefined()
  })

  it('不是对象的不要', () => {
    expect(parseAcpEvent('字符串')).toBeUndefined()
    expect(parseAcpEvent(undefined)).toBeUndefined()
  })

  it('工具种类不认识时不带这个字段，但不丢整条事件', () => {
    const event = parseAcpEvent({
      version: 1,
      sessionId: 's1',
      seq: 2,
      kind: 'tool_call',
      callId: 'c1',
      title: '读文件',
      status: 'pending',
      toolKind: '未来的种类',
    })
    expect(event).toMatchObject({ kind: 'tool_call', status: 'pending' })
    expect(event).not.toHaveProperty('toolKind')
  })

  it('事件版本号是固定的 1', () => {
    expect(ACP_EVENT_VERSION).toBe(1)
  })
})
