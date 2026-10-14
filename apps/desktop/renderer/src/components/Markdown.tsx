/**
 * Markdown 渲染：marked lexer 产出 token 树，自写渲染器映射成 React 元素。
 * 不走 HTML 字符串/dangerouslySetInnerHTML，原始 HTML 一律按纯文本转义；
 * 链接/图片只允许 http(s)/mailto，其余协议（javascript: 等）降级为纯文本。
 */

import type { Token, Tokens } from 'marked'
import { lexer } from 'marked'
import { type ReactNode, useMemo, useState } from 'react'
import { Icon } from './Icon.tsx'

/** 只允许安全协议的链接地址；不安全返回 undefined（调用方降级为文本）。 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (typeof href !== 'string') return undefined
  const trimmed = href.trim()
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : undefined
}

function renderInline(tokens: Token[] | undefined): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = index
    switch (token.type) {
      case 'strong':
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens)}</strong>
      case 'em':
        return <em key={key}>{renderInline((token as Tokens.Em).tokens)}</em>
      case 'del':
        return <del key={key}>{renderInline((token as Tokens.Del).tokens)}</del>
      case 'codespan':
        return <code key={key}>{(token as Tokens.Codespan).text}</code>
      case 'br':
        return <br key={key} />
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        if (href === undefined) return <span key={key}>{renderInline(link.tokens)}</span>
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderInline(link.tokens)}
          </a>
        )
      }
      case 'image': {
        const image = token as Tokens.Image
        const src = safeHref(image.href)
        if (src === undefined) return <span key={key}>{image.text}</span>
        return <img key={key} src={src} alt={image.text} />
      }
      case 'escape':
        return (token as Tokens.Escape).text
      default:
        // text / html / 未识别 token：一律按纯文本渲染（React 自动转义）。
        return (token as Tokens.Text).raw ?? (token as Tokens.Text).text
    }
  })
}

/** 代码块：语言标签 + 悬浮复制。复制的是原始代码文本，不是渲染后的 DOM。 */
function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 1200)
    } catch {
      // 剪贴板不可用时静默（与气泡复制一致）。
    }
  }
  const label = lang === undefined || lang === '' ? 'text' : lang
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{label}</span>
        <button
          type="button"
          className="md-code-copy"
          title="复制代码"
          aria-label="复制代码"
          onClick={() => {
            void copy()
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code className={label === 'text' ? undefined : `language-${label}`}>{text}</code>
      </pre>
    </div>
  )
}

/**
 * 流式期尾块降级白名单：列表与表格在「还没写完」时形状最不稳——
 * 序号、项目符号与表格边框会随着 token 一个一个长出来。所以未闭合时先按
 * 纯文本渲染（用户看到的正是模型写的原文），闭合后再落回结构化排版。
 * 段落/标题/引用/围栏代码块的形状在 token 追加过程中不变，不降级。
 */
const UNSTABLE_TAIL: ReadonlySet<string> = new Set(['list', 'table'])

/** 源码末尾没有空行 ⇒ 最后一个块还"开着"，后面可能继续来内容。 */
function tailIsOpen(source: string): boolean {
  return !/\n[ \t]*\n$/.test(source)
}

function renderBlock(token: Token, key: number): ReactNode {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      const children = renderInline(heading.tokens)
      switch (heading.depth) {
        case 1:
          return <h1 key={key}>{children}</h1>
        case 2:
          return <h2 key={key}>{children}</h2>
        case 3:
          return <h3 key={key}>{children}</h3>
        case 4:
          return <h4 key={key}>{children}</h4>
        case 5:
          return <h5 key={key}>{children}</h5>
        default:
          return <h6 key={key}>{children}</h6>
      }
    }
    case 'paragraph':
      // md-p 带 pre-wrap：模型把单换行当换行用（清单、诗、命令输出），
      // 塌成空格的话整条气泡会在生成结束那一刻重排。流式期与完成态因此同形。
      return (
        <p key={key} className="md-p">
          {renderInline((token as Tokens.Paragraph).tokens)}
        </p>
      )
    case 'code': {
      const code = token as Tokens.Code
      return <CodeBlock key={key} lang={code.lang} text={code.text} />
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks((token as Tokens.Blockquote).tokens)}</blockquote>
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, itemIndex) => {
        return <li key={itemIndex}>{renderBlocks(item.tokens)}</li>
      })
      return list.ordered ? (
        <ol key={key} start={typeof list.start === 'number' && list.start > 1 ? list.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'table': {
      const table = token as Tokens.Table
      return (
        <table key={key}>
          <thead>
            <tr>
              {table.header.map((cell, cellIndex) => {
                return <th key={cellIndex}>{renderInline(cell.tokens)}</th>
              })}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => {
              return (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    return <td key={cellIndex}>{renderInline(cell.tokens)}</td>
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      )
    }
    case 'hr':
      return <hr key={key} />
    case 'space':
      return null
    default: {
      const other = token as Tokens.Text & { tokens?: Token[] }
      // 列表项内的紧凑 text token 带 inline tokens，按行内渲染。
      if (Array.isArray(other.tokens))
        return (
          <p key={key} className="md-p">
            {renderInline(other.tokens)}
          </p>
        )
      // html / def 等：纯文本降级（React 自动转义，绝不产生原始 HTML）。
      return (
        <p key={key} className="md-p">
          {other.raw ?? ''}
        </p>
      )
    }
  }
}

function renderBlocks(tokens: Token[], source = '', streaming = false): ReactNode[] {
  const blocks = tokens.map((token, index) => {
    return renderBlock(token, index)
  })
  if (!streaming) return blocks
  const last = tokens[tokens.length - 1]
  if (last === undefined || !UNSTABLE_TAIL.has(last.type) || !tailIsOpen(source)) return blocks
  blocks[tokens.length - 1] = (
    <p key={tokens.length - 1} className="md-p md-tail">
      {(last as { raw?: string }).raw ?? ''}
    </p>
  )
  return blocks
}

/** 把 Markdown 源渲染为 React 元素（永不产生原始 HTML）。
 *  lex 结果按 text 缓存：气泡里 copied/feedback 的 useState 变化不再整篇重 lex。
 *  `streaming` 只影响最后一个未闭合块的处理，已闭合的部分两种模式完全同形——
 *  这是"生成结束瞬间整条重排"的根治点：布局在流式期就已经是最终形态。 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => {
    return renderBlocks(lexer(text), text, streaming)
  }, [text, streaming])
  return <>{blocks}</>
}
