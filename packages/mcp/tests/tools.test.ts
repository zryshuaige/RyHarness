import type { ToolContext } from '@ryharness/agent'
import type { McpToolResult } from '@ryharness/mcp'
import { createMcpTool, McpError, renderMcpContent } from '@ryharness/mcp'
import { describe, expect, it } from 'vitest'

const CTX: ToolContext = { workspaceRoot: process.cwd() }

/** 造一个工具：invoke 由测试给，可以返回任意形状或直接抛错。 */
function tool(invoke: () => Promise<McpToolResult>, overrides: { requiresApproval?: boolean } = {}) {
  return createMcpTool({
    name: 'mcp__x__y',
    server: 'x',
    remoteName: 'y',
    descriptor: { name: 'y', description: '说明' },
    invoke: async (_args) => invoke(),
    requiresApproval: overrides.requiresApproval,
  })
}

describe('MCP 工具', () => {
  it('内容块渲染成模型看得懂的文本', () => {
    expect(renderMcpContent([{ type: 'text', text: 'hello' }])).toBe('hello')
    expect(renderMcpContent([{ type: 'image', mimeType: 'image/png' }])).toBe('[图片：image/png]')
    expect(renderMcpContent([{ type: 'audio' }])).toBe('[音频]')
    expect(renderMcpContent([{ type: 'resource', resource: { uri: 'file:///a', text: '正文' } }])).toBe('正文')
    expect(renderMcpContent([{ type: 'resource', resource: { uri: 'file:///a', mimeType: 'application/pdf' } }])).toBe(
      '[二进制资源 file:///a：application/pdf]',
    )
    expect(renderMcpContent([{ type: 'weird' }])).toBe('[未知内容类型：weird]')
    expect(renderMcpContent([{ type: 'resource' }])).toBe('[内嵌资源]')
  })

  it('参数 schema 原样透传', async () => {
    const withSchema = createMcpTool({
      name: 'mcp__x__y',
      server: 'x',
      remoteName: 'y',
      descriptor: { name: 'y', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
      invoke: async () => ({ content: [] }),
    })
    expect(withSchema.parameters).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    const withoutSchema = createMcpTool({
      name: 'mcp__x__y',
      server: 'x',
      remoteName: 'y',
      descriptor: { name: 'y' },
      invoke: async () => ({ content: [] }),
    })
    expect(withoutSchema.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('描述里带上 server 名，模型知道工具来自哪儿', () => {
    const created = tool(async () => ({ content: [] }))
    expect(created.description).toContain('MCP 服务器「x」')
    expect(created.description).toContain('说明')
  })

  it('默认不要求审批，由宿主决定', () => {
    expect(tool(async () => ({ content: [] })).requiresApproval).toBe(false)
    expect(tool(async () => ({ content: [] }), { requiresApproval: true }).requiresApproval).toBe(true)
  })

  it('server 说失败时内容加上中文前缀并标 isError', async () => {
    const created = tool(async () => ({ content: [{ type: 'text', text: '原始错误' }], isError: true }))
    const result = await created.execute({}, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('MCP 工具「mcp__x__y」执行失败')
    expect(result.content).toContain('原始错误')
  })

  it('抛错时翻成中文错误结果，而不是把轮次炸掉', async () => {
    const created = tool(async () => {
      throw new McpError('timeout', 'x', 'MCP 服务器「x」在 100ms 内没有响应（tools/call）')
    })
    const result = await created.execute({}, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('100ms 内没有响应')
  })

  it('不认识自己的错误类型时也不把英文原样抛出去', async () => {
    const created = tool(async () => {
      throw new Error('boom')
    })
    const result = await created.execute({}, CTX)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('内部错误')
  })

  it('参数不是对象时说清楚收到的是什么', async () => {
    const created = tool(async () => ({ content: [] }))
    const asString = await created.execute('字符串', CTX)
    expect(asString.isError).toBe(true)
    expect(asString.content).toContain('参数必须是一个对象')
    expect(asString.content).toContain('string')
    const asArray = await created.execute([], CTX)
    expect(asArray.content).toContain('数组')
    const asNull = await created.execute(null, CTX)
    expect(asNull.content).toContain('null')
  })

  it('正常结果原样回给模型', async () => {
    const created = tool(async () => ({ content: [{ type: 'text', text: '做完了' }] }))
    const result = await created.execute({}, CTX)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('做完了')
  })
})
