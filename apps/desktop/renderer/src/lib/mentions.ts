/**
 * @提及补全的纯逻辑：从输入文本与光标位置解析补全状态，并按关键字过滤候选。
 *
 * 为什么从 store.ts 搬出来：这两个函数是**纯函数**（输入字符串，输出一个纯数据），
 * 住在状态模块里有两个坏处——一是把「状态」与「算法」混在一个文件，读者要翻
 * 1500 行才能找到一段 20 行的字符串处理；二是它们被 ChatInput 与两个测试直接
 * import，等于渲染层的状态模块成了「人人都能引的公共库」，任何人都能往里塞东西。
 *
 * 口径不变：@ 后只允许普通名字字符，遇到空白说明 @ 已结束。
 */

/** @补全状态：@ 的起点与已输入的关键字。 */
export interface MentionQuery {
  /** @ 在文本中的下标。 */
  start: number
  /** @ 之后已输入的名字片段。 */
  query: string
}

/** 从输入文本与光标位置解析 @补全状态；无补全时返回 null。 */
export function mentionQueryAt(text: string, cursor: number): MentionQuery | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  const query = before.slice(at + 1)
  // @ 后只允许普通名字字符；遇到空白说明 @ 已结束。
  if (/[\s@]/.test(query)) return null
  return { start: at, query }
}

/** 按 query 过滤候选名字（大小写不敏感包含匹配）。 */
export function filterMentions<T extends { id: string; name: string }>(members: T[], query: string): T[] {
  const lowered = query.toLowerCase()
  return members.filter((member) => {
    return member.name.toLowerCase().includes(lowered)
  })
}
