// @vitest-environment jsdom
/**
 * Markdown 渲染与流式词法缓存。
 *
 * 分槽那条是群聊专属的回归网：调度器并发跑多条 lane，两条消息交替 flush 时，
 * 「已稳定前缀」放在模块级单槽里会每帧互踩、增量退化成整篇 lex（群聊里 16× 的
 * 优化等于零）。这里钉的是命中计数这条硬指标，与机器快慢无关。
 */
import { lexer } from 'marked'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, prefixCacheStats, safeHref, streamingTokens } from '../renderer/src/components/Markdown.tsx'
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
    expect(html).toContain('<ul><li><p class="md-p">甲</p></li><li><p class="md-p">乙</p></li></ul>')
  })

  it('代码块带语言标签与悬浮复制按钮（容器而非裸 <pre>）', () => {
    const html = renderToStaticMarkup(<Markdown text={'```python\nprint(1)\n```'} />)
    expect(html).toContain('class="md-code"')
    expect(html).toContain('class="md-code-bar"')
    expect(html).toContain('class="md-code-lang">python')
    expect(html).toContain('class="md-code-copy"')
    expect(html).toContain('复制代码')
    expect(html).toContain('<code class="language-python">print(1)</code>')
    // 无语言标注的围栏块退回 text 标签，不留空标签
    const plain = renderToStaticMarkup(<Markdown text={'```\n裸代码\n```'} />)
    expect(plain).toContain('class="md-code-lang">text')
  })

  it('流式与完成态的段落结构完全同形（单换行不塌成空格，不会整条重排）', () => {
    const source = '第一行\n第二行'
    const streaming = renderToStaticMarkup(<Markdown text={source} streaming />)
    const settled = renderToStaticMarkup(<Markdown text={source} />)
    expect(streaming).toBe(settled)
    expect(streaming).toContain('class="md-p"')
    expect(streaming).toContain('第一行\n第二行')
  })

  it('未闭合的尾块降级为纯文本：列表/表格先不排版，闭合后落回结构', () => {
    const openList = renderToStaticMarkup(<Markdown text={'- 甲\n- 乙'} streaming />)
    expect(openList).not.toContain('<ul>')
    expect(openList).toContain('md-tail')
    expect(openList).toContain('- 甲')
    // 闭合后（末尾有空行）恢复结构化排版
    const closedList = renderToStaticMarkup(<Markdown text={'- 甲\n\n正文'} streaming />)
    expect(closedList).toContain('<ul>')
    expect(closedList).not.toContain('md-tail')

    const openTable = renderToStaticMarkup(<Markdown text={'| a | b |\n| --- | --- |\n| 1 | 2 |'} streaming />)
    expect(openTable).not.toContain('<table>')
    expect(openTable).toContain('md-tail')
    const closedTable = renderToStaticMarkup(<Markdown text={'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n'} streaming />)
    expect(closedTable).toContain('<table>')
  })

  it('形状稳定的块（标题/围栏/引用）流式期不降级', () => {
    const fence = renderToStaticMarkup(<Markdown text={'```ts\nconst a = 1'} streaming />)
    expect(fence).toContain('<code class="language-ts">const a = 1</code>')
    expect(fence).not.toContain('md-tail')
    const heading = renderToStaticMarkup(<Markdown text={'# 标题\n正文'} streaming />)
    expect(heading).toContain('<h1>标题</h1>')
    expect(heading).not.toContain('md-tail')
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

describe('流式前缀缓存按消息分槽', () => {
  /** 一段有多个空行块边界的正文：只有跨过空行才有「已稳定前缀」可缓存。 */
  const paragraph = '这是一段用来撑出稳定前缀的正文，长度足够长到词法分析真的花时间。'
  const doc = (paragraphs: number): string => {
    return Array.from({ length: paragraphs }, () => paragraph).join('\n\n')
  }
  /** 逐段追加的帧：切点落在段落边界上，前缀每帧都在增长（模型吐 token 的真实形状）。 */
  const framesOf = (paragraphs: number): string[] => {
    const frames: string[] = []
    for (let index = 0; index < paragraphs; index++) frames.push(doc(index + 1))
    return frames
  }

  it('两条消息交替 flush：结果与整篇 lex 逐帧一致', () => {
    const frames = framesOf(60)
    for (let index = 0; index < frames.length; index++) {
      const text = frames[index] as string
      const cached = streamingTokens(text, `msg-${index % 2}`)
      expect(cached.map((token) => token.type)).toEqual(lexer(text).map((token) => token.type))
    }
  })

  it('两条消息交替 flush：前缀缓存仍然命中（单槽实现下这里全是 miss）', () => {
    const frames = framesOf(60)
    const before = prefixCacheStats()
    for (let index = 0; index < frames.length; index++) {
      streamingTokens(frames[index] as string, `slot-${index % 2}`)
    }
    const after = prefixCacheStats()
    const hits = after.hits - before.hits
    const misses = after.misses - before.misses
    // 每条 lane 只在「前缀还没成立」的那一帧整段重 lex；退回单槽就是每帧一次 miss。
    expect(misses).toBeLessThanOrEqual(4)
    expect(hits).toBeGreaterThan(frames.length * 0.9)
  })

  it('槽位有上界：长会话滚过很多条消息也不会把内存带跑', () => {
    for (let index = 0; index < 200; index++) streamingTokens(doc(4), `msg-${index}`)
    expect(prefixCacheStats().slots).toBeLessThanOrEqual(8)
  })

  it('气泡把消息 key 当分槽键传下去（不传，两条消息就共用一个槽）', () => {
    const text = doc(6)
    const bubble = (key: string): string => {
      return renderToStaticMarkup(
        <MessageBubble
          message={{
            key,
            senderType: 'agent',
            senderId: 'ryen',
            senderName: 'Ryen',
            turnIndex: 7,
            done: false,
            parts: [{ kind: 'text', text }],
          }}
          fileUrl={fileUrl}
        />,
      )
    }
    const before = prefixCacheStats()
    // 同一段正文、两个不同的消息 key：分槽生效时各占一槽，两次都是该槽的首次整段 lex。
    bubble('stream:ryen:71')
    bubble('stream:ryen:72')
    expect(prefixCacheStats().misses - before.misses).toBe(2)
  })
})

describe('MessageBubble 的 Markdown 开关', () => {
  it('agent 消息全程渲染 Markdown：流式中已是最终布局，不等 done 才重排', () => {
    const done = renderToStaticMarkup(
      <MessageBubble message={agentMessage('**加粗**\n\n- 甲', true)} fileUrl={fileUrl} />,
    )
    expect(done).toContain('<strong>加粗</strong>')
    expect(done).toContain('<li>')

    const streaming = renderToStaticMarkup(
      <MessageBubble message={agentMessage('**加粗**', false)} fileUrl={fileUrl} />,
    )
    expect(streaming).toContain('<strong>加粗</strong>')
    expect(streaming).toContain('bubble-cursor')
  })

  it('流式与完成态的气泡 HTML 只差流式光标', () => {
    const strip = (html: string): string => {
      return html.replace(/<span class="bubble-cursor">▍<\/span>/g, '')
    }
    const streaming = renderToStaticMarkup(
      <MessageBubble message={agentMessage('# 标题\n第一行\n第二行', false)} fileUrl={fileUrl} />,
    )
    const settled = renderToStaticMarkup(
      <MessageBubble message={agentMessage('# 标题\n第一行\n第二行', true)} fileUrl={fileUrl} />,
    )
    expect(strip(streaming)).toBe(strip(settled))
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
