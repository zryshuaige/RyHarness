import { DEFAULT_HISTORY_BUDGET_TOKENS } from '@ryharness/agent'
import { buildGroupContext, DEFAULT_HISTORY_BUDGET_TOKENS as GROUP_HISTORY_BUDGET_TOKENS } from '@ryharness/group'
import type { ContentBlock } from '@ryharness/llm'
import { estimateTokens } from '@ryharness/llm'
import type { StoredMessage } from '@ryharness/session'
import { groupHistoryRowWeight, HISTORY_BUDGET_TOKENS, SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/**
 * 上下文预算的跨包单位不变量。
 *
 * 一个预算在三处被消费：@ryharness/session 的历史增量读、@ryharness/group 的群历史
 * 再裁、@ryharness/agent 的入口历史裁剪。历史上这条链断过一次：后两处迁到 token，
 * 群聊那一处仍按字符，于是同一份预算在 ASCII 群聊上被再收一刀（30k 字符 ≈ 7.5k
 * token），中文群聊上放行四倍，而症状只是"模型好像有点忘事"，没有任何红灯。
 *
 * 这里钉的是两件事：同一个预算在三处是同一个数；同一批行在三处是同一个单位
 * （token）。窗口本身不变量由 history-read.test.ts 的逐条等价断言负责。
 */

/** agent 包自己定义的那个默认窗口（另两包都取它）。 */
const AGENT_BUDGET = DEFAULT_HISTORY_BUDGET_TOKENS

const AGENT_NAMES = new Map([
  ['a1', 'CodeBot'],
  ['b1', 'Ryen'],
])

/** 群聊窗口：协调器实际走的那条（listMessagesForHistory + buildGroupContext）。 */
function groupWindow(store: SessionStore, conversationId: string): string {
  const rows = store.listMessagesForHistory(conversationId, HISTORY_BUDGET_TOKENS, {
    weightOf: (row) => {
      return groupHistoryRowWeight(row, AGENT_NAMES)
    },
    keepNewest: false,
    beforeTurnIndex: 100,
  })
  return buildGroupContext(
    rows.map((row) => {
      return groupEntryOf(row)
    }),
    HISTORY_BUDGET_TOKENS,
  )
}

/** coordinator.ts toGroupEntry 的测试副本（与生产函数逐行对齐）。 */
function groupEntryOf(row: StoredMessage): { speaker: string; text: string } {
  const text = (row.contentBlocks as ContentBlock[])
    .filter((block) => {
      return block.type === 'text'
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
  const speaker = row.senderType === 'user' ? '用户' : (AGENT_NAMES.get(row.senderId ?? '') ?? 'agent')
  return { speaker, text }
}

function appendText(store: SessionStore, conversationId: string, senderId: string, text: string): void {
  store.appendMessage({
    conversationId,
    senderType: senderId === 'user' ? 'user' : 'agent',
    senderId,
    contentBlocks: [{ type: 'text', text }],
    turnIndex: 0,
  })
}

describe('上下文预算的跨包单位契约', () => {
  it('同一个预算是同一个常量、同一个值（agent / session / group）', () => {
    expect(HISTORY_BUDGET_TOKENS).toBe(AGENT_BUDGET)
    expect(GROUP_HISTORY_BUDGET_TOKENS).toBe(AGENT_BUDGET)
    expect(HISTORY_BUDGET_TOKENS).toBeGreaterThan(0)
  })

  it('群聊：库里取出的窗口再过调度器裁剪是 no-op（ASCII 不再被收第二刀）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'group', memberAgentIds: ['a1', 'b1'] })
    // 40 行 × 800 ASCII 字符 ≈ 32k 字符 ≈ 8k token：字符口径的 30k 预算会丢掉
    // 一半，token 口径下必须一行不少。
    for (let i = 0; i < 40; i++) {
      appendText(store, conversation.id, i % 2 === 0 ? 'a1' : 'user', `${i}${'x'.repeat(799)}`)
    }
    const context = groupWindow(store, conversation.id)
    expect(context.split('\n')).toHaveLength(40)
    expect(context.length).toBeGreaterThan(HISTORY_BUDGET_TOKENS)
  })

  it('群聊：中文窗口同样按 token 裁（不是"中文就该全放行"）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'group', memberAgentIds: ['a1', 'b1'] })
    // 40 行 × 400 汉字 ≈ 16k token：token 预算只装得下半数，中文不再是例外。
    for (let i = 0; i < 40; i++) {
      appendText(store, conversation.id, i % 2 === 0 ? 'a1' : 'user', `${i}${'字'.repeat(399)}`)
    }
    const context = groupWindow(store, conversation.id)
    const kept = context.split('\n')
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(40)
    // 权重口径：被裁掉的一定是"装进预算就超"的那批，而不是按字符算出来的另一批。
    const rows = store.listMessagesForHistory(conversation.id, HISTORY_BUDGET_TOKENS, {
      weightOf: (row) => {
        return groupHistoryRowWeight(row, AGENT_NAMES)
      },
      keepNewest: false,
      beforeTurnIndex: 100,
    })
    const used = rows.reduce((sum, row) => {
      return sum + (groupHistoryRowWeight(row, AGENT_NAMES) ?? 0)
    }, 0)
    expect(used).toBeLessThanOrEqual(HISTORY_BUDGET_TOKENS)
  })

  it('群聊逐行权重 = 该行的 token 估算 + 换行（两处裁剪器逐条同边界）', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'group', memberAgentIds: ['a1', 'b1'] })
    appendText(store, conversation.id, 'a1', '这条很长'.repeat(100))
    appendText(store, conversation.id, 'user', 'short')
    const rows = store.listMessagesForHistory(conversation.id, HISTORY_BUDGET_TOKENS, {
      weightOf: (row) => {
        return groupHistoryRowWeight(row, AGENT_NAMES)
      },
      keepNewest: false,
      beforeTurnIndex: 100,
    })
    for (const row of rows) {
      const entry = groupEntryOf(row)
      expect(groupHistoryRowWeight(row, AGENT_NAMES)).toBe(estimateTokens(`${entry.speaker}: ${entry.text}`) + 1)
    }
  })
})
