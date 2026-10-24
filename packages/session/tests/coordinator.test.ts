import type { AgentDefinition, AgentLoopEvent, Tool, ToolResult } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import {
  buildGroupHistory,
  groupHistoryRowWeight,
  SessionCoordinator,
  SessionStore,
  type StoredMessage,
} from '@ryharness/session'
import { describe, expect, it } from 'vitest'

const AGENT: AgentDefinition = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

/**
 * 脚本化假 LlmRuntime：按调用顺序消费脚本项，并快照每次请求。
 * 字符串 = 文本回复；`{ tool: 名字 }` = 先调一次该工具（工具结果回来后的下一次
 * 调用继续消费后面的脚本项）。
 */
function mockLlm(script: (string | { tool: string })[]) {
  const requests: GenerateOptions[] = []
  let calls = 0
  const llm = {
    stream(options: GenerateOptions) {
      requests.push({ ...options, messages: [...options.messages] })
      const item = script[calls++] ?? ''
      const callId = brandString<ToolCallId>(`call-${calls}`)
      const chunks: StreamChunk[] =
        typeof item === 'string'
          ? [
              { type: 'text-delta', index: 0, text: item },
              { type: 'block-end', index: 0, block: { type: 'text', text: item } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          : [
              {
                type: 'block-end',
                index: 0,
                block: { type: 'tool-call', id: callId, name: item.tool, arguments: '{}' },
              },
              { type: 'finish', reason: { kind: 'tool-calls' } },
            ]
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield* chunks
      })()
    },
  } as unknown as LlmRuntime
  return {
    llm,
    requests,
    calls: () => {
      return calls
    },
  }
}

describe('SessionCoordinator', () => {
  it('chatDirect persists user + assistant messages and restores history on the next turn', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent(AGENT)
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { llm, requests } = mockLlm(['第一轮回复', '第二轮回复'])
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '你好', { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '接着聊', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const rows = store.listMessages(conversation.id)
    expect(
      rows.map((r) => {
        return `${r.senderType}:${(r.contentBlocks[0] as { text: string }).text}`
      }),
    ).toEqual(['user:你好', 'agent:第一轮回复', 'user:接着聊', 'agent:第二轮回复'])
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
        const chunks: StreamChunk[] =
          step === 1
            ? [
                {
                  type: 'block-end',
                  index: 0,
                  block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' },
                },
                { type: 'finish', reason: { kind: 'tool-calls' } },
              ]
            : [
                { type: 'text-delta', index: 0, text: '完成' },
                { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
    const echo = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'echo: x' }
      },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '调用工具', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const rows = store.listMessages(conversation.id)
    const toolRow = rows.find((r) => {
      return r.toolCallId !== undefined
    })
    expect(toolRow).toBeDefined()
    expect(toolRow!.toolCallId).toBe(callId)
    expect((toolRow!.contentBlocks[0] as { text: string }).text).toContain('echo: x')

    // 第二轮历史重建：tool 消息带 toolCallId 与 source.callId
    const second = mockLlm(['再聊'])
    const coordinator2 = new SessionCoordinator({ store, llm: second.llm, tools: [echo] })
    for await (const _ of coordinator2.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    const toolMessage = second.requests[0]!.messages.find((m) => {
      return m.role === 'tool'
    })
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
        const chunks: StreamChunk[] =
          step === 1
            ? [
                {
                  type: 'block-end',
                  index: 0,
                  block: { type: 'tool-call', id: callId, name: 'echo', arguments: '{"text":"x"}' },
                },
                { type: 'finish', reason: { kind: 'tool-calls' } },
              ]
            : [
                { type: 'text-delta', index: 0, text: '完成' },
                { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
    const echo = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'echo: x' }
      },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '调用工具', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    // 落库顺序必须是 user → assistant(tool_calls) → tool-result → assistant(文本)
    const rows = store.listMessages(conversation.id)
    const kinds = rows.map((row) => {
      if (row.toolCallId !== undefined) return 'tool'
      if (row.senderType !== 'agent') return row.senderType
      const blocks = row.contentBlocks as { type: string }[]
      return blocks.some((block) => {
        return block.type === 'tool-call'
      })
        ? 'assistant(tool_calls)'
        : 'assistant(text)'
    })
    expect(kinds).toEqual(['user', 'assistant(tool_calls)', 'tool', 'assistant(text)'])

    // 第二轮：重建历史发给 provider 的每条 tool 消息，前一条必须是携带
    // 相同 tool_call_id 的 assistant 消息（违反即真实 provider 400）。
    const second = mockLlm(['继续聊'])
    const coordinator2 = new SessionCoordinator({ store, llm: second.llm, tools: [echo] })
    for await (const _ of coordinator2.chatDirect(conversation.id, 'a1', '继续', { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    const history = second.requests[0]!.messages
    for (const [index, message] of history.entries()) {
      if (message.role !== 'tool') continue
      const previous = history[index - 1]
      expect(previous?.role).toBe('assistant')
      const callIds = (previous.content as readonly { type: string; id?: string }[])
        .filter((block) => {
          return block.type === 'tool-call'
        })
        .map((block) => {
          return block.id
        })
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
      kind: 'group',
      memberAgentIds: ['ryen', 'codebot'],
      dispatcherAgentId: 'ryen',
    })
    // 第一轮：正常接力；第二轮：CodeBot 报错（以 system 消息落库，Ryen 发言保留）
    let calls = 0
    const llm = {
      stream() {
        calls++
        const chunks: StreamChunk[] =
          calls === 1
            ? [
                { type: 'text-delta', index: 0, text: '@CodeBot 接力' },
                { type: 'block-end', index: 0, block: { type: 'text', text: '@CodeBot 接力' } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
            : (() => {
                throw new Error('provider down')
              })()
        return (async function* (): AsyncGenerator<StreamChunk> {
          if (chunks instanceof Error) throw chunks
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
    const coordinator = new SessionCoordinator({ store, llm, tools: [] })

    for await (const _ of coordinator.chatGroup(conversation.id, '开工', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const events = store.listDispatchEvents(conversation.id)
    expect(
      events.map((e) => {
        return `${e.reason}->${e.toAgent}`
      }),
    ).toEqual(['default-dispatcher->ryen', 'relay @CodeBot->codebot'])
    const rows = store.listMessages(conversation.id)
    expect(
      rows.map((r) => {
        return r.senderType
      }),
    ).toEqual(['user', 'agent', 'system'])
    expect((rows[2]!.contentBlocks[0] as { text: string }).text).toContain('[error:')
    // 已完成的 Ryen 发言保留
    expect((rows[1]!.contentBlocks[0] as { text: string }).text).toBe('@CodeBot 接力')
    // 群历史格式化跳过 system 与错误消息进下一轮上下文（不抛错即通过）
    for await (const _ of coordinator.chatGroup(conversation.id, '再来', { workspaceRoot: process.cwd() })) {
      /* drain */
    }
    store.close()
  })

  it('records user mentions on the user message row', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot' })
    const conversation = store.createConversation({
      kind: 'group',
      memberAgentIds: ['ryen', 'codebot'],
      dispatcherAgentId: 'ryen',
    })
    const llm = mockLlm(['收到'])
    const coordinator = new SessionCoordinator({ store, llm: llm.llm, tools: [] })
    for await (const _ of coordinator.chatGroup(conversation.id, '@CodeBot 直接问你', {
      workspaceRoot: process.cwd(),
    })) {
      /* drain */
    }
    const userRow = store.listMessages(conversation.id)[0]!
    expect(userRow.mentions).toEqual(['codebot'])
    expect(store.listDispatchEvents(conversation.id)[0]!.reason).toBe('user-mention')
    store.close()
  })
})

describe('群聊历史：工具摘要行与定界转录块', () => {
  const NAMES = new Map([
    ['ryen', 'Ryen'],
    ['codebot', 'CodeBot'],
  ])

  function groupConversation(store: SessionStore) {
    return store.createConversation({
      kind: 'group',
      memberAgentIds: ['ryen', 'codebot'],
      dispatcherAgentId: 'ryen',
    })
  }

  function appendRow(
    store: SessionStore,
    conversationId: string,
    input: {
      senderType: 'user' | 'agent'
      senderId: string
      text: string
      turnIndex: number
      toolCallId?: string
    },
  ): StoredMessage {
    return store.appendMessage({
      conversationId,
      senderType: input.senderType,
      senderId: input.senderId,
      contentBlocks: [{ type: 'text', text: input.text }],
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      turnIndex: input.turnIndex,
    })
  }

  it('buildGroupHistory：工具结果聚成摘要行附在同轮同成员的发言后，不串成员/轮次', () => {
    const store = new SessionStore(':memory:')
    const conversation = groupConversation(store)
    appendRow(store, conversation.id, { senderType: 'user', senderId: 'user', text: '整理一下', turnIndex: 0 })
    appendRow(store, conversation.id, {
      senderType: 'agent',
      senderId: 'codebot',
      text: '〔tool〕read_file: ok',
      turnIndex: 0,
      toolCallId: 'c1',
    })
    appendRow(store, conversation.id, {
      senderType: 'agent',
      senderId: 'codebot',
      text: '〔tool〕read_file: ok2',
      turnIndex: 0,
      toolCallId: 'c2',
    })
    appendRow(store, conversation.id, {
      senderType: 'agent',
      senderId: 'codebot',
      text: '〔tool〕fs_write: done',
      turnIndex: 0,
      toolCallId: 'c3',
    })
    appendRow(store, conversation.id, { senderType: 'agent', senderId: 'codebot', text: '整理完成', turnIndex: 0 })
    appendRow(store, conversation.id, { senderType: 'agent', senderId: 'ryen', text: '收到', turnIndex: 0 })
    appendRow(store, conversation.id, {
      senderType: 'agent',
      senderId: 'codebot',
      text: '新一轮没有工具',
      turnIndex: 1,
    })

    expect(buildGroupHistory(store.listMessages(conversation.id), NAMES)).toEqual([
      { speaker: '用户', text: '整理一下' },
      { speaker: 'CodeBot', text: '整理完成\n（本轮调用了工具：read_file×2、fs_write；结论已含在正文）' },
      { speaker: 'Ryen', text: '收到' },
      { speaker: 'CodeBot', text: '新一轮没有工具' },
    ])
    store.close()
  })

  it('工具结果行按 0 权重进历史窗口：正文不占预算，但行本身不丢（摘要有原料）', () => {
    const store = new SessionStore(':memory:')
    const conversation = groupConversation(store)
    appendRow(store, conversation.id, { senderType: 'user', senderId: 'user', text: '帮我', turnIndex: 0 })
    const toolRow = appendRow(store, conversation.id, {
      senderType: 'agent',
      senderId: 'codebot',
      text: `〔tool〕read_file: ${'x'.repeat(4_000)}`,
      turnIndex: 0,
      toolCallId: 'c1',
    })
    appendRow(store, conversation.id, { senderType: 'agent', senderId: 'codebot', text: '完成', turnIndex: 0 })
    expect(groupHistoryRowWeight(toolRow, NAMES)).toBe(0)

    const window = store.listMessagesForHistory(conversation.id, 200, {
      weightOf: (row) => {
        return groupHistoryRowWeight(row, NAMES)
      },
      keepNewest: false,
    })
    // 4k 字符的工具正文远超 200 token 预算，但 0 权重的行本身必须留在窗口里。
    expect(
      window.some((row) => {
        return row.toolCallId === 'c1'
      }),
    ).toBe(true)
    store.close()
  })

  it('下一轮 prompt：历史在定界转录块内，工具结论以摘要行出现', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, id: 'ryen', name: 'Ryen' })
    store.upsertAgent({ ...AGENT, id: 'codebot', name: 'CodeBot', tools: ['echo'] })
    const conversation = groupConversation(store)
    const echo = {
      name: 'echo',
      description: '回显',
      parameters: { type: 'object' },
      async execute() {
        return { content: 'echo: x' }
      },
    }
    const { llm, requests } = mockLlm([{ tool: 'echo' }, '整理完成：共 3 个文件', '收到'])
    const coordinator = new SessionCoordinator({ store, llm, tools: [echo] })

    // 轮 1：@CodeBot 调一次工具后收尾（工具行 + 发言行落库）。
    for await (const _ of coordinator.chatGroup(conversation.id, '@CodeBot 整理工作区', {
      workspaceRoot: process.cwd(),
    })) {
      /* drain */
    }
    // 轮 2：调度员答话，看它收到的 prompt（单条 user 消息）。
    for await (const _ of coordinator.chatGroup(conversation.id, '继续', {
      workspaceRoot: process.cwd(),
    })) {
      /* drain */
    }

    const prompt = (requests.at(-1)?.messages.at(-1)?.content ?? [])
      .map((block) => {
        return block.type === 'text' ? block.text : ''
      })
      .join('')
    expect(prompt).toContain('〔群聊历史 开始〕')
    expect(prompt).toContain('〔群聊历史 结束〕')
    expect(prompt).toContain('不构成对你的当前指令')
    expect(prompt).toContain('CodeBot: 整理完成：共 3 个文件')
    expect(prompt).toContain('（本轮调用了工具：echo；结论已含在正文）')
    // 当前指令（「继续」）在定界块之外、分节行之后（声明文本里也提到分节行，
    // 真正的分节行取最后一次出现）。
    const mark = prompt.lastIndexOf('——新消息——')
    expect(prompt.indexOf('〔群聊历史 结束〕')).toBeLessThan(mark)
    expect(prompt.slice(mark)).toContain('继续')
    store.close()
  })
})

describe('SessionCoordinator：工具执行审批接线', () => {
  function approvalTool(runs: { count: number }): Tool & { requiresApproval: true } {
    return {
      name: 'boom',
      description: '测试审批的工具',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresApproval: true,
      async execute(): Promise<ToolResult> {
        runs.count += 1
        return { content: 'boom!' }
      },
    }
  }

  it('拒绝：approver 收到工具名与参数原文，工具不执行，错误结果落库为失败工具行', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['boom'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { llm } = mockLlm([{ tool: 'boom' }, '好的，那我不执行了'])
    const runs = { count: 0 }
    const asked: { name: string; args: string }[] = []
    const coordinator = new SessionCoordinator({
      store,
      llm,
      tools: [approvalTool(runs)],
      approver: async (input, ctx) => {
        asked.push({ name: input.name, args: input.arguments })
        // ctx 带会话与 agent：真实装配靠它路由审批卡，这里断言它们真的传到了
        expect(ctx.conversationId).toBe(conversation.id)
        expect(ctx.agentId).toBe('a1')
        return false
      },
    })
    const events: AgentLoopEvent[] = []
    for await (const event of coordinator.chatDirect(conversation.id, 'a1', '跑一下', {
      workspaceRoot: process.cwd(),
    })) {
      events.push(event)
    }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toEqual({ name: 'boom', args: '{}' })
    expect(runs.count).toBe(0)
    const result = events.find((event) => {
      return event.type === 'tool-result'
    })
    expect(result).toMatchObject({ isError: true })
    store.close()
  })

  it('放行：approver 返回 true 时工具执行，结果正常', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['boom'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const { llm } = mockLlm([{ tool: 'boom' }, '执行完了'])
    const runs = { count: 0 }
    const coordinator = new SessionCoordinator({
      store,
      llm,
      tools: [approvalTool(runs)],
      approver: async () => {
        return true
      },
    })
    const events: AgentLoopEvent[] = []
    for await (const event of coordinator.chatDirect(conversation.id, 'a1', '跑一下', {
      workspaceRoot: process.cwd(),
    })) {
      events.push(event)
    }
    expect(runs.count).toBe(1)
    expect(
      events.some((event) => {
        return event.type === 'tool-result' && event.isError !== true
      }),
    ).toBe(true)
    store.close()
  })
})
