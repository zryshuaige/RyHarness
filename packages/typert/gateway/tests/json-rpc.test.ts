/**
 * 线协议：JSON-RPC 2.0 的编码、解码与分帧。
 */
import { RemoteError } from '@ryharness/typert-protocol'
import { describe, expect, it } from 'vitest'
import {
  decodeMessage,
  decodeRemoteError,
  encodeFailure,
  encodeMessage,
  encodeRemoteError,
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC_VERSION,
  JsonRpcFrameDecoder,
} from '../src/index.ts'

describe('JSON-RPC 线协议', () => {
  it('请求编码成一行 JSON', () => {
    const text = encodeMessage({ jsonrpc: JSON_RPC_VERSION, id: 'r1', method: 'remote/call', params: { a: 1 } })
    expect(text).toBe('{"jsonrpc":"2.0","id":"r1","method":"remote/call","params":{"a":1}}')
  })

  it('请求、通知、回包各自能认出来', () => {
    const request = decodeMessage('{"jsonrpc":"2.0","id":1,"method":"m"}')
    const notification = decodeMessage('{"jsonrpc":"2.0","method":"m"}')
    const response = decodeMessage('{"jsonrpc":"2.0","id":1,"result":42}')
    expect(isRequest(request)).toBe(true)
    expect(isNotification(notification)).toBe(true)
    expect(isResponse(response)).toBe(true)
    expect(isRequest(notification)).toBe(false)
  })

  it('回包里的结果原样解出来', () => {
    const response = decodeMessage('{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}')
    expect(isResponse(response) ? response.result : undefined).toEqual({ ok: true })
  })

  it('没有 result 的回包补成 null', () => {
    const response = decodeMessage('{"jsonrpc":"2.0","id":"r1"}')
    expect(isResponse(response) ? response.result : 'missing').toBeNull()
  })

  it('不是合法 JSON 时报 bad-request', () => {
    expect(() => decodeMessage('这不是 json')).toThrowError(/合法 JSON/)
  })

  it('版本不认识时报 bad-request', () => {
    expect(() => decodeMessage('{"jsonrpc":"1.0","id":1,"method":"m"}')).toThrowError(/版本/)
  })

  it('回包缺 id 时报错', () => {
    expect(() => decodeMessage('{"jsonrpc":"2.0","result":1}')).toThrowError(/id/)
  })

  it('失败带着机器码上线', () => {
    const error = new RemoteError('gateway/timeout', '超时了', { timeoutMs: 1500 })
    const payload = encodeRemoteError(error)
    expect(payload.code).toBe(-32001)
    expect(payload.message).toBe('超时了')
    expect(payload.data?.remoteCode).toBe('gateway/timeout')
    expect(payload.data?.details).toEqual({ timeoutMs: 1500 })
  })

  it('机器码与详情原样回到客户端', () => {
    const original = new RemoteError('gateway/disconnected', '断了', { reason: '对端关了' })
    const restored = decodeRemoteError(encodeRemoteError(original))
    expect(restored.code).toBe('gateway/disconnected')
    expect(restored.message).toBe('断了')
    expect(restored.details).toEqual({ reason: '对端关了' })
  })

  it('不认识机器码时保留原来的码', () => {
    const restored = decodeRemoteError({ code: -32050, message: '外来的失败', data: { remoteCode: 'other/x' } })
    expect(restored.code).toBe('other/x')
    expect(restored.message).toBe('外来的失败')
  })

  it('每个机器码都能原样绕一圈', () => {
    const cases = [
      { code: 'gateway/bad-request', details: { issues: [{ field: 'a' }] } },
      { code: 'gateway/cancelled', details: {} },
      { code: 'gateway/internal', details: {} },
      { code: 'gateway/timeout', details: { timeoutMs: 800 } },
      { code: 'gateway/disconnected', details: { reason: '断了' } },
      { code: 'gateway/conflict', details: { namespace: 'n', method: 'm' } },
    ] as const
    for (const item of cases) {
      const restored = decodeRemoteError({
        code: -1,
        message: 'x',
        data: { remoteCode: item.code, details: item.details },
      })
      expect(restored.code).toBe(item.code)
      expect(restored.details).toEqual(item.details)
    }
  })

  it('线上带来的详情不是对象时，退回默认值', () => {
    const timeout = decodeRemoteError({
      code: -1,
      message: 'x',
      data: { remoteCode: 'gateway/timeout', details: '乱码' },
    })
    expect(timeout.details).toEqual({ timeoutMs: 0 })
    const conflict = decodeRemoteError({ code: -1, message: 'x', data: { remoteCode: 'gateway/conflict', details: 7 } })
    expect(conflict.details).toEqual({ namespace: '', method: '' })
    const bad = decodeRemoteError({
      code: -1,
      message: 'x',
      data: { remoteCode: 'gateway/bad-request', details: '乱码' },
    })
    expect(bad.details).toEqual({})
  })

  it('issues 里不是对象的那些被剔掉', () => {
    const restored = decodeRemoteError({
      code: -1,
      message: 'x',
      data: { remoteCode: 'gateway/bad-request', details: { issues: [{ a: 1 }, '字符串', 3] } },
    })
    expect(restored.details).toEqual({ issues: [{ a: 1 }] })
  })

  it('没有机器码的普通异常按内部错误编码，但原文不丢', () => {
    const payload = encodeFailure(new Error('普通炸了'))
    expect(payload.code).toBe(-32603)
    expect(payload.message).toBe('普通炸了')
    expect(payload.data).toBeUndefined()
  })

  it('分帧器把半行留到下一次', () => {
    const decoder = new JsonRpcFrameDecoder()
    expect(decoder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(decoder.push('2}\n')).toEqual(['{"b":2}'])
  })

  it('分帧器认得 Windows 的换行', () => {
    const decoder = new JsonRpcFrameDecoder()
    expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  it('一次来多行时全部吐出来', () => {
    const decoder = new JsonRpcFrameDecoder()
    expect(decoder.push('{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('缓冲区里剩下的半条能取出来', () => {
    const decoder = new JsonRpcFrameDecoder()
    decoder.push('{"a":1}\n{"b":')
    expect(decoder.rest()).toBe('{"b":')
  })

  it('没有结果也没有错误的回包，补成 result: null', () => {
    expect(encodeMessage({ jsonrpc: JSON_RPC_VERSION, id: 'r1' })).toBe('{"jsonrpc":"2.0","id":"r1","result":null}')
  })
})
