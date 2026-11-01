/**
 * 用例共用的脚手架：一个内存会话库 + 两个会话 + 固定的消息序列。
 *
 * 单独放一个文件是因为六七份用例要共用同一套数据：复制一遍既长，又会在重复代码
 * 门禁上被记一笔。
 *
 * 消息序列（seq 是全局自增的，两个会话共用一个序列）：
 *   1  用户   「帮我看看这份配置」        conv-1 第 0 轮
 *   2  助理   「好的，我先读一下。」+ 工具调用 call-1
 *   3  工具   工具结果（call-1 的结果）
 *   4  助理   「配置里有三个键。」
 *   5  用户   「再帮我导出成 ZIP」        conv-1 第 1 轮
 *   6  助理   「已经导好了。」+ 一件产物
 *   7  用户   「今天天气不错」            conv-2 第 0 轮
 */

import type { StoredMessage } from '@ryharness/session'
import { SessionStore } from '@ryharness/session'

/** 脚手架造出来的东西。 */
export interface Fixture {
  /** 内存会话库。 */
  store: SessionStore
  /** 第一个会话 id（两轮、六条消息）。 */
  conversationId: string
  /** 第二个会话 id（一条消息）。 */
  otherConversationId: string
  /** 落库的六条消息（按 seq 升序）。 */
  messages: StoredMessage[]
}

/** 造一个内存会话库与上面那份数据。 */
export function createFixture(): Fixture {
  const store = new SessionStore(':memory:')
  const conversation = store.createConversation({ kind: 'direct', title: '配置检查', memberAgentIds: ['agent-a'] })
  const other = store.createConversation({ kind: 'direct', title: '闲聊', memberAgentIds: ['agent-b'] })

  const first = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    senderId: 'user-1',
    contentBlocks: [{ type: 'text', text: '帮我看看这份配置' }],
    turnIndex: 0,
  })
  const second = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'agent-a',
    contentBlocks: [
      { type: 'text', text: '好的，我先读一下配置。' },
      { type: 'tool-call', id: 'call-1', name: 'fs_read', arguments: '{}' },
    ],
    turnIndex: 0,
  })
  const third = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'system',
    contentBlocks: [{ type: 'text', text: '配置文件读出来了，一共三个键。' }],
    toolCallId: 'call-1',
    turnIndex: 0,
  })
  const fourth = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'agent-a',
    contentBlocks: [{ type: 'text', text: '配置里有三个键。' }],
    turnIndex: 0,
  })
  const fifth = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    senderId: 'user-1',
    contentBlocks: [{ type: 'text', text: '再帮我导出成 ZIP' }],
    turnIndex: 1,
  })
  const sixth = store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'agent-a',
    contentBlocks: [{ type: 'text', text: '已经导好了，附件在下面。' }],
    turnIndex: 1,
    artifacts: [{ callId: 'call-2', name: '配置导出.zip', size: 128, mime: 'application/zip' }],
  })
  store.appendMessage({
    conversationId: other.id,
    senderType: 'user',
    senderId: 'user-1',
    contentBlocks: [{ type: 'text', text: '今天天气不错' }],
    turnIndex: 0,
  })

  return {
    store,
    conversationId: conversation.id,
    otherConversationId: other.id,
    messages: [first, second, third, fourth, fifth, sixth],
  }
}
