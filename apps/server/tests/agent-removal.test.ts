/**
 * 删掉助理之后，那个会话还剩下什么。
 *
 * 删助理时 store 会把它从会话成员里摘掉：一个成员全没了的会话再发消息，协调器会在
 * `getAgent(undefined)` 上炸掉——用户看到的是一条看不懂的红色报错，而不是「这里已经
 * 没法聊了」。现在入口就说清楚。
 *
 * 历史照旧留着：那段对话本身是有价值的，只是没有对手了。
 * @module @ryharness/server/tests/agent-removal
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ryharness/cordis'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
const running: RyHarnessServer[] = []

class QuietAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: 'Quiet' }
  }

  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: '好' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '好' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function startServer(): Promise<RyHarnessServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-agent-removal-'))
  tmpDirs.push(dataDir)
  const server = await RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    mountLlm: (ctx: Context) => {
      ctx.llm.registerAdapter(['mock'], new QuietAdapter())
    },
  })
  running.push(server)
  return server
}

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop()
    await server?.close()
  }
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 句柄释放可能滞后；残留目录在临时区。
    }
  }
})

describe('删掉助理之后', () => {
  it('那个会话发不了消息，但说清楚了原因（不是一条看不懂的报错）', async () => {
    const server = await startServer()
    // 建一个自己的助理（内置的删不掉）。
    const created = await (
      await fetch(`${server.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'temp-agent',
          name: '临时助理',
          systemPrompt: 'p',
          provider: 'mock',
          model: 'mock',
        }),
      })
    ).json()
    const agentId = (created as { agent: { id: string } }).agent.id
    const conversation = server.store.createConversation({
      kind: 'direct',
      title: '临时助理',
      memberAgentIds: [agentId],
    })
    server.store.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '你好' }],
    })

    const deleted = await fetch(`${server.url}/api/agents/${agentId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)

    // 成员被摘光：发消息要得到一句人话，不是一句内部错误。
    const response = await fetch(`${server.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '在吗' }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('助理已经被删除')

    // 历史照旧能读：那段对话本身是有价值的。
    const history = await fetch(`${server.url}/api/conversations/${conversation.id}/messages?limit=10`)
    expect(history.status).toBe(200)
    const rows = (await history.json()) as { messages: { contentBlocks: { type: string; text?: string }[] }[] }
    expect(rows.messages).toHaveLength(1)
    expect(rows.messages[0]?.contentBlocks[0]?.text).toBe('你好')
  })
})
