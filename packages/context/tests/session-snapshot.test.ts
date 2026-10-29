import type { SessionSnapshotSource, SnapshotMessage, SnapshotSession } from '@ryharness/context'
import { buildSessionSnapshot } from '@ryharness/context'
import { describe, expect, it } from 'vitest'

/** 内存里的会话库：实现数据源接口，不碰真实的 SessionStore。 */
function fakeSource(
  sessions: readonly SnapshotSession[],
  messages: Readonly<Record<string, readonly SnapshotMessage[]>>,
): SessionSnapshotSource {
  return {
    session(conversationId: string): SnapshotSession | undefined {
      return sessions.find((item) => {
        return item.id === conversationId
      })
    },
    recentMessages(conversationId: string, limit: number): readonly SnapshotMessage[] {
      return (messages[conversationId] ?? []).slice(-limit)
    },
    recentSessions(excludeId: string | undefined, limit: number): readonly SnapshotSession[] {
      return sessions
        .filter((item) => {
          return item.id !== excludeId
        })
        .slice(0, limit)
    },
  }
}

const SESSIONS: readonly SnapshotSession[] = [
  { id: 'c1', title: '查店那件事' },
  { id: 'c2', title: '做报表' },
]

const MESSAGES: Record<string, readonly SnapshotMessage[]> = {
  c1: [
    { sender: 'user', text: '帮我看看城东那几家店' },
    { sender: 'agent', text: '看完了，三家评分都不低' },
  ],
  c2: [{ sender: 'user', text: '上个月的报表在哪' }],
}

describe('跨会话快照', () => {
  it('按 id 指定会话时装出那几条消息', () => {
    const block = buildSessionSnapshot({
      source: fakeSource(SESSIONS, MESSAGES),
      conversationId: 'c1',
    })
    expect(block?.session.id).toBe('c1')
    expect(block?.messageCount).toBe(2)
    expect(block?.text).toContain('用户：帮我看看城东那几家店')
    expect(block?.text).toContain('agent：看完了，三家评分都不低')
  })

  it('正文里写明这是另一个会话（模型不能当成自己说过的话）', () => {
    const block = buildSessionSnapshot({ source: fakeSource(SESSIONS, MESSAGES), conversationId: 'c1' })
    expect(block?.text).toContain('另一个会话')
    expect(block?.text).toContain('查店那件事')
    expect(block?.text).toContain('不是本次对话里说过的话')
  })

  it('不指定时取最近的会话，并把当前会话排除掉', () => {
    const block = buildSessionSnapshot({
      source: fakeSource(SESSIONS, MESSAGES),
      currentConversationId: 'c2',
    })
    expect(block?.session.id).toBe('c1')
  })

  it('指定的会话不存在时不产出块', () => {
    const block = buildSessionSnapshot({ source: fakeSource(SESSIONS, MESSAGES), conversationId: 'nope' })
    expect(block).toBeUndefined()
  })

  it('没有别的会话时不产出块', () => {
    const block = buildSessionSnapshot({
      source: fakeSource(SESSIONS, MESSAGES),
      currentConversationId: 'c1',
      conversationId: undefined,
    })
    // c2 还在最近列表里，所以有块；把列表清空才该没有。
    expect(block?.session.id).toBe('c2')
    const empty = buildSessionSnapshot({
      source: fakeSource([], {}),
      currentConversationId: 'c1',
    })
    expect(empty).toBeUndefined()
  })

  it('会话里没有消息时不产出块', () => {
    const block = buildSessionSnapshot({
      source: fakeSource([{ id: 'c3' }], {}),
      conversationId: 'c3',
    })
    expect(block).toBeUndefined()
  })

  it('条数有上限', () => {
    const many = Array.from({ length: 20 }, (_item, index) => {
      return { sender: 'user', text: `第 ${index} 句` }
    })
    const block = buildSessionSnapshot({
      source: fakeSource([{ id: 'c1' }], { c1: many }),
      conversationId: 'c1',
      maxMessages: 3,
    })
    expect(block?.messageCount).toBe(3)
    expect(block?.text).toContain('第 17 句')
    expect(block?.text).not.toContain('第 16 句')
  })

  it('字符数有上限，超了就写明截断', () => {
    const block = buildSessionSnapshot({
      source: fakeSource([{ id: 'c1' }], { c1: MESSAGES.c1 ?? [] }),
      conversationId: 'c1',
      maxChars: 20,
    })
    expect(block?.messageCount).toBe(1)
    expect(block?.text).toContain('快照已截断')
  })

  it('没有标题时用会话 id 当标题', () => {
    const block = buildSessionSnapshot({
      source: fakeSource([{ id: 'c9' }], { c9: [{ sender: 'user', text: '在吗' }] }),
      conversationId: 'c9',
    })
    expect(block?.text).toContain('c9')
  })

  it('空消息跳过，不占条数', () => {
    const block = buildSessionSnapshot({
      source: fakeSource([{ id: 'c1' }], {
        c1: [
          { sender: 'user', text: '   ' },
          { sender: 'agent', text: '在' },
        ],
      }),
      conversationId: 'c1',
    })
    expect(block?.messageCount).toBe(1)
    expect(block?.text).toContain('agent：在')
  })
})
