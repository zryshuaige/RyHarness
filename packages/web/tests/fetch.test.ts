/**
 * 抓网页：私网拦截、逐跳重定向复核、钉地址、限额与 HTML 清洗。
 *
 * 所有出站请求都走注入的假取回器：这些用例不该真的访问互联网，也不该靠「某个网站
 * 今天恰好长这样」来断言解析器。
 */
import { describe, expect, it } from 'vitest'
import type { HttpResponse, PinnedFetch } from '../src/index.ts'
import { webFetch } from '../src/index.ts'

const PUBLIC_IP = '93.184.216.34'

/** 解析器：任何域名都解析到同一个公网地址。 */
const resolvePublic = async (): Promise<readonly string[]> => [PUBLIC_IP]

/** 造一个假响应。 */
function reply(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: Buffer.from(body, 'utf8'), truncated: false }
}

describe('抓网页的安全边界', () => {
  it('协议不对与内网地址在发出请求之前就挡住', async () => {
    let calls = 0
    const fetchImpl: PinnedFetch = async () => {
      calls++
      return reply('不该被请求')
    }
    await expect(webFetch('http://127.0.0.1/admin', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      '拒绝访问本机或内网地址',
    )
    await expect(webFetch('file:///etc/passwd', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      '只允许 http/https',
    )
    expect(calls).toBe(0)
  })

  it('域名解析到私网同样不发请求', async () => {
    let calls = 0
    const fetchImpl: PinnedFetch = async () => {
      calls++
      return reply('不该被请求')
    }
    const resolvePrivate = async (): Promise<readonly string[]> => ['10.1.2.3']
    await expect(webFetch('http://internal.example/', { fetchImpl, resolveHost: resolvePrivate })).rejects.toThrow(
      '拒绝访问本机或内网地址',
    )
    expect(calls).toBe(0)
  })

  it('重定向到私网：下一跳在发出之前就被拦下', async () => {
    const requested: string[] = []
    const fetchImpl: PinnedFetch = async (url) => {
      requested.push(url)
      return reply('', 302, { location: 'http://127.0.0.1/admin' })
    }
    await expect(webFetch('http://example.test/start', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      '拒绝访问本机或内网地址',
    )
    expect(requested).toEqual(['http://example.test/start'])
  })

  it('重定向到 file: 也在下一跳之前被拦下', async () => {
    let calls = 0
    const fetchImpl: PinnedFetch = async () => {
      calls++
      return reply('', 302, { location: 'file:///etc/passwd' })
    }
    await expect(webFetch('http://example.test/start', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      '只允许 http/https',
    )
    expect(calls).toBe(1)
  })

  it('重定向没有 Location、或者跳得太多，都给中文错误', async () => {
    const noLocation: PinnedFetch = async () => reply('', 302)
    await expect(
      webFetch('http://example.test/start', { fetchImpl: noLocation, resolveHost: resolvePublic }),
    ).rejects.toThrow('重定向，但没有 Location')
    const loop: PinnedFetch = async () => reply('', 302, { location: 'http://example.test/loop' })
    await expect(webFetch('http://example.test/loop', { fetchImpl: loop, resolveHost: resolvePublic })).rejects.toThrow(
      '重定向次数过多',
    )
  })

  it('相对重定向按当前 URL 解析，返回最终 URL', async () => {
    const requested: string[] = []
    const fetchImpl: PinnedFetch = async (url) => {
      requested.push(url)
      if (requested.length === 1) return reply('', 302, { location: '/next' })
      return reply('<html><title>下一页</title><p>正文</p></html>', 200, {
        'content-type': 'text/html; charset=utf-8',
      })
    }
    const page = await webFetch('http://example.test/start', { fetchImpl, resolveHost: resolvePublic })
    expect(requested).toEqual(['http://example.test/start', 'http://example.test/next'])
    expect(page.url).toBe('http://example.test/next')
    expect(page.title).toBe('下一页')
    expect(page.text).toContain('正文')
  })

  it('跨域重定向逐跳重新校验、重新钉地址', async () => {
    const resolvedHosts: string[] = []
    const pins: (string | undefined)[] = []
    const resolveHost = async (hostname: string): Promise<readonly string[]> => {
      resolvedHosts.push(hostname)
      return [hostname === 'other.test' ? '203.0.113.9' : PUBLIC_IP]
    }
    const fetchImpl: PinnedFetch = async (url, _init, pin) => {
      pins.push(pin)
      if (url === 'http://example.test/start') return reply('', 302, { location: 'http://other.test/next' })
      return reply('正文', 200, { 'content-type': 'text/plain' })
    }
    const page = await webFetch('http://example.test/start', { fetchImpl, resolveHost })
    expect(resolvedHosts).toEqual(['example.test', 'other.test'])
    expect(pins).toEqual([PUBLIC_IP, '203.0.113.9'])
    expect(page.text).toBe('正文')
  })
})

describe('抓网页的限额与解析', () => {
  it('超时：上限到了就回中文错误，不等对方', async () => {
    const fetchImpl: PinnedFetch = async () => new Promise<HttpResponse>(() => {})
    const started = Date.now()
    await expect(
      webFetch('http://example.test/slow', { fetchImpl, resolveHost: resolvePublic, timeoutMs: 30 }),
    ).rejects.toThrow('读取超时')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('响应体超过字节上限时截断并说明', async () => {
    const fetchImpl: PinnedFetch = async () => reply('a'.repeat(64), 200, { 'content-type': 'text/plain' })
    const page = await webFetch('http://example.test/big', {
      fetchImpl,
      resolveHost: resolvePublic,
      maxBytes: 32,
    })
    expect(page.truncated).toBe(true)
    expect(page.text.startsWith('a'.repeat(32))).toBe(true)
    expect(page.text).not.toContain('a'.repeat(33))
    expect(page.text).toContain('响应体超过 32 字节上限')
  })

  it('正文超过字符上限时截断并说明原文长度', async () => {
    const fetchImpl: PinnedFetch = async () => reply('字'.repeat(50), 200, { 'content-type': 'text/plain' })
    const page = await webFetch('http://example.test/long', {
      fetchImpl,
      resolveHost: resolvePublic,
      maxChars: 10,
    })
    expect(page.truncated).toBe(true)
    expect(page.text).toContain('已截断')
    expect(page.text).toContain('原文共 50 字')
  })

  it('HTML 清洗：保留标题与段落，去掉脚本、样式与导航', async () => {
    const html = [
      '<!doctype html><html><head><title>示例 &amp; 标题</title><style>.x { color: red }</style></head>',
      '<body><nav>导航不要</nav><h1>主标题</h1>',
      '<p>第一段 &amp; 第二句&#20320;好</p>',
      "<script>alert('坏脚本')</script><footer>页脚不要</footer>",
      '</body></html>',
    ].join('')
    const fetchImpl: PinnedFetch = async () => reply(html, 200, { 'content-type': 'text/html; charset=utf-8' })
    const page = await webFetch('http://example.test/page', { fetchImpl, resolveHost: resolvePublic })
    expect(page.title).toBe('示例 & 标题')
    expect(page.text).toContain('主标题')
    expect(page.text).toContain('第一段 & 第二句你好')
    expect(page.text).not.toContain('导航不要')
    expect(page.text).not.toContain('页脚不要')
    expect(page.text).not.toContain('坏脚本')
    expect(page.text).not.toContain('color: red')
  })

  it('非 HTML：JSON 与纯文本按原样返回', async () => {
    const json: PinnedFetch = async () =>
      reply('{"ok":true,"text":"中文"}', 200, { 'content-type': 'application/json' })
    const parsed = await webFetch('http://example.test/data.json', {
      fetchImpl: json,
      resolveHost: resolvePublic,
    })
    expect(parsed.text).toBe('{"ok":true,"text":"中文"}')
    expect(parsed.truncated).toBe(false)

    const plain: PinnedFetch = async () => reply('<b>这不是 HTML 响应</b>', 200, { 'content-type': 'text/plain' })
    const raw = await webFetch('http://example.test/raw.txt', { fetchImpl: plain, resolveHost: resolvePublic })
    expect(raw.text).toBe('<b>这不是 HTML 响应</b>')
  })

  it('PDF 只说明暂不支持解析', async () => {
    const fetchImpl: PinnedFetch = async () => reply('%PDF-1.7 binary', 200, { 'content-type': 'application/pdf' })
    const page = await webFetch('http://example.test/doc.pdf', { fetchImpl, resolveHost: resolvePublic })
    expect(page.text).toContain('暂不支持解析 PDF')
    expect(page.truncated).toBe(false)
  })

  it('HTTP 非 2xx 回中文错误', async () => {
    const fetchImpl: PinnedFetch = async () => reply('nope', 404, { 'content-type': 'text/plain' })
    await expect(webFetch('http://example.test/missing', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      'HTTP 404',
    )
  })

  it('底层异常只回中文摘要，不把英文异常交给模型', async () => {
    const fetchImpl: PinnedFetch = async () => {
      throw new Error('socket hang up')
    }
    await expect(webFetch('http://example.test/x', { fetchImpl, resolveHost: resolvePublic })).rejects.toThrow(
      '请求失败：网络异常或连接被拒绝',
    )
  })
})
