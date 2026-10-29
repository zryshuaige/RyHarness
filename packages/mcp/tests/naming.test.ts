import { assignMcpToolNames, mcpToolName, mcpToolRefKey, sanitizeNameSegment } from '@ryharness/mcp'
import { describe, expect, it } from 'vitest'

describe('MCP 工具命名', () => {
  it('名字按 mcp__<server>__<tool> 来', () => {
    expect(mcpToolName('alpha', 'echo')).toBe('mcp__alpha__echo')
  })

  it('非法字符换成下划线', () => {
    expect(sanitizeNameSegment('weird name/with:chars')).toBe('weird_name_with_chars')
    expect(mcpToolName('a b', 'c.d')).toBe('mcp__a_b__c_d')
  })

  it('下划线与连字符是合法字符，原样留着', () => {
    expect(sanitizeNameSegment('a_b-c')).toBe('a_b-c')
  })

  it('全是非法字符时用兜底名', () => {
    expect(sanitizeNameSegment('///')).toBe('x')
    expect(mcpToolName('', '')).toBe('mcp__server__tool')
  })

  it('两端的下划线去掉', () => {
    expect(sanitizeNameSegment('__abc__')).toBe('abc')
  })

  it('同一个 server 里清洗后撞名的工具按序号分开', () => {
    const names = assignMcpToolNames([
      { server: 'a', tool: 'x y' },
      { server: 'a', tool: 'x.y' },
    ])
    expect([...names.values()].sort()).toEqual(['mcp__a__x_y', 'mcp__a__x_y__2'])
  })

  it('序号与登记顺序无关', () => {
    const forward = assignMcpToolNames([
      { server: 'a', tool: 't' },
      { server: 'b', tool: 't' },
    ])
    const backward = assignMcpToolNames([
      { server: 'b', tool: 't' },
      { server: 'a', tool: 't' },
    ])
    expect([...backward.entries()]).toEqual([...forward.entries()])
    expect(forward.get(mcpToolRefKey({ server: 'a', tool: 't' }))).toBe('mcp__a__t')
    expect(forward.get(mcpToolRefKey({ server: 'b', tool: 't' }))).toBe('mcp__b__t')
  })

  it('来源键不会把不同的来源挤到同一个键上', () => {
    const key = mcpToolRefKey({ server: 'a b', tool: 'c' })
    const other = mcpToolRefKey({ server: 'a', tool: 'b c' })
    expect(key).not.toBe(other)
  })
})
