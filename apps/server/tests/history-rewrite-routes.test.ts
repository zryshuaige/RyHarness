/**
 * 历史改写的三个端点：编辑并重发 / 重新生成 / 从此处分支。
 *
 * 三个动作改的是同一份历史，各自的不变量：
 *
 * - **编辑并重发**：用户那句话**原地改写**（seq 与 id 都不变），它之后的一切被
 *   删掉，然后用新正文重跑。库里**不能**多出一条重复的用户消息。
 * - **重新生成**：被换掉的只有那条 agent 回复与它之后的一切；**用户那句话的
 *   seq 与 id 都不变**（界面上"我刚说的话"不会动）。
 * - **从此处分支**：复制出一个**独立**的新会话——改一边不影响另一边。
 *
 * @module @ryharness/server/tests/history-rewrite-routes
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

/** 每次都回同一句的 mock 适配器：重跑几轮都拿得到回复。 */
class FixedAdapter extends LlmAdapter {
  constructor(private readonly reply: string) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: this.reply },
      { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

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

async function startServer(reply = '这是回复'): Promise<{ server: RyHarnessServer; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-rewrite-test-'))
  tmpDirs.push(dataDir)
  const adapter = new FixedAdapter(reply)
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
  return { server, base: server.url }
}

async function postJson(base: string, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as unknown }
}

/** 等到条件成立（轮次是异步跑的，202 只表示"排进队列了"）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error('等待条件超时')
}

/** 一个配好 mock 供应商、有一条用户消息与一条 agent 消息的单聊。 */
async function seedConversation(
  server: RyHarnessServer,
  base: string,
): Promise<{ conversationId: string; userSeq: number; agentSeq: number }> {
  await fetch(`${base}/api/agents/ryen`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock', model: 'mock' }),
  })
  const conversation = server.store.createConversation({ kind: 'direct', title: '改写测试', memberAgentIds: ['ryen'] })
  const user = server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    senderId: 'user',
    contentBlocks: [{ type: 'text', text: '第一句' }],
  })
  const agent = server.store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: 'ryen',
    contentBlocks: [{ type: 'text', text: '第一句的回复' }],
  })
  return { conversationId: conversation.id, userSeq: user.seq, agentSeq: agent.seq }
}

describe('编辑并重发', () => {
  it('用户那句话原地改写，其后的一切被删掉并重跑', async () => {
    const { server, base } = await startServer('改写后的回复')
    try {
      const { conversationId, userSeq, agentSeq } = await seedConversation(server, base)
      const before = server.store.getMessage(conversationId, userSeq)

      const edited = await postJson(base, `/api/conversations/${conversationId}/messages/${userSeq}/edit`, {
        text: '改过的第二句',
      })
      expect(edited.status).toBe(202)

      await waitFor(() => {
        return server.store.listMessages(conversationId).some((message) => {
          return (
            message.senderType === 'agent' &&
            message.contentBlocks.some((block) => {
              return (block as { text?: string }).text === '改写后的回复'
            })
          )
        })
      })

      const messages = server.store.listMessages(conversationId)
      // 用户那句话：seq 与 id 都没变，正文换了。
      const user = server.store.getMessage(conversationId, userSeq)
      expect(user?.id).toBe(before?.id)
      expect(user?.contentBlocks).toEqual([{ type: 'text', text: '改过的第二句' }])
      // 旧回复被删掉了。
      expect(server.store.getMessage(conversationId, agentSeq)).toBeUndefined()
      // 库里不能多出一条重复的用户消息。
      expect(
        messages.filter((message) => {
          return message.senderType === 'user'
        }),
      ).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('agent 的消息改不了', async () => {
    const { server, base } = await startServer()
    try {
      const { conversationId, agentSeq } = await seedConversation(server, base)
      const edited = await postJson(base, `/api/conversations/${conversationId}/messages/${agentSeq}/edit`, {
        text: '我替它说',
      })
      expect(edited.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('会话里没有这条消息 → 404', async () => {
    const { server, base } = await startServer()
    try {
      const { conversationId } = await seedConversation(server, base)
      const edited = await postJson(base, `/api/conversations/${conversationId}/messages/9999/edit`, { text: 'x' })
      expect(edited.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('重新生成', () => {
  it('换掉那条回复，用户那句话的 seq 与 id 都不变', async () => {
    const { server, base } = await startServer('重新生成的回复')
    try {
      const { conversationId, userSeq, agentSeq } = await seedConversation(server, base)
      const before = server.store.getMessage(conversationId, userSeq)

      const regenerated = await postJson(
        base,
        `/api/conversations/${conversationId}/messages/${agentSeq}/regenerate`,
        {},
      )
      expect(regenerated.status).toBe(202)

      await waitFor(() => {
        return server.store.listMessages(conversationId).some((message) => {
          return message.contentBlocks.some((block) => {
            return (block as { text?: string }).text === '重新生成的回复'
          })
        })
      })

      const after = server.store.getMessage(conversationId, userSeq)
      expect(after?.id).toBe(before?.id)
      expect(after?.seq).toBe(before?.seq)
      expect(after?.contentBlocks).toEqual([{ type: 'text', text: '第一句' }])
      // 旧回复被换掉了。
      expect(server.store.getMessage(conversationId, agentSeq)).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('用户消息不能重新生成', async () => {
    const { server, base } = await startServer()
    try {
      const { conversationId, userSeq } = await seedConversation(server, base)
      const regenerated = await postJson(
        base,
        `/api/conversations/${conversationId}/messages/${userSeq}/regenerate`,
        {},
      )
      expect(regenerated.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('没有前置的用户消息 → 400（那一轮不是用户问出来的）', async () => {
    const { server, base } = await startServer()
    try {
      const conversation = server.store.createConversation({ kind: 'direct', title: 'x', memberAgentIds: ['ryen'] })
      const agent = server.store.appendMessage({
        conversationId: conversation.id,
        senderType: 'agent',
        senderId: 'ryen',
        contentBlocks: [{ type: 'text', text: '没人问，我自己说的' }],
      })
      const regenerated = await postJson(
        base,
        `/api/conversations/${conversation.id}/messages/${agent.seq}/regenerate`,
        {},
      )
      expect(regenerated.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})

describe('从此处分支', () => {
  it('复制出一个独立的新会话，改一边不影响另一边', async () => {
    const { server, base } = await startServer()
    try {
      const { conversationId, userSeq } = await seedConversation(server, base)
      server.store.appendMessage({
        conversationId,
        senderType: 'agent',
        senderId: 'ryen',
        contentBlocks: [{ type: 'text', text: '分支点之后的回复' }],
      })

      const branched = await postJson(base, `/api/conversations/${conversationId}/branch`, { atSeq: userSeq })
      expect(branched.status).toBe(201)
      const created = (branched.body as { conversation: { id: string; title: string } }).conversation
      expect(created.title).toContain('分支')

      // 分支出去的那份与分支点之前一致。
      const copied = server.store.listMessages(created.id)
      expect(copied).toHaveLength(1)
      expect(copied[0]?.contentBlocks).toEqual([{ type: 'text', text: '第一句' }])
      // 源会话原封不动（seed 造了两条，再加一条分支点之后的回复 = 3 条）。
      expect(server.store.listMessages(conversationId)).toHaveLength(3)

      // 改分支不影响源。
      server.store.appendMessage({
        conversationId: created.id,
        senderType: 'user',
        senderId: 'user',
        contentBlocks: [{ type: 'text', text: '分支这边新说的' }],
      })
      expect(server.store.listMessages(conversationId)).toHaveLength(3)
    } finally {
      await server.close()
    }
  })

  it('atSeq 缺失或指向不存在的消息 → 400 / 404', async () => {
    const { server, base } = await startServer()
    try {
      const { conversationId, userSeq } = await seedConversation(server, base)
      const missing = await postJson(base, `/api/conversations/${conversationId}/branch`, {})
      expect(missing.status).toBe(400)
      const absent = await postJson(base, `/api/conversations/${conversationId}/branch`, { atSeq: 9999 })
      expect(absent.status).toBe(404)
      expect(userSeq).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })
})
