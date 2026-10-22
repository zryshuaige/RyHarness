/**
 * CSP 契约：产物预览必须真的能显示。
 *
 * 页面由资源服务伺服（`DEFAULT_ASSETS_PORT`），产物字节却在 API 服务
 * （`DEFAULT_BACKEND_PORT`）上——端口不同即不同源。此前 CSP 写的是
 * `img-src 'self' data:`，于是：
 *
 * - 产物图片（`<img src={api.fileRawUrl(...)}>`）被 img-src 拦掉；
 * - HTML 产物的 blob: iframe 被 frame-src（回落到 default-src 'self'）拦掉；
 * - PDF 内嵌（`<object data={api.fileRawUrl(...)}>`）被 object-src 拦掉。
 *
 * 三者都是"空白一块且没有任何报错"——用户看到的是"这应用显示不了图片"，
 * 而不是"有一条 CSP 规则写错了"。而"产物是可回顾的文件"正是本产品的主张。
 *
 * 本文件把「产物 URL 满足 CSP」这件事钉成可执行断言：解析 index.html 里那条
 * CSP，用一个极小的匹配器判断给定 URL 放不放行——只钉字符串的话，改成
 * `img-src *` 也能过，那就把这个洞重新打开了。
 *
 * @module @ryharness/desktop/tests/csp
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(DESKTOP, 'renderer/index.html'), 'utf8')
const mainSource = readFileSync(join(DESKTOP, 'electron/main.ts'), 'utf8')

/** 页面 origin（资源服务）与 API origin（后端）：端口相邻，宿主都是回环。 */
const PAGE_ORIGIN = 'http://127.0.0.1:32101'
const API_ORIGIN = 'http://127.0.0.1:32100'

/** 从 index.html 里取出 CSP 串。 */
function cspOf(): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
  if (match === null) throw new Error('index.html 里找不到 Content-Security-Policy')
  return match[1] as string
}

/** 解析 CSP：指令名 → 源表达式列表。 */
function directives(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of cspOf().split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const [name, ...sources] = trimmed.split(/\s+/)
    if (name === undefined) continue
    map.set(name, sources)
  }
  return map
}

/**
 * 一条源表达式放不放行某个 URL。
 *
 * 只覆盖本仓真正用到的形式：'self'、data:、blob:、http(s)://host[:port|*]。
 * 认不出的表达式一律判为不放行——宁可让测试红，也不让一个没读懂的规则蒙混过关。
 */
function sourceAllows(source: string, url: URL): boolean {
  if (source === "'self'") return url.origin === PAGE_ORIGIN
  if (source === 'data:') return url.protocol === 'data:'
  if (source === 'blob:') return url.protocol === 'blob:'
  const match = /^(https?):\/\/([^/:]+)(?::(\*|\d+))?$/.exec(source)
  if (match === null) return false
  const scheme = match[1] as string
  const host = match[2] as string
  const port = match[3]
  if (scheme !== url.protocol.replace(':', '')) return false
  if (host !== url.hostname) return false
  if (port === undefined || port === '*') return true
  return port === url.port
}

/** 某条指令放不放行某个 URL（缺该指令时回落到 default-src）。 */
function allows(directive: string, url: URL): boolean {
  const map = directives()
  const sources = map.get(directive) ?? map.get('default-src') ?? []
  return sources.some((source) => {
    return sourceAllows(source, url)
  })
}

describe('CSP：产物预览要放行', () => {
  it('产物图片（API 源）放行', () => {
    expect(allows('img-src', new URL(`${API_ORIGIN}/api/files/chart.png/raw?token=t`))).toBe(true)
  })

  it('HTML 产物的 blob: iframe 放行', () => {
    expect(allows('frame-src', new URL('blob:http://127.0.0.1:32101/9f0a-4b2c'))).toBe(true)
  })

  it('PDF 内嵌（object + API 源）放行', () => {
    expect(allows('object-src', new URL(`${API_ORIGIN}/api/files/report.pdf/raw?token=t`))).toBe(true)
  })

  it('回环上的任意端口都放行（端口被占用时会回退随机端口）', () => {
    expect(allows('img-src', new URL('http://127.0.0.1:41234/api/files/a.png'))).toBe(true)
  })
})

describe('CSP：不该放行的不放行', () => {
  it('不放行任意来源（*）', () => {
    for (const source of directives().values()) {
      expect(source).not.toContain('*')
    }
  })

  it('不放行任意外网 https:', () => {
    for (const source of directives().values()) {
      expect(source).not.toContain('https:')
    }
  })

  it('不放行非回环主机', () => {
    expect(allows('img-src', new URL('https://example.com/a.png'))).toBe(false)
    expect(allows('img-src', new URL('http://evil.example.com/a.png'))).toBe(false)
  })

  it('不放行 file: 与 javascript:（object-src 尤其要紧）', () => {
    expect(allows('object-src', new URL('file:///C:/Windows/System32/cmd.exe'))).toBe(false)
    expect(allows('object-src', new URL('javascript:alert(1)'))).toBe(false)
  })

  it('script-src 仍然只放行 self + unsafe-inline（不放行 unsafe-eval）', () => {
    const sources = directives().get('script-src') ?? []
    expect(sources).toContain("'self'")
    expect(sources).not.toContain("'unsafe-eval'")
  })
})

describe('CSP 与端口布局是同一件事', () => {
  it('资源服务与后端是两个端口（同源规则因此不成立）', () => {
    expect(mainSource).toContain('DEFAULT_BACKEND_PORT = 32100')
    expect(mainSource).toContain('DEFAULT_ASSETS_PORT = DEFAULT_BACKEND_PORT + 1')
  })

  it('后端只监听回环（放行 http://127.0.0.1:* 不会把接口开到外网）', () => {
    expect(mainSource).toContain("const BACKEND_HOST = '127.0.0.1'")
  })

  it('connect-src 放行的是同一组回环地址', () => {
    const sources = directives().get('connect-src') ?? []
    expect(sources).toContain('http://127.0.0.1:*')
    expect(sources).toContain('ws://127.0.0.1:*')
  })
})
