/**
 * Markdown 渲染：marked lexer 产出 token 树，自写渲染器映射成 React 元素。
 * 不走 HTML 字符串/dangerouslySetInnerHTML，原始 HTML 一律按纯文本转义；
 * 链接/图片只允许 http(s)/mailto，其余协议（javascript: 等）降级为纯文本。
 */

import type { Token, Tokens } from 'marked'
import { lexer } from 'marked'
import { type ReactNode, useMemo, useState } from 'react'
import { Icon } from './Icon.tsx'
import { type MentionOptions, MentionText } from './MentionText.tsx'

/** 只允许安全协议的链接地址；不安全返回 undefined（调用方降级为文本）。 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (typeof href !== 'string') return undefined
  const trimmed = href.trim()
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : undefined
}

/**
 * 行内渲染的上下文。
 *
 * 为什么需要它：@提及 是正文里的一段**普通文本**（marked 眼里没有「@某人」这种
 * 东西），要把它画成蓝色链接，只能在文本 token 这一层接一手。上下文一路从
 * Markdown 传到 renderInline，缺省时行为与从前完全一致（不接管文本）。
 */
export interface InlineContext {
  /** 文本 token 的替身：把原文交给 @ 解析器切段。 */
  renderText?: (text: string, key: number) => ReactNode
}

function renderInline(tokens: Token[] | undefined, ctx?: InlineContext): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    const key = index
    switch (token.type) {
      case 'strong':
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens, ctx)}</strong>
      case 'em':
        return <em key={key}>{renderInline((token as Tokens.Em).tokens, ctx)}</em>
      case 'del':
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, ctx)}</del>
      case 'codespan':
        return <code key={key}>{(token as Tokens.Codespan).text}</code>
      case 'br':
        return <br key={key} />
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        if (href === undefined) return <span key={key}>{renderInline(link.tokens, ctx)}</span>
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderInline(link.tokens, ctx)}
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
      default: {
        // 有 @ 上下文时交给它切段；没有就按原文返回，与从前逐字一致。
        // text / html / 未识别 token：一律按纯文本渲染（React 自动转义）。
        const source = (token as Tokens.Text).raw ?? (token as Tokens.Text).text
        if (ctx?.renderText !== undefined) return ctx.renderText(source, key)
        return source
      }
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
          <Icon name={copied ? 'check' : 'copy'} size={16} />
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

/**
 * 单个块的渲染。参数名用 block 而不是 marked 文档里的 token：本文件里
 * 「token」一词已被词法树占用（`Token[]`），块级参数另起一名读起来更清楚。
 */
function renderBlock(block: Token, key: number, ctx?: InlineContext): ReactNode {
  switch (block.type) {
    case 'heading': {
      const heading = block as Tokens.Heading
      const children = renderInline(heading.tokens, ctx)
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
          {renderInline((block as Tokens.Paragraph).tokens, ctx)}
        </p>
      )
    case 'code': {
      const code = block as Tokens.Code
      return <CodeBlock key={key} lang={code.lang} text={code.text} />
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks((block as Tokens.Blockquote).tokens, '', false, ctx)}</blockquote>
    case 'list': {
      const list = block as Tokens.List
      const items = list.items.map((item, itemIndex) => {
        return <li key={itemIndex}>{renderBlocks(item.tokens, '', false, ctx)}</li>
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
      const table = block as Tokens.Table
      return (
        <table key={key}>
          <thead>
            <tr>
              {table.header.map((cell, cellIndex) => {
                return <th key={cellIndex}>{renderInline(cell.tokens, ctx)}</th>
              })}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => {
              return (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    return <td key={cellIndex}>{renderInline(cell.tokens, ctx)}</td>
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
      const other = block as Tokens.Text & { tokens?: Token[] }
      // 列表项内的紧凑 text token 带 inline tokens，按行内渲染。
      if (Array.isArray(other.tokens))
        return (
          <p key={key} className="md-p">
            {renderInline(other.tokens, ctx)}
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

function renderBlocks(tokens: Token[], source = '', streaming = false, ctx?: InlineContext): ReactNode[] {
  const blocks = tokens.map((token, index) => {
    return renderBlock(token, index, ctx)
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

/* ---- 流式期的词法分析缓存 ----------------------------------------------
 * 流式期每个 flush 都对**整条消息**重新 lex 是纯浪费：实测 4KB 答案单次约 0.9ms、
 * 16KB 约 3ms，且与长度成正比，一轮流式累计可达数百毫秒到一秒（都在关键帧里）。
 * 做法是按「已闭合前缀 / 还在长的尾巴」切开，只重 lex 尾巴。
 * ---------------------------------------------------------------------- */

/**
 * 前缀缓存**按消息分槽**，而不是模块级单槽。
 *
 * 「同时只有一条消息在流式」是错的假设：群聊调度器并发跑 fanoutConcurrency 条 lane，
 * 两条消息交替 flush 时单槽必然互踩——`prefix.startsWith(lastPrefix)` 恒为 false，
 * 每帧退回整篇 lex，下面那套增量的收益在群聊里正好是零，而只测单流的用例量不出来。
 *
 * 槽数按「并发 lane 数 + 切会话残留」取，Map 按插入序迭代，命中时重插到队尾，
 * 于是队首就是最久没用过的那一槽。缓存里躺着整条前缀，内存不便宜，宁可少而准。
 */
const MAX_PREFIX_SLOTS = 8
const prefixCache = new Map<string, { prefix: string; tokens: Token[] }>()

/** 命中/未命中计数：排障「群聊里前缀缓存是不是失效了」时先看这组数（同 store.metrics）。 */
let prefixHits = 0
let prefixMisses = 0

export function prefixCacheStats(): { slots: number; hits: number; misses: number } {
  return { slots: prefixCache.size, hits: prefixHits, misses: prefixMisses }
}

function remember(cacheKey: string, prefix: string, tokens: Token[]): void {
  // 先删后插即「刷新使用时间」：命中过的槽排到队尾，淘汰时先动最久没用过的。
  prefixCache.delete(cacheKey)
  prefixCache.set(cacheKey, { prefix, tokens })
  while (prefixCache.size > MAX_PREFIX_SLOTS) {
    const oldest = prefixCache.keys().next()
    if (oldest.done === true) return
    prefixCache.delete(oldest.value)
  }
}

/** 前缀里的围栏代码块必须成对闭合：横跨 ``` 的切点会把代码块内容错判成新块。 */
function fenceBalanced(prefix: string): boolean {
  const fences = prefix.match(/^ {0,3}```/gm)
  return fences === null || fences.length % 2 === 0
}

/**
 * 找「已稳定前缀 / 还在长的尾巴」的切点。
 *
 * 切点取最后一个空行（Markdown 的块分隔符），并且必须不在围栏代码块内——
 * 代码块里的空行是内容，在那儿切会改变块边界。找不到合格切点时整篇都算尾巴，
 * 退化成"整篇 lex"的旧行为，不会渲染错。
 */
function splitSettled(source: string): { prefix: string; tail: string } {
  let searchEnd = source.length
  while (searchEnd > 0) {
    const index = source.lastIndexOf('\n\n', searchEnd - 1)
    if (index < 0) break
    const prefix = source.slice(0, index + 2)
    if (fenceBalanced(prefix)) return { prefix, tail: source.slice(index + 2) }
    searchEnd = index
  }
  return { prefix: '', tail: source }
}

/**
 * 流式期的词法结果：已闭合前缀只增量补，正在长的尾巴每帧重算。
 *
 * 每帧重 lex 整篇是纯浪费（实测 4KB 约 0.9ms、16KB 约 3ms，一轮流式累计几百毫秒到
 * 一秒，全在关键帧里）。已闭合前缀的新切点只可能在尾部，所以：
 * - 前缀只增不减时，只 lex 新增的 delta 再拼上（delta 必从块边界开始，因为切点就是空行）；
 * - 前缀回退/跳变（换会话、编辑重发）时整段重 lex；
 * - 尾巴永远重 lex（它还在变）。
 *
 * `cacheKey` 是消息的 React key（见 MessageBubble）：同一时刻多条消息在流式，缓存
 * 必须分槽，否则 lane 之间每帧互踩、增量退化成整篇 lex。缺省键留给单流调用方。
 *
 * 已知边界：极少数跨空行的松列表（如「1. a」空行「2. b」）在极端切分下可能被当成两个
 * 列表而不是一个松列表——只影响列表的收紧与编号，不影响内容。等价性用例会逐帧盯住它。
 *
 * 导出仅凭性能与等价性用例使用（`apps/desktop/tests/perf/`）。
 */
export function streamingTokens(text: string, cacheKey = ''): Token[] {
  const { prefix, tail } = splitSettled(text)
  if (prefix.length === 0) return lexer(text)
  const cached = prefixCache.get(cacheKey)
  let tokens: Token[]
  if (cached !== undefined && cached.prefix.length > 0 && prefix.startsWith(cached.prefix)) {
    const delta = prefix.slice(cached.prefix.length)
    tokens = delta.length === 0 ? cached.tokens : [...cached.tokens, ...lexer(delta)]
    prefixHits += 1
  } else {
    tokens = lexer(prefix)
    prefixMisses += 1
  }
  remember(cacheKey, prefix, tokens)
  const tailTokens = tail.length === 0 ? [] : lexer(tail)
  return [...tokens, ...tailTokens]
}

/**
 * 把 Markdown 源渲染为 React 元素（永不产生原始 HTML）。
 *
 * - 完成态：整篇 lex 一次（结果稳定，无缓存必要）。
 * - 流式期：`streamingTokens` 只重 lex 尾巴；`streaming` 只影响最后一个未闭合块的
 *   处理，已闭合部分两种模式完全同形——这是"生成结束瞬间整条重排"的根治点。
 * - 带 `mentions` 时，文本 token 交给 @ 解析器切段（见 InlineContext）。
 */
export function Markdown({
  text,
  streaming = false,
  cacheKey,
  mentions,
}: {
  text: string
  streaming?: boolean
  /** 流式前缀缓存的分槽键（消息 key）；群聊并发多条流式时必须带上。 */
  cacheKey?: string
  /** @提及：名单 + 悬停取资料 + 点一下送回输入框。 */
  mentions?: MentionOptions
}) {
  /**
   * 上下文必须**身份稳定**：它进了下面那个 useMemo 的依赖里，每换一次身份就等于
   * 整篇重新 lex 一遍（流式期每帧一次）。所以这里只在 mentions 真的变了时才换。
   */
  const ctx = useMemo(() => {
    if (mentions === undefined) return undefined
    return {
      renderText: (source: string, key: number): ReactNode => {
        return <MentionText key={key} text={source} {...mentions} />
      },
    }
  }, [mentions])
  const blocks = useMemo(() => {
    if (!streaming) return renderBlocks(lexer(text), text, false, ctx)
    return renderBlocks(streamingTokens(text, cacheKey ?? ''), text, true, ctx)
  }, [text, streaming, cacheKey, ctx])
  return <>{blocks}</>
}
