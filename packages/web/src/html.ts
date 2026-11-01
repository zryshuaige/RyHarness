/**
 * HTML → 可读正文。
 *
 * 不引解析器：输入已经被字节上限约束住，这里只需要「去掉脚本样式导航、按块级标签
 * 断行、解码实体」这一组可预测的动作。引一个解析器要多一份依赖，而它带来的能力
 * （CSS 选择器、容错修复）这份用途用不上。
 *
 * 做法与 apps/server 的 web-read 不同：那边是一串正则替换，这条路是单遍扫描——
 * 扫到一个标签就决定它是「丢掉整段」「留个换行」还是「当作普通标签抹掉」。
 * 单遍的好处是嵌套标签的深度靠一个计数器就能管住，不必指望正则跨标签配对。
 * @module @ryharness/web/html
 */

/** 整段丢掉的元素：里面的文字不是正文。 */
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'footer',
  'header',
  'aside',
  'form',
  'iframe',
])

/** 块级元素：这些标签前后断行，不然整页会挤成一坨。 */
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ul',
  'ol',
  'tr',
  'td',
  'th',
  'table',
  'thead',
  'tbody',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'br',
  'hr',
])

/** 常用命名实体：覆盖正文里最常见的那几个，不追求完整 HTML5 实体表。 */
const ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['copy', '©'],
  ['reg', '®'],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['times', '×'],
  ['middot', '·'],
  ['bull', '•'],
  ['deg', '°'],
  ['euro', '€'],
  ['pound', '£'],
  ['yen', '¥'],
  ['sect', '§'],
  ['para', '¶'],
])

/**
 * 解码 HTML 实体：命名实体 + 十进制 + 十六进制。
 * @param text - 原始文本。
 * @returns 解码后的文本。
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return whole
    }
    return ENTITIES.get(body.toLowerCase()) ?? whole
  })
}

/** 抹掉标签，只留里面的文字。 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

/** 连续空白压成一个空格，行尾的空白也去掉。 */
export function collapseText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

/** 抽出 `<title>` 里的文字。 */
function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return undefined
  const title = collapseText(stripTags(match[1] ?? ''))
  return title.length === 0 ? undefined : title
}

/**
 * HTML → 标题 + 正文。
 *
 * 元素属性里带 `>` 的极端写法会让标签正则提前收尾，最坏结果只是多留一段文字，
 * 不会把标签当正文交给模型——所以这里不值得为它引一个真正的解析器。
 * @param html - 原始 HTML。
 * @returns 标题（没有则省略）与正文文本。
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const title = extractTitle(withoutComments)
  // head 整段拿掉：里面的 title 与 meta 不是正文。先按「有闭合标签」才删，
  // 免得没有 </head> 的残缺页面把正文整段吃掉。
  const body = withoutComments.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
  const pieces: string[] = []
  let cursor = 0
  let dropped = 0
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?\/?>/g
  let match = tagPattern.exec(body)
  while (match !== null) {
    if (dropped === 0) pieces.push(body.slice(cursor, match.index))
    const name = (match[1] ?? '').toLowerCase()
    const closing = match[0].startsWith('</')
    if (DROPPED.has(name)) {
      // 整段丢掉：开标签进深度，闭标签出深度。
      if (!closing) dropped += 1
      else if (dropped > 0) dropped -= 1
    } else if (BLOCKS.has(name) && dropped === 0) {
      pieces.push('\n')
    }
    cursor = match.index + match[0].length
    match = tagPattern.exec(body)
  }
  if (dropped === 0) pieces.push(body.slice(cursor))
  const text = decodeEntities(pieces.join(''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title === undefined ? { text } : { title, text }
}
