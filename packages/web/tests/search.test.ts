/**
 * 搜索：两种后端各走一遍。
 *
 * 接口那一侧要认得出常见的回包形状（结果数组在 data / results / items 里，字段名
 * 也各叫各的）；抓页面那一侧要认得出「结果是个链接」，并且把各家包着的跳转链接
 * 解开。
 */
import { describe, expect, it } from 'vitest'
import type { HttpRequestInit, HttpResponse, PinnedFetch } from '../src/index.ts'
import { extractSearchResults, parseSearchHtml, webSearch } from '../src/index.ts'

const PUBLIC_IP = '93.184.216.34'

/** 解析器：任何域名都解析到同一个公网地址。 */
const resolvePublic = async (): Promise<readonly string[]> => [PUBLIC_IP]

/** 造一个假响应。 */
function reply(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: Buffer.from(body, 'utf8'), truncated: false }
}

/** 记下请求的假取回器。 */
function recorder(body: string, status = 200) {
  const seen: { url: string; init: HttpRequestInit | undefined; pin: string | undefined }[] = []
  const fetchImpl: PinnedFetch = async (url, init, pin) => {
    seen.push({ url, init, pin })
    return reply(body, status, { 'content-type': 'application/json' })
  }
  return { seen, fetchImpl }
}

describe('搜索接口后端', () => {
  it('结果数组在 data 里：认得出标题、链接与摘要', async () => {
    const payload = {
      data: [
        { title: '第一篇', url: 'https://a.test/1', snippet: '一段摘要' },
        { title: '第二篇', url: 'https://a.test/2' },
      ],
    }
    const { seen, fetchImpl } = recorder(JSON.stringify(payload))
    const results = await webSearch(
      { backend: 'api', api: { endpoint: 'https://api.test/search?q={{query}}' } },
      '测试 词',
      { fetchImpl, resolveHost: resolvePublic },
    )
    expect(results).toEqual([
      { title: '第一篇', url: 'https://a.test/1', snippet: '一段摘要' },
      { title: '第二篇', url: 'https://a.test/2' },
    ])
    expect(seen[0]?.url).toBe('https://api.test/search?q=%E6%B5%8B%E8%AF%95%20%E8%AF%8D')
    expect(seen[0]?.pin).toBe(PUBLIC_IP)
  })

  it('结果数组在 results 里：同样的回包换个位置也认得出', async () => {
    const payload = { results: [{ name: '换个字段名', link: 'https://b.test/1', description: '摘要' }] }
    const { fetchImpl } = recorder(JSON.stringify(payload))
    const results = await webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search' } }, '词', {
      fetchImpl,
      resolveHost: resolvePublic,
    })
    expect(results).toEqual([{ title: '换个字段名', url: 'https://b.test/1', snippet: '摘要' }])
  })

  it('指定 resultPath：按给的路径取数组', async () => {
    const payload = { payload: { hits: [{ title: '深处的', url: 'https://c.test/1' }] } }
    const { fetchImpl } = recorder(JSON.stringify(payload))
    const results = await webSearch(
      { backend: 'api', api: { endpoint: 'https://api.test/search', resultPath: 'payload.hits' } },
      '词',
      { fetchImpl, resolveHost: resolvePublic },
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.url).toBe('https://c.test/1')
  })

  it('链接是对象、标题缺失、条目不是对象：都按各自的规矩处理', () => {
    const results = extractSearchResults([
      { url: { href: 'https://d.test/1' }, title: '对象链接' },
      { url: 'https://d.test/2' },
      { title: '没有链接' },
      '不是对象',
    ])
    expect(results).toEqual([
      { title: '对象链接', url: 'https://d.test/1' },
      { title: 'https://d.test/2', url: 'https://d.test/2' },
    ])
  })

  it('重复的链接只留一条', () => {
    const results = extractSearchResults({
      data: [
        { title: '一', url: 'https://e.test/1' },
        { title: '二', url: 'https://e.test/1' },
      ],
    })
    expect(results).toHaveLength(1)
  })

  it('GET：搜索词进 query 参数；POST：搜索词进请求体', async () => {
    const get = recorder(JSON.stringify({ data: [] }))
    await webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search', queryParam: 'query' } }, '关键词', {
      fetchImpl: get.fetchImpl,
      resolveHost: resolvePublic,
    })
    expect(get.seen[0]?.url).toBe('https://api.test/search?query=%E5%85%B3%E9%94%AE%E8%AF%8D')
    expect(get.seen[0]?.init?.method).toBe('GET')

    const post = recorder(JSON.stringify({ data: [] }))
    await webSearch(
      {
        backend: 'api',
        api: {
          endpoint: 'https://api.test/search',
          method: 'POST',
          headers: { Authorization: 'Bearer x' },
          bodyTemplate: { query: '{{query}}', top_k: 3, filter: { tag: '{{query}}' } },
        },
      },
      '关键词',
      { fetchImpl: post.fetchImpl, resolveHost: resolvePublic },
    )
    expect(post.seen[0]?.init?.method).toBe('POST')
    expect(post.seen[0]?.init?.headers?.authorization).toBe('Bearer x')
    expect(post.seen[0]?.init?.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(post.seen[0]?.init?.body ?? '{}')).toEqual({
      query: '关键词',
      top_k: 3,
      filter: { tag: '关键词' },
    })
  })

  it('没有 bodyTemplate 时 POST 默认发 query 字段', async () => {
    const { seen, fetchImpl } = recorder(JSON.stringify({ data: [] }))
    await webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search', method: 'POST' } }, '关键词', {
      fetchImpl,
      resolveHost: resolvePublic,
    })
    expect(JSON.parse(seen[0]?.init?.body ?? '{}')).toEqual({ q: '关键词' })
  })

  it('最多返回几条：按配置截断', async () => {
    const payload = {
      data: [
        { title: '一', url: 'https://f.test/1' },
        { title: '二', url: 'https://f.test/2' },
        { title: '三', url: 'https://f.test/3' },
      ],
    }
    const { fetchImpl } = recorder(JSON.stringify(payload))
    const results = await webSearch(
      { backend: 'api', api: { endpoint: 'https://api.test/search' }, maxResults: 2 },
      '词',
      { fetchImpl, resolveHost: resolvePublic },
    )
    expect(results).toHaveLength(2)
  })

  it('接口出错、回包不是 JSON、配置缺段，都给中文错误', async () => {
    const failing = recorder('{}', 500)
    await expect(
      webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search' } }, '词', {
        fetchImpl: failing.fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索接口返回 HTTP 500')

    const broken = recorder('not json')
    await expect(
      webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search' } }, '词', {
        fetchImpl: broken.fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索接口返回的不是合法 JSON')

    await expect(
      webSearch({ backend: 'api' }, '词', { fetchImpl: broken.fetchImpl, resolveHost: resolvePublic }),
    ).rejects.toThrow('没有配置 api 段')
    await expect(
      webSearch({ backend: 'html' }, '词', { fetchImpl: broken.fetchImpl, resolveHost: resolvePublic }),
    ).rejects.toThrow('没有配置 html 段')
    await expect(
      webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search' } }, '  ', {
        fetchImpl: broken.fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索词不能为空')
  })

  it('接口地址指向内网也拦：出站请求只有一条路', async () => {
    const { fetchImpl } = recorder('{}')
    await expect(
      webSearch({ backend: 'api', api: { endpoint: 'http://127.0.0.1:8080/search' } }, '词', {
        fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('拒绝访问本机或内网地址')
  })
})

describe('搜索页面后端', () => {
  const page = [
    '<html><body>',
    '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">真实标题</a>',
    '<a href="/relative">相对标题</a>',
    '<a href="https://plain.test/x" title="一段摘要">普通标题</a>',
    '<a href="javascript:void(0)">不该收</a>',
    '<a href="https://plain.test/x">重复链接</a>',
    '<a href="https://empty.test/y"> </a>',
    '</body></html>',
  ].join('')

  it('抓结果页，解析出链接与标题，并解开跳转链接', async () => {
    const seen: string[] = []
    const fetchImpl: PinnedFetch = async (url) => {
      seen.push(url)
      return reply(page, 200, { 'content-type': 'text/html' })
    }
    const results = await webSearch(
      { backend: 'html', html: { endpoint: 'https://html.duckduckgo.com/html/?q={{query}}' } },
      '搜索 词',
      { fetchImpl, resolveHost: resolvePublic },
    )
    expect(seen[0]).toBe('https://html.duckduckgo.com/html/?q=%E6%90%9C%E7%B4%A2%20%E8%AF%8D')
    expect(results).toEqual([
      { title: '真实标题', url: 'https://example.com/page' },
      { title: '相对标题', url: 'https://html.duckduckgo.com/relative' },
      { title: '普通标题', url: 'https://plain.test/x', snippet: '一段摘要' },
    ])
  })

  it('结果页没有占位符时，搜索词进 q 参数', async () => {
    const seen: string[] = []
    const fetchImpl: PinnedFetch = async (url) => {
      seen.push(url)
      return reply('<a href="https://a.test/1">标题</a>', 200, { 'content-type': 'text/html' })
    }
    await webSearch({ backend: 'html', html: { endpoint: 'https://search.test/' } }, '词', {
      fetchImpl,
      resolveHost: resolvePublic,
    })
    expect(seen[0]).toBe('https://search.test/?q=%E8%AF%8D')
  })

  it('结果页直接解析：相对链接补全、javascript: 不收、重复的只留一条', () => {
    const results = parseSearchHtml(page, 'https://search.test/base')
    expect(results.map((item) => item.url)).toEqual([
      'https://example.com/page',
      'https://search.test/relative',
      'https://plain.test/x',
    ])
  })

  it('搜索页返回错误状态码时给中文错误', async () => {
    const fetchImpl: PinnedFetch = async () => reply('nope', 503, { 'content-type': 'text/html' })
    await expect(
      webSearch({ backend: 'html', html: { endpoint: 'https://search.test/?q={{query}}' } }, '词', {
        fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索页面返回 HTTP 503')
  })
})

describe('搜索的超时', () => {
  it('上限到了就回中文错误', async () => {
    const fetchImpl: PinnedFetch = async () => new Promise<HttpResponse>(() => {})
    const started = Date.now()
    await expect(
      webSearch({ backend: 'api', api: { endpoint: 'https://api.test/search' }, timeoutMs: 30 }, '词', {
        fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索超时')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('搜索页那一侧也有超时', async () => {
    const fetchImpl: PinnedFetch = async () => new Promise<HttpResponse>(() => {})
    await expect(
      webSearch({ backend: 'html', html: { endpoint: 'https://search.test/?q={{query}}' }, timeoutMs: 30 }, '词', {
        fetchImpl,
        resolveHost: resolvePublic,
      }),
    ).rejects.toThrow('搜索超时')
  })
})
