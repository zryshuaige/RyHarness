// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fromHistory, nextTurnIndex } from '../renderer/src/components/ChatView.tsx'
import type { MessageRow } from '../renderer/src/api.ts'

function row(partial: Partial<MessageRow> & Pick<MessageRow, 'id' | 'seq'>): MessageRow {
  return {
    conversationId: 'c1',
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '你好' }],
    mentions: [],
    turnIndex: 0,
    createdAt: 1000,
    ...partial,
  }
}

const nameOf = (id: string): string => { return id }

describe('fromHistory', () => {
  it('普通文本消息转换为 text 部件并保留 seq', () => {
    const messages = fromHistory([row({ id: 'm1', seq: 7 })], nameOf)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ seq: 7, done: true })
    expect(messages[0]!.parts).toEqual([{ kind: 'text', text: '你好' }])
  })

  it('纯 tool_call（无文本块、无 toolCallId）的 assistant 消息被跳过，不产生空气泡', () => {
    const messages = fromHistory([
      row({ id: 'm1', seq: 1 }),
      row({ id: 'm2', seq: 2, contentBlocks: [{ type: 'tool-call', text: undefined }] }),
      row({ id: 'm3', seq: 3, contentBlocks: [{ type: 'tool-call' }] }),
      row({ id: 'm4', seq: 4, contentBlocks: [] }),
    ], nameOf)
    expect(messages.map((m) => { return m.key })).toEqual(['hist:m1'])
  })

  it('带 toolCallId 的工具结果行仍渲染为工具部件', () => {
    const messages = fromHistory([
      row({ id: 'm5', seq: 5, toolCallId: 'c1', contentBlocks: [{ type: 'text', text: '〔tool〕fs_read: ok' }] }),
    ], nameOf)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.parts[0]).toMatchObject({ kind: 'tool', callId: 'c1', name: 'fs_read', status: 'done' })
  })
})

describe('nextTurnIndex', () => {
  it('基于历史 + 流式快照的最大 turnIndex + 1（旧会话发消息不从 0 重来）', () => {
    const history = [{ turnIndex: 4 }, { turnIndex: 4 }]
    const live = [{ turnIndex: 2 }]
    expect(nextTurnIndex([...history, ...live])).toBe(5)
    expect(nextTurnIndex([])).toBe(0)
  })
})
