/**
 * 历史改写：截断 / 改写正文 / 复制（"编辑并重发""重新生成""从这里分支"的存储底座）。
 *
 * 这三件事改的都是**同一份历史**，错一处用户看到的就是"我那句话不见了"或
 * "搜到的还是旧正文"——所以每条原语都带着它必须连带处理的东西一起测：
 *
 * - 截断：FTS 索引行、空轮次的调度事件、已读游标；
 * - 改写：FTS 索引行（不重写就搜到旧正文）；
 * - 复制：新会话里的 FTS 索引（分支出去的正文要能被搜到）。
 *
 * 软删（删除可撤销）在这里一起测：删除只是打标记，数据一条不动。
 *
 * @module @ryharness/session/tests/history-rewrite
 */

import { SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

function store(): SessionStore {
  return new SessionStore(':memory:')
}

describe('软删与撤销', () => {
  it('标记删除后会话从列表里消失，数据一条不动', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: '要删的', memberAgentIds: ['ryen'] })
    s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '还在库里' }],
    })

    expect(s.markConversationDeleted(conversation.id)).toBe(true)
    expect(s.getConversation(conversation.id)).toBeUndefined()
    expect(
      s.listConversations().map((c) => {
        return c.id
      }),
    ).not.toContain(conversation.id)
    expect(
      s.listConversationsWithPreview().map((c) => {
        return c.id
      }),
    ).not.toContain(conversation.id)
    expect(s.isConversationDeleted(conversation.id)).toBe(true)
    // 消息还在：撤销要的就是它们原样不动。
    expect(s.listMessages(conversation.id)).toHaveLength(1)
  })

  it('撤销删除后会话回到列表', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: '要删的', memberAgentIds: ['ryen'] })
    s.markConversationDeleted(conversation.id)
    expect(s.restoreConversation(conversation.id)).toBe(true)
    expect(s.getConversation(conversation.id)).toBeDefined()
    expect(
      s.listConversations().map((c) => {
        return c.id
      }),
    ).toContain(conversation.id)
    expect(s.isConversationDeleted(conversation.id)).toBe(false)
  })

  it('重复标记 / 重复撤销不报错，但只有第一次生效', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    expect(s.markConversationDeleted(conversation.id)).toBe(true)
    expect(s.markConversationDeleted(conversation.id)).toBe(false)
    expect(s.restoreConversation(conversation.id)).toBe(true)
    expect(s.restoreConversation(conversation.id)).toBe(false)
  })
})

describe('截断历史', () => {
  it('删掉 seq ≥ fromSeq 的消息，并同步清掉 FTS 索引行', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    const first = s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '要保留的话' }],
    })
    s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '要删掉的话' }],
    })

    const removed = s.truncateMessages(conversation.id, first.seq + 1)
    expect(removed).toBe(1)
    expect(s.listMessages(conversation.id)).toHaveLength(1)
    // 索引行不删的话，搜索命中的就是已经删掉的消息。
    expect(s.searchMessages('要删掉')).toHaveLength(0)
    expect(s.searchMessages('要保留')).toHaveLength(1)
  })

  it('已读游标跟着下调（不能落在被删的区间里）', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '一' }],
    })
    const second = s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '二' }],
    })
    s.markConversationRead(conversation.id)
    expect(s.getConversation(conversation.id)?.lastReadSeq).toBe(second.seq)

    s.truncateMessages(conversation.id, second.seq)
    expect(s.getConversation(conversation.id)?.lastReadSeq).toBeLessThan(second.seq)
  })

  it('那一轮的消息一条不剩时，调度轨迹一起清掉', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '一' }],
      turnIndex: 0,
    })
    s.recordDispatchEvent({
      conversationId: conversation.id,
      fromAgent: 'ryen',
      toAgent: 'coder',
      reason: '派工',
      turnIndex: 0,
    })
    s.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'coder',
      contentBlocks: [{ type: 'text', text: '二' }],
      turnIndex: 0,
    })
    expect(s.listDispatchEvents(conversation.id)).toHaveLength(1)

    s.truncateMessages(conversation.id, 1)
    expect(s.listDispatchEvents(conversation.id)).toHaveLength(0)
  })
})

describe('改写用户消息的正文', () => {
  it('改写成功，且 FTS 索引跟着更新', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    const message = s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '项目进度同步会纪要' }],
    })

    // 换的新旧两句刻意**不共享 bigram**：FTS 的查询串是 OR 语义
    // （见 fts.ts 的 ftsMatchQuery），共享任何一个 bigram 都会互撞。
    expect(s.updateUserMessageText(conversation.id, message.seq, '午饭去哪里吃比较好')).toBe(true)
    expect(s.listMessages(conversation.id)[0]?.contentBlocks).toEqual([{ type: 'text', text: '午饭去哪里吃比较好' }])
    expect(s.searchMessages('项目进度同步会纪要')).toHaveLength(0)
    expect(s.searchMessages('午饭去哪里吃比较好')).toHaveLength(1)
  })

  it('agent 的消息改不了', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    const message = s.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'ryen',
      contentBlocks: [{ type: 'text', text: '它说的' }],
    })
    expect(s.updateUserMessageText(conversation.id, message.seq, '我改')).toBe(false)
  })

  it('带附件的消息改不了（改正文会把附件一起丢掉）', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    const message = s.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [
        { type: 'text', text: '看附件' },
        { type: 'file', name: 'a.png', mime: 'image/png', size: 10 },
      ],
    })
    expect(s.updateUserMessageText(conversation.id, message.seq, '只看这句')).toBe(false)
  })

  it('会话里没有这条消息时返回 false', () => {
    const s = store()
    const conversation = s.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
    expect(s.updateUserMessageText(conversation.id, 999, '改不到')).toBe(false)
  })
})

describe('复制历史（从这里分支）', () => {
  it('复制过去的内容与源一致，且两边各说各的', () => {
    const s = store()
    const source = s.createConversation({ kind: 'direct', title: '源', memberAgentIds: ['ryen'] })
    const target = s.createConversation({ kind: 'direct', title: '分支', memberAgentIds: ['ryen'] })
    s.appendMessage({
      conversationId: source.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '分支之前的话' }],
    })
    const cutoff = s.appendMessage({
      conversationId: source.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '分支点' }],
    })
    s.appendMessage({
      conversationId: source.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '分支之后的话' }],
    })

    expect(s.copyMessagesTo(source.id, cutoff.seq, target.id)).toBe(2)
    const copied = s.listMessages(target.id)
    expect(copied).toHaveLength(2)
    expect(
      copied.map((m) => {
        return (m.contentBlocks[0] as { text?: string }).text
      }),
    ).toEqual(['分支之前的话', '分支点'])
    // 之后改一边不影响另一边。
    s.appendMessage({
      conversationId: target.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '分支这边新说的' }],
    })
    expect(s.listMessages(source.id)).toHaveLength(3)
  })

  it('复制过去的内容在目标会话里能被搜到（索引按新 seq 重写）', () => {
    const s = store()
    const source = s.createConversation({ kind: 'direct', title: '源', memberAgentIds: ['ryen'] })
    const target = s.createConversation({ kind: 'direct', title: '分支', memberAgentIds: ['ryen'] })
    s.appendMessage({
      conversationId: source.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '季度总结写好了' }],
    })
    const cutoff = s.listMessages(source.id)[0] as { seq: number }
    s.copyMessagesTo(source.id, cutoff.seq, target.id)

    const hits = s.searchMessages('季度总结', { conversationId: target.id })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.conversationId).toBe(target.id)
  })
})
