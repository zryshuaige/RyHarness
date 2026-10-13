// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, safeHref } from '../renderer/src/components/Markdown.tsx'
import { MessageBubble } from '../renderer/src/components/MessageBubble.tsx'
import type { UiMessage } from '../renderer/src/store.ts'

const fileUrl = (name: string): string => {
  return `/api/files/${name}`
}

function agentMessage(text: string, done: boolean): UiMessage {
  return {
    key: 'm1',
    senderType: 'agent',
    senderId: 'ryen',
    senderName: 'Ryen',
    turnIndex: 0,
    done,
    parts: [{ kind: 'text', text }],
  }
}

describe('Markdown 渲染', () => {
  it('标题/加粗/行内代码/代码块/列表渲染为对应元素', () => {
    const html = renderToStaticMarkup(
      <Markdown text={'# 标题\n\n正文 **加粗** 与 `code`\n\n```ts\nconst a = 1\n```\n\n- 甲\n- 乙'} />,
    )
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<pre><code class="language-ts">const a = 1</code></pre>')
    expect(html).toContain('<ul><li><p>甲</p></li><li><p>乙</p></li></ul>')
  })

  it('安全协议的链接渲染为 <a target=_blank>', () => {
    const html = renderToStaticMarkup(<Markdown text="[官网](https://example.com)" />)
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
  })

  it('XSS：<script> 原始 HTML 按纯文本转义，不产生 script 元素', () => {
    const html = renderToStaticMarkup(<Markdown text={'看看 <script>alert(1)</script> 这段'} />)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('XSS：javascript: 链接降级为纯文本，不产生 href', () => {
    const html = renderToStaticMarkup(<Markdown text="[点我](javascript:alert(1))" />)
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('点我')
  })

  it('XSS：onerror 图片（原始 HTML 与 markdown 图片两种注入）都被拦截', () => {
    // 原始 HTML 按纯文本转义：不产生真正的 <img> 元素，onerror 永远只是文本
    const rawHtml = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)>'} />)
    expect(rawHtml).not.toContain('<img')
    expect(rawHtml).toContain('&lt;img')
    const mdImg = renderToStaticMarkup(<Markdown text="![x](javascript:alert(1))" />)
    expect(mdImg).not.toContain('javascript:')
    expect(mdImg).not.toContain('<img')
  })

  it('safeHref 协议白名单', () => {
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c')
    expect(safeHref('http://a.b')).toBe('http://a.b')
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('vbscript:x')).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
  })
})

describe('MessageBubble 的 Markdown 开关', () => {
  it('完成的 agent 消息渲染 Markdown；流式中纯文本直出', () => {
    const done = renderToStaticMarkup(
      <MessageBubble message={agentMessage('**加粗**\n\n- 甲', true)} fileUrl={fileUrl} />,
    )
    expect(done).toContain('<strong>加粗</strong>')
    expect(done).toContain('<li>')

    const streaming = renderToStaticMarkup(
      <MessageBubble message={agentMessage('**加粗**', false)} fileUrl={fileUrl} />,
    )
    expect(streaming).not.toContain('<strong>')
    expect(streaming).toContain('**加粗**')
    expect(streaming).toContain('bubble-cursor')
  })

  it('用户消息不渲染 Markdown', () => {
    const user: UiMessage = {
      key: 'u1',
      senderType: 'user',
      senderId: 'user',
      senderName: '我',
      turnIndex: 0,
      done: true,
      parts: [{ kind: 'text', text: '**不解析**' }],
    }
    const html = renderToStaticMarkup(<MessageBubble message={user} fileUrl={fileUrl} />)
    expect(html).not.toContain('<strong>')
    expect(html).toContain('**不解析**')
  })
})
