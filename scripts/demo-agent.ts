/**
 * M2 集成验证（不触网）：mock LlmAdapter 录制两轮 StreamChunk
 * （第一轮发起 fs_write tool_call，第二轮文本收尾），跑 AgentLoop，
 * 断言事件序列、请求历史增长、工作区文件落盘、SQLite 持久化正确。
 *
 *   pnpm demo:agent
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLoopEvent } from '@ryagent/agent'
import { AgentLoop, forkTemplate, RYEN_TEMPLATE } from '@ryagent/agent'
import { brandString } from '@ryagent/brand'
import { Context } from '@ryagent/cordis'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@ryagent/llm'
import LlmRuntime, { LlmAdapter } from '@ryagent/llm'
import { SessionStore } from '@ryagent/session'
import { fsWrite } from '@ryagent/tools'

/** 录制两轮响应的假适配器：记录每次请求。 */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private call = 0

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 快照请求：history 数组是可变引用，循环会继续往里追加。
    this.requests.push({ ...options, messages: [...options.messages] })
    this.call++
    const callId = brandString<ToolCallId>('demo-call-1')
    const chunks: StreamChunk[] =
      this.call === 1
        ? [
            { type: 'block-start', index: 0, blockType: 'tool-call' },
            {
              type: 'tool-call-delta',
              index: 0,
              id: callId,
              name: 'fs_write',
              argumentsDelta: '{"path":"hello.md","content":"# 你好，RyAgent\\n"}',
            },
            {
              type: 'block-end',
              index: 0,
              block: {
                type: 'tool-call',
                id: callId,
                name: 'fs_write',
                arguments: '{"path":"hello.md","content":"# 你好，RyAgent\\n"}',
              },
            },
            { type: 'finish', reason: { kind: 'tool-calls' } },
          ]
        : [
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: '已经写好 hello.md。' },
            { type: 'block-end', index: 0, block: { type: 'text', text: '已经写好 hello.md。' } },
            { type: 'usage', usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49 } },
            { type: 'finish', reason: { kind: 'stop' } },
          ]
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield* chunks
    })()
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'ryagent-demo-'))
const workspaceRoot = join(tmp, 'workspace')
const store = new SessionStore(join(tmp, 'demo.db'))

try {
  // ---- 组装：cordis Context + LlmRuntime + mock 适配器 ----
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new MockAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  // ---- Agent 定义（fork Ryen 模板，收窄工具到 fs_write）----
  const definition = forkTemplate(RYEN_TEMPLATE, {
    name: 'DemoRyen',
    provider: 'mock',
    model: 'mock-model',
    tools: ['fs_write'],
  })
  store.upsertAgent({ ...definition, isBuiltin: false })

  const conversation = store.createConversation({
    kind: 'direct',
    title: 'M2 集成验证',
    memberAgentIds: [definition.id],
  })

  // ---- 跑 AgentLoop ----
  const loop = new AgentLoop({ definition, llm: ctx.llm, tools: [fsWrite] })
  const events: AgentLoopEvent[] = []
  let streamedText = ''
  for await (const event of loop.run({ text: '帮我写一个 hello.md' }, { workspaceRoot })) {
    events.push(event)
    if (event.type === 'text-delta') {
      process.stdout.write(event.text)
      streamedText += event.text
    } else {
      console.log(
        `\n[event] ${event.type}`,
        event.type === 'tool-result' ? `${event.name} isError=${event.isError}` : '',
      )
    }
  }

  // ---- 断言 1：事件序列 ----
  const kinds = events.map((e) => {
    return e.type
  })
  assert.deepEqual(kinds, ['tool-call-start', 'tool-result', 'text-delta', 'done'], `事件序列不符: ${kinds.join(',')}`)
  assert.equal((events[0] as { name: string }).name, 'fs_write')
  assert.equal((events[1] as { isError: boolean }).isError, false)
  assert.deepEqual((events[3] as { finish: unknown }).finish, { kind: 'stop' })
  console.log('✓ 事件序列正确（tool-call-start → tool-result → text-delta → done）')

  // ---- 断言 2：请求历史（第二步带上 assistant tool-call 与 tool 结果）----
  assert.equal(adapter.requests.length, 2)
  assert.equal(adapter.requests[0]!.tools?.length, 1)
  assert.equal(adapter.requests[1]!.messages.length, 3)
  console.log('✓ 第二步请求历史 = user + assistant(tool-call) + tool result（3 条）')

  // ---- 断言 3：工作区文件落盘 ----
  const produced = join(workspaceRoot, 'hello.md')
  assert.ok(existsSync(produced), 'hello.md 未写入工作区')
  assert.equal(readFileSync(produced, 'utf8'), '# 你好，RyAgent\n')
  console.log('✓ fs_write 工具结果已落盘到工作区')

  // ---- 持久化：消息落库 ----
  store.appendMessage({
    conversationId: conversation.id,
    senderType: 'user',
    senderId: 'user-demo',
    contentBlocks: [{ type: 'text', text: '帮我写一个 hello.md' }],
    turnIndex: 0,
  })
  const toolEvent = events[1] as Extract<AgentLoopEvent, { type: 'tool-result' }>
  store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: definition.id,
    contentBlocks: [{ type: 'text', text: toolEvent.result.content }],
    turnIndex: 0,
  })
  store.appendMessage({
    conversationId: conversation.id,
    senderType: 'agent',
    senderId: definition.id,
    contentBlocks: [{ type: 'text', text: streamedText }],
    turnIndex: 0,
  })

  const storedAgent = store.getAgent(definition.id)
  assert.ok(storedAgent, 'agent 未落库')
  assert.equal(storedAgent.name, 'DemoRyen')
  assert.deepEqual(storedAgent.tools, ['fs_write'])
  const messages = store.listMessages(conversation.id)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]!.senderType, 'user')
  assert.equal(
    messages[2]!.contentBlocks[0] && (messages[2]!.contentBlocks[0] as { text: string }).text,
    '已经写好 hello.md。',
  )
  assert.ok(store.getConversation(conversation.id)!.updatedAt >= conversation.createdAt)
  console.log('✓ SQLite 持久化正确：agents 1 条、conversations 1 条、messages 3 条')

  console.log('\n[demo] 全部断言通过。')
} finally {
  store.close()
  rmSync(tmp, { recursive: true, force: true })
}
