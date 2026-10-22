/**
 * 网页读取：协议白名单、私网拒绝、重定向逐跳复核、限额与 HTML 清洗。
 *
 * 所有出站请求都走注入的假 fetch：这些用例不该真的访问互联网，也不该靠
 * 「某个网站今天恰好长这样」来断言解析器。
 */
import type { Tool } from '@ryharness/agent'
import type { FetchLike, ReadUrlOptions } from '@ryharness/server'
import {
  createReadUrlTool,
  decodeHtmlEntities,
  htmlToText,
  isPrivateAddress,
  READ_URL_MAX_CHARS,
} from '@ryharness/server'
import { describe, expect, it } from 'vitest'

const PUBLIC_IP = '93.184.216.34'

const publicResolve = async (): Promise<readonly string[]> => {
  return [PUBLIC_IP]
}

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

function context(): { workspaceRoot: string } {
  return { workspaceRoot: process.cwd() }
}

function toolWith(fetchImpl: FetchLike, overrides: ReadUrlOptions = {}): Tool {
  return createReadUrlTool({
    fetchImpl,
    resolveHost: publicResolve,
    ...overrides,
  })
}

describe('read_url 安全边界', () => {
  it('协议白名单：file/ftp 与缺 url 都拒绝，且不发出请求', async () => {
    let calls = 0
    const tool = toolWith(async () => {
      calls++
      return response('不该被请求')
    })
    for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/a', 'javascript:alert(1)', '']) {
      const result = await tool.execute({ url }, context())
      expect(result.isError).toBe(true)
    }
    expect(await tool.execute({}, context())).toMatchObject({ isError: true })
    expect(calls).toBe(0)
  })

  it('本机与私网字面地址全部拒绝，且不发出请求', async () => {
    let calls = 0
    const tool = toolWith(async () => {
      calls++
      return response('不该被请求')
    })
    const blocked = [
      'http://localhost/',
      'http://localhost./',
      'http://foo.localhost/',
      'http://127.0.0.1/',
      'http://127.1.2.3/',
      'http://0.0.0.0/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.1.1/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]
    for (const url of blocked) {
      const result = await tool.execute({ url }, context())
      expect(result, url).toMatchObject({ isError: true })
      expect(result.content, url).toMatch(/拒绝访问本机或内网地址|链接格式不正确/)
    }
    expect(calls).toBe(0)
  })

  it('域名解析到私网同样拒绝：只查字面量会漏掉内网域名', async () => {
    let calls = 0
    const tool = createReadUrlTool({
      fetchImpl: async () => {
        calls++
        return response('不该被请求')
      },
      resolveHost: async () => {
        return ['10.1.2.3']
      },
    })
    const result = await tool.execute({ url: 'http://internal.example/' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('拒绝访问本机或内网地址')
    expect(calls).toBe(0)
  })

  it('重定向每一跳都复核：首跳公网、次跳私网时不会发出第二次请求', async () => {
    const requests: string[] = []
    const tool = toolWith(async (url) => {
      requests.push(url)
      return response('', 302, { location: 'http://127.0.0.1/admin' })
    })
    const result = await tool.execute({ url: 'http://example.test/start' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('拒绝访问本机或内网地址')
    expect(requests).toEqual(['http://example.test/start'])
  })

  it('重定向到 file: 也在下一跳之前被拦下', async () => {
    let calls = 0
    const tool = toolWith(async () => {
      calls++
      return response('', 302, { location: 'file:///etc/passwd' })
    })
    const result = await tool.execute({ url: 'http://example.test/start' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('只允许 http/https')
    expect(calls).toBe(1)
  })

  it('相对重定向按当前 URL 解析，返回最终 URL', async () => {
    const seen: string[] = []
    const tool = toolWith(async (url) => {
      seen.push(url)
      if (seen.length === 1) return response('', 302, { location: '/next' })
      return response('<html><title>下一页</title><p>正文</p></html>', 200, {
        'content-type': 'text/html; charset=utf-8',
      })
    })
    const result = await tool.execute({ url: 'http://example.test/start' }, context())
    expect(result.isError).not.toBe(true)
    const parsed = JSON.parse(result.content) as { url: string; title: string; text: string; truncated: boolean }
    expect(seen).toEqual(['http://example.test/start', 'http://example.test/next'])
    expect(parsed).toMatchObject({ url: 'http://example.test/next', title: '下一页', truncated: false })
    expect(parsed.text).toContain('正文')
  })
})

describe('read_url 限额与解析', () => {
  it('超时：15s 的默认值可注入缩小，超时回可读错误', async () => {
    const tool = createReadUrlTool({
      resolveHost: publicResolve,
      timeoutMs: 30,
      fetchImpl: (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      },
    })
    const started = Date.now()
    const result = await tool.execute({ url: 'http://example.test/slow' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('读取超时')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('响应体超过字节上限时截断并标记 truncated', async () => {
    const body = 'a'.repeat(64)
    const tool = toolWith(
      async () => {
        return response(body, 200, { 'content-type': 'text/plain' })
      },
      { maxBytes: 32 },
    )
    const result = await tool.execute({ url: 'http://example.test/big' }, context())
    const parsed = JSON.parse(result.content) as { text: string; truncated: boolean }
    expect(parsed.truncated).toBe(true)
    expect(parsed.text.startsWith('a'.repeat(32))).toBe(true)
    expect(parsed.text).not.toContain('a'.repeat(33))
    expect(parsed.text).toContain('响应体超过 32 字节上限')
  })

  it('最终文本超过 20000 字（可注入缩小）时截断并说明原文长度', async () => {
    const body = '字'.repeat(50)
    const tool = toolWith(
      async () => {
        return response(body, 200, { 'content-type': 'text/plain' })
      },
      { maxChars: 10 },
    )
    const result = await tool.execute({ url: 'http://example.test/long' }, context())
    const parsed = JSON.parse(result.content) as { text: string; truncated: boolean }
    expect(parsed.truncated).toBe(true)
    expect(parsed.text).toContain('已截断')
    expect(parsed.text).toContain('原文共 50 字')
    expect(READ_URL_MAX_CHARS).toBe(20_000)
  })

  it('HTML 清洗：保留标题与段落，去掉 script/style/nav/footer，实体解码', async () => {
    const html = [
      '<!doctype html><html><head><title>示例 &amp; 标题</title><style>.x { color: red }</style></head>',
      '<body><nav>导航不要</nav><h1>主标题</h1>',
      '<p>第一段 &amp; 第二句&#20320;好</p>',
      "<script>alert('坏脚本')</script><footer>页脚不要</footer>",
      '</body></html>',
    ].join('')
    const tool = toolWith(async () => {
      return response(html, 200, { 'content-type': 'text/html; charset=utf-8' })
    })
    const result = await tool.execute({ url: 'http://example.test/page' }, context())
    const parsed = JSON.parse(result.content) as { title: string; text: string }
    expect(parsed.title).toBe('示例 & 标题')
    expect(parsed.text).toContain('主标题')
    expect(parsed.text).toContain('第一段 & 第二句你好')
    expect(parsed.text).not.toContain('导航不要')
    expect(parsed.text).not.toContain('页脚不要')
    expect(parsed.text).not.toContain('坏脚本')
    expect(parsed.text).not.toContain('color: red')
  })

  it('HTML 工具函数本身：标题、块级断行与命名/数字实体', () => {
    expect(decodeHtmlEntities('&lt;x&gt;&nbsp;&#20320;&#x597d;&amp;')).toBe('<x> 你好&')
    const parsed = htmlToText('<html><title>A &amp; B</title><body><div>一行</div><div>二行</div></body></html>')
    expect(parsed.title).toBe('A & B')
    expect(parsed.text).toContain('一行')
    expect(parsed.text).toContain('二行')
    expect(parsed.text.indexOf('一行')).toBeLessThan(parsed.text.indexOf('二行'))
  })

  it('非 HTML：JSON 与纯文本按原样返回', async () => {
    let payload = '{"ok":true,"text":"中文"}'
    let mime = 'application/json'
    const tool = toolWith(async () => {
      return response(payload, 200, { 'content-type': mime })
    })
    const json = await tool.execute({ url: 'http://example.test/data.json' }, context())
    const parsedJson = JSON.parse(json.content) as { text: string; truncated: boolean }
    expect(parsedJson.text).toBe(payload)
    expect(parsedJson.truncated).toBe(false)

    payload = '<b>这不是 HTML 响应</b>'
    mime = 'text/plain'
    const plain = await tool.execute({ url: 'http://example.test/raw.txt' }, context())
    const parsedPlain = JSON.parse(plain.content) as { text: string }
    expect(parsedPlain.text).toBe(payload)
  })

  it('PDF 只说明暂不支持解析', async () => {
    const tool = toolWith(async () => {
      return response('%PDF-1.7 binary', 200, { 'content-type': 'application/pdf' })
    })
    const result = await tool.execute({ url: 'http://example.test/doc.pdf' }, context())
    const parsed = JSON.parse(result.content) as { text: string; truncated: boolean }
    expect(parsed.text).toContain('暂不支持解析 PDF')
    expect(parsed.truncated).toBe(false)
  })

  it('HTTP 非 2xx 回工具错误', async () => {
    const tool = toolWith(async () => {
      return response('nope', 404, { 'content-type': 'text/plain' })
    })
    const result = await tool.execute({ url: 'http://example.test/missing' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('HTTP 404')
  })
})

describe('isPrivateAddress', () => {
  it('覆盖 IPv4 私网、IPv6 本机/链路本地/唯一本地与 IPv4-mapped', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.1.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })
})
