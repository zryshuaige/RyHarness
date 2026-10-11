/**
 * M3 集成验证（不触网）：群聊调度三场景，mock LlmAdapter 脚本化回复。
 *
 *   pnpm demo:group
 *
 * 场景 a：无 @ 提问 → Ryen(调度员) @CodeBot → CodeBot @Reviewer → Reviewer 收尾。
 * 场景 b：用户直接 @Reviewer → 只有 Reviewer 响应。
 * 场景 c：Ryen@CodeBot、CodeBot@Ryen 互踢 → loop-guard 强制停止。
 *
 * 每个场景独立 Context + 临时 SQLite 库；断言事件流与落库内容。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@ryagent/cordis'
import LlmRuntime, { LlmAdapter } from '@ryagent/llm'
import type { AgentDefinition } from '@ryagent/agent'
import type { GenerateOptions, StreamChunk } from '@ryagent/llm'
import { SessionCoordinator, SessionStore } from '@ryagent/session'
import type { GroupEvent } from '@ryagent/group'

/** 按调用顺序消费脚本回复的假适配器。 */
class MockAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly replies: string[]) {
    super()
  }

  callsMade(): number {
    return this.calls
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Mock' }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.replies[this.calls++] ?? ''
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    return (async function* (): AsyncGenerator<StreamChunk> { yield* chunks })()
  }
}

function member(id: string, name: string, role: string): AgentDefinition {
  return {
    id, name,
    systemPrompt: `你是${name}，${role}。回复简短。`,
    provider: 'mock', model: 'mock', tools: [],
  }
}

interface ScenarioSetup {
  coordinator: SessionCoordinator
  conversationId: string
  store: SessionStore
  calls: () => number
}

async function setup(replies: string[]): Promise<ScenarioSetup> {
  const store = new SessionStore(':memory:')
  const ryen = member('ryen', 'Ryen', '群里的猫管家调度员')
  const codebot = member('codebot', 'CodeBot', '负责写代码')
  const reviewer = member('reviewer', 'Reviewer', '负责审查')
  for (const agent of [ryen, codebot, reviewer]) store.upsertAgent(agent)
  const conversation = store.createConversation({
    kind: 'group', title: 'M3 验证群', memberAgentIds: ['ryen', 'codebot', 'reviewer'], dispatcherAgentId: 'ryen',
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new MockAdapter(replies)
  ctx.llm.registerAdapter(['mock'], adapter)
  const coordinator = new SessionCoordinator({ store, llm: ctx.llm, tools: [] })
  return { coordinator, conversationId: conversation.id, store, calls: () => { return adapter.callsMade() } }
}

async function drain(events: AsyncGenerator<GroupEvent>): Promise<GroupEvent[]> {
  const out: GroupEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'ryagent-demo-group-'))

try {
  // ---- 场景 a：调度员接力链 ----
  {
    const { coordinator, conversationId, store, calls } = await setup([
      '收到，我来协调。@CodeBot 先写个实现草案',
      '@Reviewer 草案写好了，帮忙审查',
      '审查通过，收尾。',
    ])
    console.log('[demo-a] 用户无 @ 提问，期望 Ryen → CodeBot → Reviewer')
    const events = await drain(coordinator.chatGroup(conversationId, '这个需求怎么做？', { workspaceRoot: tmpRoot }))

    const dispatches = events.filter((e) => { return e.type === 'dispatch' })
    assert.deepEqual(
      dispatches.map((d) => { return d.type === 'dispatch' ? `${d.reason}->${d.toAgent}` : '' }),
      ['default-dispatcher->ryen', 'relay @CodeBot->codebot', 'relay @Reviewer->reviewer'],
    )
    assert.equal(events.at(-1)?.type, 'turn-done')
    assert.ok(calls() <= 8)
    const stored = store.listDispatchEvents(conversationId)
    assert.deepEqual(
      stored.map((e) => { return `${e.reason}->${e.toAgent}` }),
      ['default-dispatcher->ryen', 'relay @CodeBot->codebot', 'relay @Reviewer->reviewer'],
    )
    const messages = store.listMessages(conversationId)
    assert.deepEqual(messages.map((m) => { return `${m.senderType}:${m.senderId ?? '-'}` }), [
      'user:user', 'agent:ryen', 'agent:codebot', 'agent:reviewer',
    ])
    assert.equal(messages[0]!.turnIndex, 0)
    assert.equal(messages[3]!.turnIndex, 0)
    console.log('✓ 场景 a：dispatch_events 3 条、消息顺序 user→Ryen→CodeBot→Reviewer、接力 ≤ maxTurns')
    store.close()
  }

  // ---- 场景 b：用户直接 @Reviewer ----
  {
    const { coordinator, conversationId, store, calls } = await setup(['直接回答，不用转交。'])
    console.log('[demo-b] 用户直接 @Reviewer，期望只有 Reviewer 响应')
    const events = await drain(coordinator.chatGroup(conversationId, '@Reviewer 直接问你个事', { workspaceRoot: tmpRoot }))
    const dispatches = events.filter((e) => { return e.type === 'dispatch' })
    assert.deepEqual(
      dispatches.map((d) => { return d.type === 'dispatch' ? `${d.reason}->${d.toAgent}` : '' }),
      ['user-mention->reviewer'],
    )
    assert.equal(calls(), 1)
    const messages = store.listMessages(conversationId)
    assert.deepEqual(messages.map((m) => { return `${m.senderType}:${m.senderId ?? '-'}` }), ['user:user', 'agent:reviewer'])
    assert.deepEqual(messages[0]!.mentions, ['reviewer'])
    console.log('✓ 场景 b：仅 Reviewer 响应，mentions 落库')
    store.close()
  }

  // ---- 场景 c：A↔B 互踢，loop-guard ----
  {
    const { coordinator, conversationId, store, calls } = await setup([
      '@CodeBot 你来处理',
      '@Ryen 还是你来吧',
    ])
    console.log('[demo-c] 构造 Ryen↔CodeBot 互踢，期望 loop-guard 强制停止')
    const events = await drain(coordinator.chatGroup(conversationId, '这事谁做？', { workspaceRoot: tmpRoot }))
    const guard = events.filter((e) => { return e.type === 'dispatch' && e.reason === 'loop-guard' })
    assert.equal(guard.length, 1)
    assert.equal(calls(), 2) // 第三次调用被护栏拦下
    const stored = store.listDispatchEvents(conversationId)
    assert.ok(stored.some((e) => { return e.reason === 'loop-guard' }))
    const messages = store.listMessages(conversationId)
    // 用户 + Ryen + CodeBot；被拦下的 Ryen 二次发言不落库
    assert.deepEqual(messages.map((m) => { return `${m.senderType}:${m.senderId ?? '-'}` }), [
      'user:user', 'agent:ryen', 'agent:codebot',
    ])
    console.log('✓ 场景 c：loop-guard 落库（reason=loop-guard），无第三次发言')
    store.close()
  }

  console.log('\n[demo] 全部场景断言通过。')
} finally {
  rmSync(tmpRoot, { recursive: true, force: true })
}
