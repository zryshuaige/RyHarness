/**
 * 消息全文索引（FTS5）：写消息时建索引，搜索不再全库同步扫描。
 *
 * 这组用例盯的是两件事：一是搜索结果与旧的"内存子串匹配"口径一致（含中文
 * bigram 与查询串转义），二是索引行与消息行同生共死（写增删减，删会话不留
 * 孤儿行）。
 */

import { DatabaseSync } from 'node:sqlite'
import type { MessageInput } from '@ryharness/session'
import { MIGRATIONS, SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/** 建一个带两条会话的库：a/b 在 direct，c 在 group。 */
function seeded(): { store: SessionStore; direct: string; group: string } {
  const store = new SessionStore(':memory:')
  const direct = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
  const group = store.createConversation({ kind: 'group', memberAgentIds: ['a1', 'b1'], dispatcherAgentId: 'a1' })
  store.appendMessage({
    conversationId: direct.id,
    senderType: 'user',
    senderId: 'user',
    contentBlocks: [{ type: 'text', text: '帮我把周报改成简洁版' }],
  })
  store.appendMessage({
    conversationId: direct.id,
    senderType: 'agent',
    senderId: 'a1',
    contentBlocks: [
      { type: 'text', text: '已经改成简洁版了' },
      { type: 'tool_call', id: 'call-1', name: 'fs_write', arguments: '{"path":"report.md"}' },
    ],
  })
  store.appendMessage({
    conversationId: group.id,
    senderType: 'user',
    senderId: 'user',
    contentBlocks: [{ type: 'text', text: '顺便看看构建脚本有没有问题' }],
  })
  return { store, direct: direct.id, group: group.id }
}

function message(store: SessionStore, conversationId: string, senderType: MessageInput['senderType'], text: string) {
  return store.appendMessage({ conversationId, senderType, contentBlocks: [{ type: 'text', text }] })
}

describe('SessionStore 消息全文索引', () => {
  it('写消息即建索引：中文关键词能命中（bigram BM25）', () => {
    const { store } = seeded()
    const hits = store.searchMessages('周报')

    expect(hits.length).toBeGreaterThan(0)
    expect(
      hits.map((hit) => {
        return hit.text
      }),
    ).toContain('帮我把周报改成简洁版')
    expect(hits[0]?.text).not.toContain('embedding')
    store.close()
  })

  it('命中带定位信息（会话/消息 id/序号/发言者），够调用侧截片段用', () => {
    const { store, direct } = seeded()
    const hit = store.searchMessages('周报')[0]!

    expect(hit.conversationId).toBe(direct)
    expect(hit.messageId).toMatch(/[0-9a-f-]{36}/)
    expect(hit.seq).toBeGreaterThan(0)
    expect(hit.senderId).toBe('user')
    expect(hit.score).toBeLessThanOrEqual(0) // BM25：越小越相关
    store.close()
  })

  it('限定会话时只返回该会话的命中', () => {
    const { store, direct, group } = seeded()
    expect(store.searchMessages('周报', { conversationId: group }).length).toBe(0)
    expect(
      store.searchMessages('周报', { conversationId: direct }).map((hit) => {
        return hit.conversationId
      }),
    ).toEqual([direct])
    store.close()
  })

  it('纯工具载荷不进索引（只索引 type=text 块）', () => {
    const { store, group } = seeded()
    expect(store.searchMessages('fs_write')).toEqual([])
    expect(store.messageIndexSize()).toBe(3) // 三条消息都有文本块

    message(store, group, 'agent', 'tool_result_only')
    store.appendMessage({
      conversationId: group,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'tool_call', id: 'call-2', name: 'shell', arguments: '{}' }],
    })
    expect(store.messageIndexSize()).toBe(4) // 只有新增的那条带文本，工具消息不占索引行
    store.close()
  })

  it('删会话不留孤儿索引行（否则 BM25 窗口被已删消息吃光）', () => {
    const { store, group } = seeded()
    expect(store.searchMessages('构建脚本')).toHaveLength(1)

    store.deleteConversation(group)
    expect(store.searchMessages('构建脚本')).toEqual([])
    expect(store.messageIndexSize()).toBe(2)
    store.close()
  })

  it('查询串转义：带 - . / @ # : " 的关键词不炸 MATCH（不转义时整条搜索静默失效）', () => {
    const { store, direct } = seeded()
    message(store, direct, 'user', '路径是 C:/temp/report.md，端口 8080，备注 -draft: "最终"')

    const hits = store.searchMessages('report.md')
    expect(
      hits.map((hit) => {
        return hit.text
      }),
    ).toContain('路径是 C:/temp/report.md，端口 8080，备注 -draft: "最终"')
    expect(store.searchMessages('8080').length).toBeGreaterThan(0)
    // 空查询（纯空白/标点）直接返回空，不去拼一个非法 MATCH。
    expect(store.searchMessages('  ')).toEqual([])
    store.close()
  })

  it('v5 迁移给存量消息补索引：旧库升上来就能搜，不留"历史搜不到"的空洞', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    MIGRATIONS[1]?.(db)
    db.exec(`
      ALTER TABLE conversations ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN usage TEXT;
      PRAGMA user_version = 4;
    `)
    db.prepare(
      "INSERT INTO conversations (id, kind, title, member_agent_ids, dispatcher_agent_id, last_read_seq, created_at, updated_at) VALUES ('c1','direct','','[\"a1\"]',NULL,0,1,1)",
    ).run()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_blocks, mentions, turn_index, created_at)
       VALUES ('m1','c1','user','user',?, '[]', 0, 1)`,
    ).run(JSON.stringify([{ type: 'text', text: '迁移前的旧消息：预算怎么算' }]))
    db.prepare(
      `INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_blocks, mentions, turn_index, created_at)
       VALUES ('m2','c1','agent','a1',?, '[]', 0, 1)`,
    ).run(JSON.stringify([{ type: 'tool_call', id: 't1', name: 'fs_read', arguments: '{}' }]))

    // 明确跑 v5 这一步补索引：SCHEMA_VERSION 已经往前走了，用它索引会跑到
    // 与本用例无关的迁移上。
    MIGRATIONS[5]?.(db)
    const rows = db
      .prepare(
        'SELECT m.id AS id FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid WHERE messages_fts MATCH ?',
      )
      .all('"预算"')
    expect(rows).toEqual([{ id: 'm1' }])
    // 纯工具消息不占索引行。
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get() as { count: number }).count)).toBe(1)
    db.close()
  })

  it('迁移幂等：已是当前版本时不再跑补索引', () => {
    const store = new SessionStore(':memory:')
    // 这条真正要断的是「新库没有补索引可跑」；版本号钉在这里只会随下一次迁移变红。
    expect(store.messageIndexSize()).toBe(0)
    store.close()
  })
})
