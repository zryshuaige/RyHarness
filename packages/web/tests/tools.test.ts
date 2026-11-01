/**
 * 两个工具的形状与返回：模型看到什么、出错时看到什么。
 */
import { describe, expect, it } from 'vitest'
import type { HttpResponse, PinnedFetch, WebConfig } from '../src/index.ts'
import { createWebFetchTool, createWebSearchTool } from '../src/index.ts'

const PUBLIC_IP = '93.184.216.34'

/** 解析器：任何域名都解析到同一个公网地址。 */
const resolvePublic = async (): Promise<readonly string[]> => [PUBLIC_IP]

/** 造一个假响应。 */
function reply(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: Buffer.from(body, 'utf8'), truncated: false }
}

const config: WebConfig = {
  search: { backend: 'api', api: { endpoint: 'https://api.test/search?q={{query}}' } },
  fetch: { timeoutMs: 1000 },
}

describe('web_search 工具', () => {
  it('名字与参数是模型能看懂的那一份', () => {
    const tool = createWebSearchTool(config)
    expect(tool.name).toBe('web_search')
    expect(tool.description).toContain('搜索')
    expect(tool.parameters.required).toEqual(['query'])
  })

  it('成功时把结果整成 JSON 交回模型', async () => {
    const payload = { data: [{ title: '标题', url: 'https://a.test/1', snippet: '摘要' }] }
    const fetchImpl: PinnedFetch = async () => reply(JSON.stringify(payload))
    const tool = createWebSearchTool(config, { fetchImpl, resolveHost: resolvePublic })
    const result = await tool.execute({ query: '关键词' }, {})
    expect(result.isError).not.toBe(true)
    const parsed = JSON.parse(result.content) as { query: string; results: { url: string }[] }
    expect(parsed.query).toBe('关键词')
    expect(parsed.results[0]?.url).toBe('https://a.test/1')
  })

  it('缺参数或没配后端，都回中文错误结果', async () => {
    const tool = createWebSearchTool(config)
    const missing = await tool.execute({}, {})
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('query 是必填的')
    const blank = await tool.execute({ query: '   ' }, {})
    expect(blank.isError).toBe(true)
    const noBackend = createWebSearchTool({})
    const result = await noBackend.execute({ query: '词' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有配置搜索后端')
  })

  it('后端出错时回中文错误结果，不把英文异常交给模型', async () => {
    const fetchImpl: PinnedFetch = async () => {
      throw new Error('socket hang up')
    }
    const tool = createWebSearchTool(config, { fetchImpl, resolveHost: resolvePublic })
    const result = await tool.execute({ query: '词' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('搜索失败')
    expect(result.content).not.toContain('socket hang up')
  })
})

describe('web_fetch 工具', () => {
  it('名字与参数是模型能看懂的那一份', () => {
    const tool = createWebFetchTool(config)
    expect(tool.name).toBe('web_fetch')
    expect(tool.parameters.required).toEqual(['url'])
  })

  it('成功时把页面整成 JSON 交回模型', async () => {
    const fetchImpl: PinnedFetch = async () =>
      reply('<html><title>页面</title><p>正文</p></html>', 200, { 'content-type': 'text/html' })
    const tool = createWebFetchTool(config, { fetchImpl, resolveHost: resolvePublic })
    const result = await tool.execute({ url: 'https://example.test/a' }, {})
    expect(result.isError).not.toBe(true)
    const parsed = JSON.parse(result.content) as { url: string; title: string; text: string }
    expect(parsed.url).toBe('https://example.test/a')
    expect(parsed.title).toBe('页面')
    expect(parsed.text).toContain('正文')
  })

  it('缺 url 时回中文错误结果', async () => {
    const tool = createWebFetchTool(config)
    const result = await tool.execute({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('url 是必填的')
  })

  it('底层出错时回中文错误结果，不把英文异常交给模型', async () => {
    const fetchImpl: PinnedFetch = async () => {
      throw new Error('socket hang up')
    }
    const tool = createWebFetchTool(config, { fetchImpl, resolveHost: resolvePublic })
    const result = await tool.execute({ url: 'https://example.test/a' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('请求失败')
    expect(result.content).not.toContain('socket hang up')
  })

  it('内网地址被拦时，错误里写明原因', async () => {
    let calls = 0
    const fetchImpl: PinnedFetch = async () => {
      calls++
      return reply('不该被请求')
    }
    const tool = createWebFetchTool(config, { fetchImpl, resolveHost: resolvePublic })
    const result = await tool.execute({ url: 'http://127.0.0.1/admin' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('拒绝访问本机或内网地址')
    expect(calls).toBe(0)
  })
})
