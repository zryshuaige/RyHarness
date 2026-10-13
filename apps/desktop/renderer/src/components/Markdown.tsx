/**
 * Markdown 渲染：marked lexer 产出 token 树，自写渲染器映射成 React 元素。
 * 不走 HTML 字符串/dangerouslySetInnerHTML，原始 HTML 一律按纯文本转义；
 * 链接/图片只允许 http(s)/mailto，其余协议（javascript: 等）降级为纯文本。
 */

import type { Token, Tokens } from 'marked'
import { lexer } from 'marked'
import type { ReactNode } from 'react'

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
      return <p key={key}>{renderInline((token as Tokens.Paragraph).tokens)}</p>
    case 'code': {
      const code = token as Tokens.Code
      return (
        <pre key={key}>
          <code className={code.lang !== undefined && code.lang !== '' ? `language-${code.lang}` : undefined}>
            {code.text}
          </code>
        </pre>
      )
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
      if (Array.isArray(other.tokens)) return <p key={key}>{renderInline(other.tokens)}</p>
      // html / def 等：纯文本降级（React 自动转义，绝不产生原始 HTML）。
      return <p key={key}>{other.raw ?? ''}</p>
    }
  }
}

function renderBlocks(tokens: Token[]): ReactNode[] {
  return tokens.map((token, index) => {
    return renderBlock(token, index)
  })
}

/** 把 Markdown 源渲染为 React 元素（永不产生原始 HTML）。 */
export function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(lexer(text))}</>
}
