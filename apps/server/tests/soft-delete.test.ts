/**
 * 删除会话改**软删**，并且能撤销。
 *
 * 物理删的问题是"不可撤销"：删掉一个会话，用户连"我删错了"都说不出口。删除
 * 恰恰是最容易手滑的一下——列表行尾那个键就在三像素外。
 *
 * 软删之后消息、FTS 索引、调度事件都还在库里，撤销只是把标记清掉。
 *
 * @module @ryharness/server/tests/soft-delete
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir === undefined) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

async function startServer(): Promise<{ server: RyHarnessServer; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-softdelete-test-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({ port: 0, dataDir })
  return { server, base: server.url }
}

describe('删除会话 = 软删，可撤销', () => {
  it('删完会话从列表里消失，但消息还在库里', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '要删的',
        memberAgentIds: ['ryen'],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '还在库里' }],
      })

      const deleted = await fetch(`${base}/api/conversations/${conversation.id}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)

      const list = await fetch(`${base}/api/conversations`)
      const body = (await list.json()) as { conversations: { id: string }[] }
      expect(
        body.conversations.map((row) => {
          return row.id
        }),
      ).not.toContain(conversation.id)
      // 数据一条不动——撤销要的就是它们原样还在。
      expect(server.store.listMessages(conversation.id)).toHaveLength(1)
      expect(server.store.isConversationDeleted(conversation.id)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('撤销删除：会话回到列表，消息还在', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '要删的',
        memberAgentIds: ['ryen'],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '还在库里' }],
      })
      await fetch(`${base}/api/conversations/${conversation.id}`, { method: 'DELETE' })

      const restored = await fetch(`${base}/api/conversations/${conversation.id}/restore`, { method: 'POST' })
      expect(restored.status).toBe(200)

      const list = await fetch(`${base}/api/conversations`)
      const body = (await list.json()) as { conversations: { id: string }[] }
      expect(
        body.conversations.map((row) => {
          return row.id
        }),
      ).toContain(conversation.id)
      expect(server.store.listMessages(conversation.id)).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('撤销一个没删过的会话 → 404（不假装成功）', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
      const restored = await fetch(`${base}/api/conversations/${conversation.id}/restore`, { method: 'POST' })
      expect(restored.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it('删掉的会话不再出现在搜索结果里', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '季度总结写好了' }],
      })
      await fetch(`${base}/api/conversations/${conversation.id}`, { method: 'DELETE' })

      const response = await fetch(`${base}/api/search?q=${encodeURIComponent('季度总结')}`)
      const body = (await response.json()) as { results: { conversationId: string }[] }
      expect(body.results).toHaveLength(0)
    } finally {
      await server.close()
    }
  })
})
