/**
 * @提及解析：从消息文本匹配群成员（按名字或 id，支持单 @ 与多 @）。
 *
 * 匹配规则：`@名字` 或 `@id`，候选串按长度从长到短匹配（避免 @Ryen 吃掉
 * @Ryen2 的一部分）；命中位置后若紧跟字母/数字/下划线/汉字字符则视为更长
 * 名字的一部分，跳过（避免把 @CodeBot2 误判为 @CodeBot）。
 *
 * 为什么也认 id：模型的措辞不受控——它可能写 `@工程师` 也可能写
 * `@ryen-team-coding`（派工提示里两者都给）。只认名字时，写 id 等于没派
 * 出去，而界面上看不出任何异常。
 * @module @ryharness/group/mentions
 */

import type { AgentDefinition } from '@ryharness/agent'

/**
 * 名字后续字符若是这些，说明 @ 到的其实是更长的名字。
 *
 * 连字符必须在里面：agent id 形如 `ryen-team-coding`，少了它，@ryen-team-coding
 * 会先命中 `ryen`（调度员自己），接力直接派错人——真实群聊里就是这么错过的。
 */
const NAME_CONTINUATION = /[\w一-龥-]/

/**
 * 解析文本中 @ 到的群成员（按首次出现顺序去重）。
 * @param text - 消息文本。
 * @param members - 群成员定义。
 * @returns 被 @ 到的成员（不含重复）。
 */
export function parseMentions(text: string, members: readonly AgentDefinition[]): AgentDefinition[] {
  // 候选串：名字与 id 各算一个；同一个人被两种写法命中只留最早出现的那次。
  const candidates = members
    .flatMap((agent) => {
      return agent.id === agent.name ? [`@${agent.name}`] : [`@${agent.name}`, `@${agent.id}`]
    })
    .sort((a, b) => {
      return b.length - a.length
    })
  const agentOf = new Map<string, AgentDefinition>()
  for (const agent of members) agentOf.set(`@${agent.name}`, agent)
  for (const agent of members) {
    if (agent.id !== agent.name) agentOf.set(`@${agent.id}`, agent)
  }
  const found: { index: number; agent: AgentDefinition }[] = []
  for (const needle of candidates) {
    const agent = agentOf.get(needle)
    if (agent === undefined) continue
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
    .sort((a, b) => {
      return a.index - b.index
    })
    .map((hit) => {
      return hit.agent
    })
    .filter((agent) => {
      if (seen.has(agent.id)) return false
      seen.add(agent.id)
      return true
    })
}
