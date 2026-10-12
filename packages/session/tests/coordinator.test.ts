import { describe, expect, it } from 'vitest'
import { brandString } from '@ryagent/brand'
import type { AgentDefinition } from '@ryagent/agent'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryagent/llm'
import { SessionCoordinator, SessionStore } from '@ryagent/session'

const AGENT: AgentDefinition = {
  id: 'a1', name: 'Ryen', systemPrompt: '你是测试 agent。',
  provider: 'mock', model: 'mock-model', tools: [],
}

/** 脚本化假 LlmRuntime：按调用顺序消费文本，并快照每次请求。 */
function mockLlm(replies: string[]) {
  const requests: GenerateOptions[] = []
  let calls = 0
  const llm = {
    stream(options: GenerateOptions) {
      requests.push({ ...options, messages: [...options.messages] })
      const text = replies[calls++] ?? ''
      const chunks: StreamChunk[] = [
        { type: 'text-delta', index: 0, text },
        { type: 'block-end', index: 0, block: { type: 'text', text } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* (): AsyncGenerator<StreamChunk> { yield* chunks })()
    },
  } as unknown as LlmRuntime
  return { llm, requests, calls: () => { return calls } }
}

describe('SessionCoordinator', () => {
  it('chatDirect persists user + assistant messages and restores history on the next turn', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { llm, requests } = mockLlm(['第一轮回复', '第二轮回复'])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '你好', { workspaceRoot: process.cwd() })) { /* drain */ }
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '接着聊', { workspaceRoot: process.cwd() })) { /* drain */ }

    const rows = store.listMessages(conversation.id)
    expect(rows.map((r) => { return `${r.senderType}:${(r.contentBlocks[0] as { text: string }).text}` })).toEqual([
      'user:你好',
      'agent:第一轮回复',
      'user:接着聊',
      'agent:第二轮回复',
    ])
    // 第二轮请求的历史 = 恢复的前一轮（user + assistant）+ 本轮新输入，共 3 条
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.length).toBe(3)
    expect(requests[1]!.messages[0]!.role).toBe('user')
    expect(requests[1]!.messages[1]!.role).toBe('assistant')
    store.close()
  })

  it('persists tool results with toolCallId and rebuilds tool messages in history', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['echo'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const callId = brandString<ToolCallId>('call-t1')
    const llm = {
      stream(options: GenerateOptions) {
        const step = options.messages.length > 1 ? 2 : 1
        const chunks: StreamChunk[] = step === 1
          ? [
              { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
          : [
              { type: 'text-delta', index: 0, text: '完成' },
              { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
        return (async function* (): AsyncGenerator<StreamChunk> { yield* chunks })()
      },
    } as unknown as LlmRuntime
    const echo = {
      name: 'echo', description: '回显', parameters: { type: 'object' },
      async execute() { return { content: 'echo: x' } },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '调用工具', { workspaceRoot: process.cwd() })) { /* drain */ }

    const rows = store.listMessages(conversation.id)
    const toolRow = rows.find((r) => { return r.toolCallId !== undefined })
    expect(toolRow).toBeDefined()
    expect(toolRow!.toolCallId).toBe(callId)
    expect((toolRow!.contentBlocks[0] as { text: string }).text).toContain('echo: x')

    // 第二轮历史重建：tool 消息带 toolCallId 与 source.callId
    const second = mockLlm(['再聊'])
    const coordinator2 = new SessionCoordinator({ store, llm: second.llm, tools: [echo] })
    for await (const _ of coordinator2.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) { /* drain */ }
    const toolMessage = second.requests[0]!.messages.find((m) => { return m.role === 'tool' })
    expect(toolMessage).toBeDefined()
    expect((toolMessage as { toolCallId: string }).toolCallId).toBe(callId)
    store.close()
  })

  it('工具轮后重建历史满足 OpenAI 序列契约：每条 tool 消息前必有对应 tool_calls 的 assistant 消息', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['echo'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const callId = brandString<ToolCallId>('call-contract')
    const llm = {
      stream(options: GenerateOptions) {
        const step = options.messages.length > 1 ? 2 : 1
        const chunks: StreamChunk[] = step === 1
          ? [
              { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' } },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
          : [
              { type: 'text-delta', index: 0, text: '完成' },
              { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
        return (async function* (): AsyncGenerator<StreamChunk> { yield* chunks })()
      },
    } as unknown as LlmRuntime
    const echo = {
      name: 'echo', description: '回显', parameters: { type: 'object' },
      async execute() { return { content: 'echo: x' } },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '调用工具', { workspaceRoot: process.cwd() })) { /* drain */ }

    // 落库顺序必须是 user → assistant(tool_calls) → tool-result → assistant(文本)
    const rows = store.listMessages(conversation.id)
    const kinds = rows.map((row) => {
      if (row.toolCallId !== undefined) return 'tool'
      if (row.senderType !== 'agent') return row.senderType
      const blocks = row.contentBlocks as { type: string }[]
      return blocks.some((block) => { return block.type === 'tool-call' }) ? 'assistant(tool_calls)' : 'assistant(text)'
    })
    expect(kinds).toEqual(['user', 'assistant(tool_calls)', 'tool', 'assistant(text)'])

    // 第二轮：重建历史发给 provider 的每条 tool 消息，前一条必须是携带
    // 相同 tool_call_id 的 assistant 消息（违反即真实 provider 400）。
    const second = mockLlm(['继续聊'])
    const coordinator2 = new SessionCoordinator({ store, llm: second.llm, tools: [echo] })
    for await (const _ of coordinator2.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) { /* drain */ }
    const history = second.requests[0]!.messages
    for (const [index, message] of history.entries()) {
      if (message.role !== 'tool') continue
      const previous = history[index - 1]
      expect(previous?.role).toBe('assistant')
      const callIds = (previous.content as readonly { type: string; id?: string }[])
        .filter((block) => { return block.type === 'tool-call' })
        .map((block) => { return block.id })
      expect(callIds).toContain(message.toolCallId)
    }
    store.close()
  })

  it('chatGroup persists dispatch events and per-agent messages; LLM errors land as system messages', async () => {
    const store = new SessionStore(':memory:')
    const ryen: AgentDefinition = { ...AGENT, id: 'ryen', name: 'Ryen' }
    const codebot: AgentDefinition = { ...AGENT, id: 'codebot', name: 'CodeBot' }
    store.upsertAgent(ryen)
    store.upsertAgent(codebot)
    const conversation = store.createConversation({
      kind: 'group', memberAgentIds: ['ryen', 'codebot'], dispatcherAgentId: 'ryen',
    })
    // 第一轮：正常接力；第二轮：CodeBot 报错（以 system 消息落库，Ryen 发言保留）
    let calls = 0
    const llm = {
      stream() {
        calls++
        const chunks: StreamChunk[] = calls === 1
          ? [
              { type: 'text-delta', index: 0, text: '@CodeBot 接力' },
              { type: 'block-end', index: 0, block: { type: 'text', text: '@CodeBot 接力' } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          : (() => { throw new Error('provider down') })()
        return (async function* (): AsyncGenerator<StreamChunk> {
          if (chunks instanceof Error) throw chunks
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    for await (const _ of coordinator.chatGroup(conversation.id, '开工', { workspaceRoot: process.cwd() })) { /* drain */ }

    const events = store.listDispatchEvents(conversation.id)
    expect(events.map((e) => { return `${e.reason}->${e.toAgent}` }))
      .toEqual(['default-dispatcher->ryen', 'relay @CodeBot->codebot'])
    const rows = store.listMessages(conversation.id)
    expect(rows.map((r) => { return r.senderType })).toEqual(['user', 'agent', 'system'])
    expect((rows[2]!.contentBlocks[0] as { text: string }).text).toContain('[error:')
    // 已完成的 Ryen 发言保留
    expect((rows[1]!.contentBlocks[0] as { text: string }).text).toBe('@CodeBot 接力')
    // 群历史格式化跳过 system 与错误消息进下一轮上下文（不抛错即通过）
    for await (const _ of coordinator.chatGroup(conversation.id, '再来', { workspaceRoot: process.cwd() })) { /* drain */ }
    store.close()
  })

  it('records user mentions on the user message row', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
    const conversation = store.createConversation({
      kind: 'group', memberAgentIds: ['ryen', 'codebot'], dispatcherAgentId: 'ryen',
    })
    const llm = mockLlm(['收到'])
    const coordinator = new SessionCoordinator({ store, llm: llm.llm, tools: [] })
    for await (const _ of coordinator.chatGroup(conversation.id, '@CodeBot 直接问你', { workspaceRoot: process.cwd() })) { /* drain */ }
    const userRow = store.listMessages(conversation.id)[0]!
    expect(userRow.mentions).toEqual(['codebot'])
    expect(store.listDispatchEvents(conversation.id)[0]!.reason).toBe('user-mention')
    store.close()
  })
})
