import { McpError } from '@ryharness/mcp'
import { describe, expect, it } from 'vitest'
import {
  readEmbeddedResource,
  readPromptDescriptors,
  readResourceContents,
  readResourceDescriptors,
  readServerInfo,
  readToolDescriptors,
  readToolResult,
} from '../src/decode.ts'

describe('回包解码', () => {
  it('initialize 的结果读出身份、能力与说明', () => {
    const info = readServerInfo(
      {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'x', version: '1.0', title: '标题' },
        instructions: '说明',
        capabilities: { tools: {} },
      },
      'fallback',
    )
    expect(info.name).toBe('x')
    expect(info.version).toBe('1.0')
    expect(info.title).toBe('标题')
    expect(info.instructions).toBe('说明')
    expect(info.protocolVersion).toBe('2024-11-05')
    expect(info.capabilities).toEqual({ tools: {} })
  })

  it('initialize 的结果形状不对时用兜底值', () => {
    const info = readServerInfo(undefined, 'fallback')
    expect(info.name).toBe('fallback')
    expect(info.version).toBe('0.0.0')
    expect(info.protocolVersion).toBe('unknown')
    expect(info.capabilities).toEqual({})
  })

  it('工具清单读出名字与 schema', () => {
    const tools = readToolDescriptors({
      tools: [
        { name: 'echo', description: '说明', inputSchema: { type: 'object' } },
        { name: '' },
        42,
        { description: '没有名字' },
      ],
    })
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('echo')
    expect(tools[0]?.description).toBe('说明')
    expect(tools[0]?.inputSchema).toEqual({ type: 'object' })
  })

  it('形状不对的工具清单读成空数组，不抛', () => {
    expect(readToolDescriptors(null)).toEqual([])
    expect(readToolDescriptors({ tools: 'nope' })).toEqual([])
  })

  it('工具结果读出内容块与错误标记', () => {
    const result = readToolResult(
      {
        content: [
          { type: 'text', text: '正文' },
          { type: 'image', data: 'AA', mimeType: 'image/png' },
        ],
        isError: true,
      },
      'fake',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('正文')
    expect(result.content[1]?.mimeType).toBe('image/png')
  })

  it('内容块缺 type 时按文本算', () => {
    const result = readToolResult({ content: [{ text: '没有类型' }] }, 'fake')
    expect(result.content[0]?.type).toBe('text')
    expect(result.isError).toBe(false)
  })

  it('内容块里混进不是对象的东西就跳过', () => {
    const result = readToolResult({ content: [42, { type: 'text', text: '正文' }] }, 'fake')
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toBe('正文')
  })

  it('工具结果不是对象就是没有回执，直接报错', () => {
    expect(() => readToolResult('nope', 'fake')).toThrow(McpError)
    expect(() => readToolResult('nope', 'fake')).toThrow(/工具调用结果不是对象/)
  })

  it('资源清单与资源内容都读得出来', () => {
    const resources = readResourceDescriptors({ resources: [{ uri: 'file:///a', name: 'a' }, { name: '没有 uri' }] })
    expect(resources).toHaveLength(1)
    expect(resources[0]?.uri).toBe('file:///a')
    expect(resources[0]?.name).toBe('a')
    const contents = readResourceContents({ contents: [{ uri: 'file:///a', text: '正文' }, { text: '没有 uri' }] })
    expect(contents).toHaveLength(1)
    expect(contents[0]?.text).toBe('正文')
  })

  it('资源清单与资源内容里的杂项都被跳过', () => {
    expect(readResourceDescriptors({ resources: [42] })).toEqual([])
    expect(readResourceContents('不是对象')).toEqual([])
    expect(readResourceContents({ contents: [42] })).toEqual([])
  })

  it('内嵌资源按资源本身读，不是按 contents 数组读', () => {
    const embedded = readEmbeddedResource({ uri: 'file:///a', text: '正文', mimeType: 'text/plain' })
    expect(embedded?.text).toBe('正文')
    expect(embedded?.mimeType).toBe('text/plain')
    expect(readEmbeddedResource({ text: '没有 uri' })).toBeUndefined()
    expect(readEmbeddedResource('nope')).toBeUndefined()
  })

  it('prompt 清单读出参数声明', () => {
    const prompts = readPromptDescriptors({
      prompts: [{ name: 'sum', arguments: [{ name: 'topic', required: true }] }],
    })
    expect(prompts[0]?.name).toBe('sum')
    expect(prompts[0]?.arguments?.[0]?.required).toBe(true)
  })

  it('prompt 的参数不是数组就当作没有参数', () => {
    const prompts = readPromptDescriptors({ prompts: [{ name: 'sum', arguments: 'nope' }] })
    expect(prompts[0]?.arguments).toBeUndefined()
  })

  it('prompt 清单与参数里的杂项都被跳过', () => {
    expect(readPromptDescriptors({ prompts: [42] })).toEqual([])
    expect(readPromptDescriptors({ prompts: [{ name: '' }] })).toEqual([])
    const prompts = readPromptDescriptors({ prompts: [{ name: 'sum', arguments: [42, {}] }] })
    expect(prompts[0]?.arguments).toEqual([])
  })
})
