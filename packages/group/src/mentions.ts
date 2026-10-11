/**
 * @提及解析：从消息文本匹配群成员（按名字，支持单 @ 与多 @）。
 *
 * 匹配规则：`@名字`，名字按长度从长到短匹配（避免 @Ryen 吃掉 @Ryen2
 * 的一部分）；命中位置后若紧跟字母/数字/下划线/汉字字符则视为更长名字的
 * 一部分，跳过（避免把 @CodeBot2 误判为 @CodeBot）。
 * @module @ryagent/group/mentions
 */

import type { AgentDefinition } from '@ryagent/agent'

/** 名字后续字符若是这些，说明 @ 到的其实是更长的名字。 */
const NAME_CONTINUATION = /[\w一-龥]/

/**
 * 解析文本中 @ 到的群成员（按首次出现顺序去重）。
 * @param text - 消息文本。
 * @param members - 群成员定义。
 * @returns 被 @ 到的成员（不含重复）。
 */
export function parseMentions(text: string, members: readonly AgentDefinition[]): AgentDefinition[] {
  const byLength = [...members].sort((a, b) => { return b.name.length - a.name.length })
  const found: { index: number; agent: AgentDefinition }[] = []
  for (const agent of byLength) {
    const needle = `@${agent.name}`
    let from = 0
    while (from <= text.length) {
      const at = text.indexOf(needle, from)
      if (at === -1) break
      const after = text[at + needle.length]
      if (after !== undefined && NAME_CONTINUATION.test(after)) {
        from = at + 1
        continue
      }
      found.push({ index: at, agent })
      from = at + needle.length
    }
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => { return a.index - b.index })
    .map((hit) => { return hit.agent })
    .filter((agent) => {
      if (seen.has(agent.id)) return false
      seen.add(agent.id)
      return true
    })
}
