import { describeFailure, McpError } from '@ryharness/mcp'
import { describe, expect, it } from 'vitest'

describe('MCP 错误', () => {
  it('McpError 带着种类与 server 名', () => {
    const error = new McpError('timeout', 'alpha', '超时了')
    expect(error.kind).toBe('timeout')
    expect(error.serverName).toBe('alpha')
    expect(error.name).toBe('McpError')
  })

  it('McpError 的说法原样透出', () => {
    expect(describeFailure(new McpError('closed', 'alpha', '连接已关闭'))).toBe('连接已关闭')
  })

  it('普通 Error 也认', () => {
    expect(describeFailure(new Error('普通错误'))).toBe('普通错误')
  })

  it('字符串也认', () => {
    expect(describeFailure('就是一句话')).toBe('就是一句话')
  })

  it('说不清的东西也能变成一句话', () => {
    expect(describeFailure(42)).toBe('42')
  })
})
