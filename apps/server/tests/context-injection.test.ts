/**
 * 上下文装配进对话：项目指令文件、当前时间、用户 @到的文件。
 *
 * 用例走真实 HTTP 与真实装配：断言的是「模型**真的收到**了这些内容」——
 * 假适配器把每次请求的系统提示与消息都记下来，装配没接上的话这里就看不到。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@ryharness/llm'
import { LlmAdapter } from '@ryharness/llm'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ryharness-context-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

/** 记录每次请求的消息内容，回复固定一句。 */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = '收到。'
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

/** 一次请求里所有消息的正文拼起来（装配进来的内容都在这里）。 */
function allText(options: GenerateOptions): string {
  return options.messages
    .flatMap((message) => {
      return message.content
    })
    .map((block) => {
      return block.type === 'text' ? block.text : ''
    })
    .join('\n')
}

async function startServer(dataDir: string, adapter: RecordingAdapter): Promise<RyHarnessServer> {
  return RyHarnessServer.create({
    port: 0,
    dataDir,
    memory: null,
    evolution: null,
    proactive: false,
    mountLlm: (ctx) => {
      ctx.llm.registerAdapter(['mock'], adapter)
    },
  })
}

describe('上下文装配进对话', () => {
  it('工作区里的指令文件会进模型的消息里', async () => {
    const dataDir = tempDir()
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      // 指令文件放在工作区根（工具的工作区是 <dataDir>/workspace）。
      const workspace = join(dataDir, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'AGENTS.md'), '这个项目的规矩：回答一律用中文。', 'utf8')
      server.store.upsertAgent({
        id: 'a1',
        name: '助理',
        systemPrompt: '你是助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: [],
      })
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '上下文',
        memberAgentIds: ['a1'],
      })
      const response = await fetch(`${server.url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      })
      expect(response.status).toBe(202)
      // 等这一轮真的发出请求。
      const deadline = Date.now() + 8000
      while (adapter.requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
      }
      expect(adapter.requests.length).toBeGreaterThan(0)
      const text = allText(adapter.requests[0] as GenerateOptions)
      expect(text).toContain('这个项目的规矩')
      expect(text).toContain('当前时间')
    } finally {
      await server.close()
    }
  })

  it('用户 @到的文件内容会进模型的消息里', async () => {
    const dataDir = tempDir()
    const adapter = new RecordingAdapter()
    const server = await startServer(dataDir, adapter)
    try {
      const workspace = join(dataDir, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'note.md'), '这是被 @ 到的文件内容。', 'utf8')
      server.store.upsertAgent({
        id: 'a1',
        name: '助理',
        systemPrompt: '你是助理。',
        provider: 'mock',
        model: 'mock-model',
        tools: [],
      })
      const conversation = server.store.createConversation({
        kind: 'direct',
        title: '引用',
        memberAgentIds: ['a1'],
      })
      const response = await fetch(`${server.url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '看下 @note.md' }),
      })
      expect(response.status).toBe(202)
      const deadline = Date.now() + 8000
      while (adapter.requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
      }
      const text = allText(adapter.requests[0] as GenerateOptions)
      expect(text).toContain('这是被 @ 到的文件内容')
    } finally {
      await server.close()
    }
  })
})
