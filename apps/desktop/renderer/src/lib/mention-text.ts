/**
 * @提及的正文解析：从一段文字里认出「@某人」，切成可渲染的片段。
 *
 * 为什么自己解析，而不是用服务端那份 mentions 字段：服务端没下发它
 * （渲染层的 MessageRow.mentions 是个空壳类型），@在正文里始终只是给人看的标记。
 * 把它画成什么样，是渲染层自己的事。
 *
 * 口径与输入框那套对齐（见 lib/mentions.ts）：@ 之后是名字，从补全里选中会写成
 * 「@名字 」。但渲染这一侧要宽一点，因为真到正文里两种边界都存在：
 * - 拉丁名有词边界：「@CodeBotx」不是「@CodeBot」。
 * - 中文名没有词边界：「@工程师帮我看看」里的「帮我看看」不该被算进名字。
 * 所以边界按**名字自己的写法**判断，而不是一律按空白断。
 */

/** 一个能被 @ 的对象：认得出名字就行。 */
export interface MentionTarget {
  id: string
  name: string
}

/** 正文切出来的一段：普通文字，或一段 @提及。 */
export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; text: string; target: MentionTarget }

/** 拉丁词字符：字母、数字、下划线。用来判「一个词还没结束」。 */
const WORD_CHAR = /[A-Za-z0-9_]/

/** CJK：中文名没有词边界，靠它把「名字」与后面的句子分开。 */
const CJK_CHAR = /[㐀-鿿豈-﫿]/

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch)
}

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK_CHAR.test(ch)
}

/**
 * 名字能不能到这儿为止。
 *
 * 拉丁名：后面必须不是词字符（@CodeBotx 不是 @CodeBot）。
 * 中文名：中文不用空格分词，后面跟什么都算名字结束（@工程师帮我 = @工程师 + 帮我）。
 */
function boundaryOk(name: string, next: string | undefined): boolean {
  if (next === undefined) return true
  const last = name[name.length - 1]
  if (last === undefined) return true
  if (isCjk(last)) return true
  return !isWordChar(next)
}

/**
 * 把正文切成「文字 / @提及」交替的片段。
 *
 * 只认**名单里真有的名字**：不认识的 @xxx 仍是普通文字——随手把邮箱、@某人 写在
 * 正文里的话，不该被染成一条谁也点不动的链接。
 */
export function parseMentions(text: string, targets: readonly MentionTarget[]): MentionSegment[] {
  if (text.length === 0) return []
  if (targets.length === 0) return [{ kind: 'text', text }]

  // 长的先试：@Code 要命中「CodeBot」而不是被「Code」截断。
  const sorted = [...targets].sort((a, b) => {
    return b.name.length - a.name.length
  })

  const segments: MentionSegment[] = []
  let plain = ''
  let cursor = 0

  const flush = (): void => {
    if (plain.length === 0) return
    segments.push({ kind: 'text', text: plain })
    plain = ''
  }

  while (cursor < text.length) {
    const at = text.indexOf('@', cursor)
    if (at === -1) break
    // '@' 前面是词字符：多半是邮箱或句柄，不是提及。
    if (at > 0 && isWordChar(text[at - 1])) {
      plain += text.slice(cursor, at + 1)
      cursor = at + 1
      continue
    }
    const hit = sorted.find((target) => {
      if (target.name.length === 0) return false
      if (!text.startsWith(target.name, at + 1)) return false
      return boundaryOk(target.name, text[at + 1 + target.name.length])
    })
    if (hit === undefined) {
      plain += text.slice(cursor, at + 1)
      cursor = at + 1
      continue
    }
    plain += text.slice(cursor, at)
    flush()
    segments.push({ kind: 'mention', text: `@${hit.name}`, target: hit })
    cursor = at + 1 + hit.name.length
  }
  plain += text.slice(cursor)
  flush()
  return segments
}
