/**
 * GET /api/search：走 FTS5 索引，不再全库同步扫描。
 *
 * 此前路由自己写了一套"每个会话倒序回看最近 500 条 + 内存子串匹配"的扫描：
 * 会话上限 1000，每行还要 JSON.parse 一遍正文——整段**同步跑在 Node 主线程**
 * 上。几百个会话 × 数万条消息时，那是几百毫秒到数秒的事件循环阻塞：正在
 * 流式的那一轮的 WS 帧发不出去，/cancel 排在后面，界面看起来就是卡住了。
 *
 * 索引（messages_fts）早就在：schema v5 建表 + 迁移回填、写消息时在同一事务
 * 里维护、删会话时同步清理、6 组测试覆盖。缺的只是路由没用它。
 *
 * 本文件钉住三件事：路由的结果与存储层的索引查询**是同一批**、中文 bigram
 * 查询真的能命中、以及**搜索路径不再碰 listMessages**（那正是全库扫描的入口）。
 *
 * @module @ryharness/server/tests/search-index
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  vi.restoreAllMocks()
})

async function startServer(): Promise<{ server: RyHarnessServer; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-search-test-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({ port: 0, dataDir })
  return { server, base: server.url }
}

/** 搜索结果项（GET /api/search 的形状）。 */
interface SearchHit {
  conversationId: string
  conversationTitle: string
  messageId: string
  snippet: string
  agentId: string
  createdAt: number
}

async function search(base: string, q: string, conversationId?: string): Promise<SearchHit[]> {
  const query =
    conversationId === undefined
      ? `?q=${encodeURIComponent(q)}`
      : `?q=${encodeURIComponent(q)}&conversationId=${encodeURIComponent(conversationId)}`
  const response = await fetch(`${base}/api/search${query}`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { results: SearchHit[] }
  return body.results
}

describe('GET /api/search 走 FTS5 索引', () => {
  it('中文 bigram 查询经路由能命中消息正文', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '周会',
        memberAgentIds: ['ryen'],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '上周的周报发我一份' }],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'agent',
        senderId: 'ryen',
        contentBlocks: [{ type: 'text', text: '这是本周的周报草稿' }],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '完全无关的一句话' }],
      })

      const hits = await search(base, '周报')
      expect(hits.length).toBe(2)
      expect(
        hits.map((hit) => {
          return hit.messageId
        }),
      ).toContain(hits[0]?.messageId)
      // 片段带命中上下文，不是整条正文
      expect(hits[0]?.snippet).toContain('周报')
    } finally {
      await server.close()
    }
  })

  it('路由返回的命中集合与存储层的索引查询是同一批', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '索引',
        memberAgentIds: ['ryen'],
      })
      for (const text of ['季度总结写好了', '季度总结第二版', '别的内容']) {
        server.store.appendMessage({
          conversationId: conversation.id,
          senderType: 'user',
          senderId: 'user',
          contentBlocks: [{ type: 'text', text }],
        })
      }

      const indexed = server.store.searchMessages('季度总结', { limit: 50 })
      const routed = await search(base, '季度总结')
      expect(
        routed
          .map((hit) => {
            return hit.messageId
          })
          .sort(),
      ).toEqual(
        indexed
          .map((hit) => {
            return hit.messageId
          })
          .sort(),
      )
    } finally {
      await server.close()
    }
  })

  it('搜索路径不再调用 listMessages（那正是全库扫描的入口）', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '扫描',
        memberAgentIds: ['ryen'],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '索引一次就够' }],
      })
      const spy = vi.spyOn(server.store, 'listMessages')
      await search(base, '索引')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('标题取界面态视图：改过名的会话在结果里显示改后的名字', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '旧名字',
        memberAgentIds: ['ryen'],
      })
      server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '带改名的一条消息' }],
      })
      const renamed = await fetch(`${base}/api/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '新名字' }),
      })
      expect(renamed.status).toBe(200)

      const hits = await search(base, '改名')
      expect(hits.length).toBe(1)
      expect(hits[0]?.conversationTitle).toBe('新名字')
    } finally {
      await server.close()
    }
  })

  it('限定 conversationId 时只在该会话里找', async () => {
    const { server, base } = await startServer()
    try {
      const first = server.store.createConversation({ kind: 'direct', title: '甲', memberAgentIds: ['ryen'] })
      const second = server.store.createConversation({ kind: 'direct', title: '乙', memberAgentIds: ['ryen'] })
      server.store.appendMessage({
        conversationId: first.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '只属于甲的关键词' }],
      })
      server.store.appendMessage({
        conversationId: second.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '只属于乙的关键词' }],
      })

      const hits = await search(base, '关键词', first.id)
      expect(hits.length).toBe(1)
      expect(hits[0]?.conversationId).toBe(first.id)
    } finally {
      await server.close()
    }
  })

  it('空查询直接回空数组（不查库）', async () => {
    const { server, base } = await startServer()
    try {
      const spy = vi.spyOn(server.store, 'searchMessages')
      const response = await fetch(`${base}/api/search?q=`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as { results: SearchHit[] }).results).toEqual([])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })
})
