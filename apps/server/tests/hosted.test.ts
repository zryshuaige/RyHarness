import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AbortedError } from '@ryharness/agent'
import { SessionStore } from '@ryharness/session'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalBroker } from '../src/approvals.ts'
import { EventHub } from '../src/bus.ts'
import type { HostedUserEvent } from '../src/hosted/client.ts'
import { type HostedClientLike, HostedRuntime } from '../src/hosted/service.ts'
import { parseSse } from '../src/hosted/sse.ts'
import type { HostedArtifact, KhaEvent } from '../src/hosted/types.ts'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ryharness-hosted-'))
  cleanups.push(root)
  return join(root, 'workspace')
}

function seededStore(): { store: SessionStore; conversationId: string; agentId: string } {
  const store = new SessionStore(':memory:')
  const agent = store.upsertAgent({
    id: 'cloud-1',
    name: '云同事',
    systemPrompt: '你在云端工作。',
    provider: 'kimi-hosted',
    model: 'kimi-k3.1-pro',
    tools: [],
    runtime: 'hosted',
  })
  store.upsertHostedMember({
    agentId: agent.id,
    remoteAgentId: 'agent_remote',
    environmentId: 'env_remote',
    scope: 'custom',
    status: 'active',
  })
  const conversation = store.createConversation({ kind: 'direct', memberAgentIds: [agent.id] })
  return { store, conversationId: conversation.id, agentId: agent.id }
}

function frame(id: string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function fakeClient(
  events: KhaEvent[],
  options: { artifacts?: HostedArtifact[]; hangUntilAbort?: boolean } = {},
): HostedClientLike & { sent: HostedUserEvent[][] } {
  const sent: HostedUserEvent[][] = []
  const artifacts = options.artifacts ?? []
  return {
    sent,
    async createSession() {
      return { id: 'sesn_test', status: 'idle' }
    },
    async getSession(id) {
      return { id, status: 'idle' }
    },
    async *streamEvents(_sessionId, streamOptions) {
      yield { event: 'control', id: '0', data: '{"cursor":"0"}' }
      for (let index = 0; index < events.length; index++) {
        const event = events[index] as KhaEvent
        yield { id: String(index + 1), event: event.type, data: JSON.stringify(event) }
      }
      if (options.hangUntilAbort === true) {
        await new Promise<void>((_resolve, reject) => {
          const signal = streamOptions.signal
          const fail = (): void => {
            reject(new DOMException('aborted', 'AbortError'))
          }
          if (signal === undefined) return
          if (signal.aborted) {
            fail()
            return
          }
          signal.addEventListener('abort', fail, { once: true })
        })
      }
    },
    async sendEvents(_sessionId, batch) {
      sent.push(batch)
    },
    async listEvents() {
      return { items: events }
    },
    async listArtifacts() {
      return artifacts
    },
    async downloadArtifact() {
      return new Uint8Array([1, 2, 3])
    },
    async archiveAgent() {},
    async updateAgent() {
      return { id: 'agent_remote', name: '云同事', scope: 'custom', version: '2' }
    },
  }
}

function kha(id: string, type: string, data: Record<string, unknown>): KhaEvent {
  return { id, type, processed_at: `2026-01-01T00:00:0${id.length}Z`, data }
}

function runtimeFor(store: SessionStore, client: HostedClientLike): HostedRuntime {
  return new HostedRuntime({
    store,
    workspaceRoot: tempWorkspace(),
    approvals: new ApprovalBroker(new EventHub()),
    clientProvider: () => client,
  })
}

describe('SSE 解析', () => {
  it('按空行收帧、忽略心跳注释，并把 id/event/data 交出来', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `: hb\r\n\r\n${frame('7', 'agent.message', { id: 'sevt_1', type: 'agent.message' })}`,
          ),
        )
        controller.close()
      },
    })
    const frames = []
    for await (const parsed of parseSse(body)) frames.push(parsed)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.id).toBe('7')
    expect(frames[0]?.event).toBe('agent.message')
    expect(JSON.parse(frames[0]?.data ?? '{}')).toMatchObject({ id: 'sevt_1' })
  })
})

describe('云成员的轮次', () => {
  it('把云端发言、工具结果与产物翻成本地事件，并镜像落库', async () => {
    const { store, conversationId, agentId } = seededStore()
    const client = fakeClient(
      [
        kha('1', 'session.status', { status: 'running' }),
        kha('2', 'agent.delta', { kind: 'text', delta: '正在' }),
        kha('3', 'agent.message', { content: [{ type: 'text', text: '正在整理资料。' }] }),
        kha('4', 'agent.tool_use', {
          tool_use: { id: 'call_1', name: 'shell', input: { command: 'ls' } },
          evaluated_permission: 'always_allow',
        }),
        kha('5', 'agent.tool_result', {
          tool_result: { id: 'call_1', name: 'shell', content: [{ type: 'text', text: 'a.txt' }] },
        }),
        kha('6', 'session.status', { status: 'idle', stop_reason: { type: 'end_turn' } }),
      ],
      { artifacts: [{ id: 'arti_1', name: '报告.pdf', size: 3, mime: 'application/pdf' }] },
    )
    const runtime = runtimeFor(store, client)
    const collected = []
    for await (const event of runtime.chat({
      conversationId,
      agentId,
      text: '做个报告',
      turnIndex: 1,
      persist: true,
    })) {
      collected.push(event)
    }

    // 先发 user.message，再收事件。
    expect(client.sent[0]?.[0]?.type).toBe('user.message')
    expect(collected.some((event) => event.type === 'text-delta')).toBe(true)
    expect(collected.some((event) => event.type === 'tool-result')).toBe(true)
    expect(collected.some((event) => event.type === 'done')).toBe(true)

    const messages = store.listMessages(conversationId, { limit: 50 })
    expect(
      messages.some((message) => {
        return message.senderType === 'agent' && JSON.stringify(message.contentBlocks).includes('正在整理资料')
      }),
    ).toBe(true)
    expect(
      messages.some((message) => {
        return message.toolCallId === 'call_1'
      }),
    ).toBe(true)
    expect(
      messages.some((message) => {
        return message.artifacts?.some((artifact) => artifact.name === '报告.pdf') === true
      }),
    ).toBe(true)
    const session = store.getHostedSession(conversationId, agentId)
    expect(session?.status).toBe('idle')
    expect(session?.cursor).toBe('6')
    expect(session?.lastEventId).toBe('6')
    store.close()
  })

  it('取消时发 user.interrupt，并以 AbortedError 收尾', async () => {
    const { store, conversationId, agentId } = seededStore()
    const client = fakeClient(
      [kha('1', 'session.status', { status: 'running' }), kha('2', 'agent.delta', { kind: 'text', delta: '写一半' })],
      { hangUntilAbort: true },
    )
    const runtime = runtimeFor(store, client)
    const controller = new AbortController()
    const iterator = runtime.chat({
      conversationId,
      agentId,
      text: '写个长报告',
      turnIndex: 1,
      persist: true,
      signal: controller.signal,
    })
    // chat 内部会先消化 control / running 帧，第一次 yield 出来的就是文本增量。
    const first = await iterator.next()
    expect(first.value?.type).toBe('text-delta')
    controller.abort()
    await expect(iterator.next()).rejects.toBeInstanceOf(AbortedError)
    expect(
      client.sent.some((batch) => {
        return batch[0]?.type === 'user.interrupt'
      }),
    ).toBe(true)
    expect(store.getHostedSession(conversationId, agentId)?.status).toBe('idle')
    store.close()
  })

  it('自定义工具回执后云端继续：requires_action 不是结束，end_turn 才是', async () => {
    const { store, conversationId, agentId } = seededStore()
    const client = fakeClient([
      kha('1', 'agent.custom_tool_use', { name: 'local_lookup', input: { q: '订单' } }),
      kha('2', 'session.status', { status: 'idle', stop_reason: { type: 'requires_action', event_ids: ['1'] } }),
      kha('3', 'agent.message', { content: [{ type: 'text', text: '查到了，订单已发货。' }] }),
      kha('4', 'session.status', { status: 'idle', stop_reason: { type: 'end_turn' } }),
    ])
    const runtime = runtimeFor(store, client)
    const collected = []
    for await (const event of runtime.chat({
      conversationId,
      agentId,
      text: '查订单',
      turnIndex: 1,
      persist: true,
    })) {
      collected.push(event)
    }
    // 自定义工具被明确回了一个失败结果（本客户端不执行本地工具），而不是静默挂死。
    const toolResult = client.sent.flat().find((event) => {
      return event.type === 'user.custom_tool_result'
    })
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'user.custom_tool_result') {
      expect(toolResult.data.is_error).toBe(true)
      expect(toolResult.data.event_id).toBe('1')
    }
    // requires_action 之后的发言仍然被收到，整轮以 done 收口。
    expect(
      collected.some((event) => {
        return event.type === 'text-delta' && event.text.includes('查到了')
      }),
    ).toBe(true)
    expect(collected.some((event) => event.type === 'done')).toBe(true)
    store.close()
  })

  it('产物落到工作区的 .ryharness-artifacts 下，重跑不重复下载', async () => {
    const { store, conversationId, agentId } = seededStore()
    const workspaceRoot = tempWorkspace()
    const client = fakeClient([kha('1', 'session.status', { status: 'idle', stop_reason: { type: 'end_turn' } })], {
      artifacts: [{ id: 'arti_9', name: '数据.csv', size: 3, mime: 'text/csv' }],
    })
    const runtime = new HostedRuntime({
      store,
      workspaceRoot,
      approvals: new ApprovalBroker(new EventHub()),
      clientProvider: () => client,
    })
    for await (const _event of runtime.chat({
      conversationId,
      agentId,
      text: '导出',
      turnIndex: 1,
      persist: true,
    })) {
      // 只关心副作用。
    }
    expect(existsSync(join(workspaceRoot, '.ryharness-artifacts', 'arti_9--数据.csv'))).toBe(true)
    store.close()
  })
})
