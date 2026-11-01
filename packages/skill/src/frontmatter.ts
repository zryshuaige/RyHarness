/**
 * YAML frontmatter 的「够用」解析器。
 *
 * 为什么自己写：技能文件开头是一段 `---` 包起来的 yaml 头，里面就 name 与
 * description 这几个字段。为此拉一个 yaml 依赖不值当——真 yaml 的那些坑（锚点、
 * 多文档、类型推导）在这儿一个都用不上，而多一个依赖就多一份供应链与构建负担。
 *
 * 支持的是**够用**那一档：
 * - `key: value`（标量；`true`/`false` 与数字会转成对应类型）；
 * - `key: [a, b]`（行内列表）；
 * - `key:` 下面缩进的 `- item`（块列表）；
 * - `key: |` / `key: >` 下面缩进的多行（块文本）。
 *
 * 不支持锚点、多文档、嵌套对象——技能头里没人写那些。解析不出来就当没有这一段：
 * 文件本身仍然是正文，不会因为头写坏了就整份丢掉。
 * @module @ryharness/skill/frontmatter
 */

/** frontmatter 里一个字段的值。 */
export type FrontmatterValue = string | number | boolean | readonly string[]

/** 解析结果。 */
export interface Frontmatter {
  /** 字段表（键是文件里写的那个 key）。 */
  readonly fields: Readonly<Record<string, FrontmatterValue>>
  /** 正文：去掉 frontmatter 之后的 markdown。 */
  readonly body: string
  /** 文件开头到底有没有 frontmatter。 */
  readonly hasFrontmatter: boolean
}

/** frontmatter 的分隔线。 */
const FENCE = '---'

/** `key: value` 那一行。 */
const KEY_PATTERN = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u

/**
 * 拆开 frontmatter 与正文。
 *
 * 没有成对的 `---` 就当没有 frontmatter——半截的头比没有头更难猜。
 * @param text - 文件全文。
 * @returns 字段表、正文与「到底有没有头」。
 */
export function parseFrontmatter(text: string): Frontmatter {
  // 行尾风格原样保留：正文是要给人看的 markdown，换行风格变了 diff 会很难看。
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  if (lines[0].trim() !== FENCE) {
    return { fields: {}, body: text, hasFrontmatter: false }
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      end = i
      break
    }
  }
  if (end < 0) {
    return { fields: {}, body: text, hasFrontmatter: false }
  }
  return {
    fields: parseFields(lines.slice(1, end)),
    body: lines.slice(end + 1).join(eol),
    hasFrontmatter: true,
  }
}

/**
 * 取一个字符串字段。
 * @param fields - 字段表。
 * @param key - 字段名。
 * @returns 是字符串就返回它；没有或者不是字符串就返回 undefined。
 */
export function frontmatterText(fields: Readonly<Record<string, FrontmatterValue>>, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 取一个列表字段。
 * @param fields - 字段表。
 * @param key - 字段名。
 * @returns 是列表就返回它；没有或者不是列表就返回 undefined。
 */
export function frontmatterList(
  fields: Readonly<Record<string, FrontmatterValue>>,
  key: string,
): readonly string[] | undefined {
  const value = fields[key]
  return isStringList(value) ? value : undefined
}

/** 是不是字符串列表（Array.isArray 的类型守卫版本）。 */
function isStringList(value: FrontmatterValue): value is readonly string[] {
  return Array.isArray(value)
}

/** 把 frontmatter 里的若干行读成字段表。 */
function parseFields(block: readonly string[]): Record<string, FrontmatterValue> {
  const fields: Record<string, FrontmatterValue> = {}
  for (let i = 0; i < block.length; i += 1) {
    const trimmed = block[i].trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = KEY_PATTERN.exec(trimmed)
    if (match === null) continue
    const key = match[1]
    const value = match[2].trim()

    // 块文本：`| ` 保留换行，`>` 把换行折成空格。
    if (value === '|' || value === '>') {
      const collected = collectIndented(block, i + 1)
      fields[key] = value === '|' ? collected.lines.join('\n') : collected.lines.join(' ')
      i = collected.next - 1
      continue
    }

    // 键后面没写值：可能是块列表，也可能就是个空值。
    if (value.length === 0) {
      const list = collectList(block, i + 1)
      if (list.items.length > 0) {
        fields[key] = list.items
        i = list.next - 1
        continue
      }
      fields[key] = ''
      continue
    }

    // 行内列表：`[a, b]`
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = splitInlineList(value.slice(1, -1))
      continue
    }

    fields[key] = scalar(value)
  }
  return fields
}

/** 收下后面连续的缩进行（块文本用）。 */
function collectIndented(block: readonly string[], from: number): { lines: string[]; next: number } {
  const out: string[] = []
  let i = from
  for (; i < block.length; i += 1) {
    const line = block[i]
    if (line.trim().length === 0) {
      out.push('')
      continue
    }
    if (!/^\s/u.test(line)) break
    out.push(line.trim())
  }
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop()
  return { lines: out, next: i }
}

/** 收下后面连续的 `- item` 行（块列表用）。 */
function collectList(block: readonly string[], from: number): { items: string[]; next: number } {
  const items: string[] = []
  let i = from
  for (; i < block.length; i += 1) {
    const trimmed = block[i].trim()
    if (!trimmed.startsWith('- ')) break
    items.push(unquote(trimmed.slice(2).trim()))
  }
  return { items, next: i }
}

/** 拆行内列表。 */
function splitInlineList(inner: string): string[] {
  return inner
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part.length > 0)
}

/** 去掉成对的引号。 */
function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' || first === "'") && first === last) return value.slice(1, -1)
  return value
}

/** 标量：true/false 与数字转成对应类型，其余按字符串。 */
function scalar(value: string): FrontmatterValue {
  const raw = unquote(value)
  const lower = raw.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (/^-?\d+$/u.test(raw)) return Number.parseInt(raw, 10)
  if (/^-?\d*\.\d+$/u.test(raw)) return Number.parseFloat(raw)
  return raw
}
