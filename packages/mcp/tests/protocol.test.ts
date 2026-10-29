import { describe, expect, it } from 'vitest'
import { encodeLine, LineSplitter, parseLine } from '../src/protocol.ts'

describe('stdio 线路层', () => {
  it('一条消息编码成一行', () => {
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n')
  })

  it('切分器把分片拼回整行', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a"')).toEqual([])
    expect(splitter.push(':1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.push('{"c":3}')).toEqual([])
    expect(splitter.flush()).toEqual(['{"c":3}'])
  })

  it('Windows 的 CRLF 也认', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  it('flush 在没有残余时给空数组', () => {
    expect(new LineSplitter().flush()).toEqual([])
  })

  it('回包认得出来', () => {
    const parsed = parseLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.message.id).toBe(1)
    expect(parsed.message.result).toEqual({ ok: true })
  })

  it('错误回包也认得出来', () => {
    const parsed = parseLine('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"没有这个方法"}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.message.error?.code).toBe(-32601)
  })

  it('不是 JSON 就说清楚', () => {
    const parsed = parseLine('这不是 JSON')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('不是合法 JSON')
  })

  it('缺 jsonrpc 标记也算违规', () => {
    const parsed = parseLine('{"id":1}')
    expect(parsed.ok).toBe(false)
  })

  it('不是对象也算违规', () => {
    expect(parseLine('123').ok).toBe(false)
    expect(parseLine('[]').ok).toBe(false)
  })
})
