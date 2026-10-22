/**
 * 外链交给系统浏览器。
 *
 * 渲染层有五处 `target="_blank"`（Markdown 里的链接、「去官网申请 API Key」、
 * 产物的「在新窗口打开」…）。此前主进程既没有 `setWindowOpenHandler`，也没有
 * `shell.openExternal`，于是它们开出来的是**应用自己的新窗口**：无边框、无菜单、
 * 独立任务栏，看起来像被劫持，而用户真正的浏览器被绕开了。
 *
 * 这里钉住两件事：哪些 URL 允许递出去（http/https，其余一律拒），以及窗口
 * 自身不许导航到站外。
 *
 * @module @ryharness/desktop/tests/external-link
 */

import { describe, expect, it } from 'vitest'
import {
  externalLinkUrl,
  externalNavigationTarget,
  externalWindowOpenHandler,
  MAX_EXTERNAL_URL_LENGTH,
} from '../electron/main.ts'

/** 应用页面的 origin（资源服务）。 */
const PAGE_ORIGIN = 'http://127.0.0.1:32101'

describe('外链 URL 策略', () => {
  it('http 与 https 放行', () => {
    expect(externalLinkUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(externalLinkUrl('http://example.com')).toBe('http://example.com/')
  })

  it('file: / javascript: / data: 一律拒（不把本机能力递出去）', () => {
    expect(externalLinkUrl('file:///C:/Windows/System32/cmd.exe')).toBeUndefined()
    expect(externalLinkUrl('javascript:alert(1)')).toBeUndefined()
    expect(externalLinkUrl('data:text/html,<h1>hi</h1>')).toBeUndefined()
  })

  it('畸形输入与空串拒', () => {
    expect(externalLinkUrl('')).toBeUndefined()
    expect(externalLinkUrl('   ')).toBeUndefined()
    expect(externalLinkUrl('not a url')).toBeUndefined()
  })

  it('超长 URL 拒（畸形输入的常见形状）', () => {
    expect(externalLinkUrl(`https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`)).toBeUndefined()
  })
})

describe('窗口新开请求（setWindowOpenHandler）', () => {
  it('http/https 交给系统浏览器，且一律 deny 掉应用内新窗口', () => {
    const opened: string[] = []
    const handler = externalWindowOpenHandler((url) => {
      opened.push(url)
    })
    expect(handler({ url: 'https://example.com/a' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'http://example.com/b' })).toEqual({ action: 'deny' })
    expect(opened).toEqual(['https://example.com/a', 'http://example.com/b'])
  })

  it('file: / javascript: 不递出去，也不开窗', () => {
    const opened: string[] = []
    const handler = externalWindowOpenHandler((url) => {
      opened.push(url)
    })
    expect(handler({ url: 'file:///C:/secret.txt' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(opened).toEqual([])
  })
})

describe('窗口自身导航（will-navigate）', () => {
  it('站内放行', () => {
    expect(externalNavigationTarget(`${PAGE_ORIGIN}/app`, PAGE_ORIGIN)).toEqual({ allow: true })
  })

  it('站外拦下并交给系统浏览器', () => {
    const decision = externalNavigationTarget('https://example.com/x', PAGE_ORIGIN)
    expect(decision.allow).toBe(false)
    expect(decision.external).toBe('https://example.com/x')
  })

  it('站外的非 http(s) 拦下但不外送', () => {
    const decision = externalNavigationTarget('file:///C:/secret.txt', PAGE_ORIGIN)
    expect(decision.allow).toBe(false)
    expect(decision.external).toBeUndefined()
  })

  it('畸形地址拦下', () => {
    expect(externalNavigationTarget('not a url', PAGE_ORIGIN)).toEqual({ allow: false })
  })
})
