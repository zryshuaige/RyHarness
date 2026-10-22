import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentDefinition } from '@ryharness/agent'
import { brandString } from '@ryharness/brand'
import type { GenerateOptions, LlmRuntime, StreamChunk, ToolCallId } from '@ryharness/llm'
import { migrate, SCHEMA_VERSION, SessionCoordinator, SessionStore } from '@ryharness/session'
import { describe, expect, it, vi } from 'vitest'

const AGENT: AgentDefinition = {
  id: 'a1',
  name: 'Ryen',
  systemPrompt: '你是测试 agent。',
  provider: 'mock',
  model: 'mock-model',
  tools: [],
}

describe('messages.artifacts_json（产物落库）', () => {
  it('迁移 v7：messages 新增可空列 artifacts_json，且 ALTER 幂等（重放不报错）', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    const columns = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((column) => {
      return column.name
    })
    expect(columns).toContain('artifacts_json')
    // 断言「artifacts_json 那次迁移已经发生」，而不是钉死版本号：后面每加一列
    // 都会推高 SCHEMA_VERSION，钉死 7 只会让下一次迁移又把这条测试变红。
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
    // 幂等一：user_version 已到位时 migrate 整体短路。
    expect(() => {
      migrate(db)
    }).not.toThrow()
    // 幂等二：模拟 user_version 回退、列已存在的库，只重放 v7 不因列已存在而抛错。
    db.exec('PRAGMA user_version = 6')
    expect(() => {
      migrate(db)
    }).not.toThrow()
    // 回退到 6 再迁移，必须重新追平到当前版本（而不是停在 7）。
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('带 artifacts 落库 → 重新读出仍在（含中文名 / 大小写 / 多张卡片）；未传 artifacts 读出无该字段', () => {
    const store = new SessionStore(':memory:')
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const artifacts = [
      { callId: 'c1', name: '周报.md', size: 1234, mime: 'text/markdown' },
      { callId: 'c2', name: 'README.MD', size: 0, mime: 'text/markdown' },
    ]
    const stored = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: 'a1',
      contentBlocks: [{ type: 'text', text: '产物见附件' }],
      artifacts,
    })
    expect(stored.artifacts).toEqual(artifacts)
    const readBack = store.listMessages(conversation.id)[0]!
    expect(readBack.artifacts).toEqual(artifacts)

    const plain = store.appendMessage({
      conversationId: conversation.id,
      senderType: 'user',
      senderId: 'user',
      contentBlocks: [{ type: 'text', text: '没有产物' }],
    })
    expect(plain.artifacts).toBeUndefined()
    // listMessages 升序：第二条（下标 1）是未带 artifacts 的消息。
    expect(store.listMessages(conversation.id)[1]!.artifacts).toBeUndefined()
    store.close()
  })

  it('artifacts_json 为非法 JSON 时不抛错：记一行日志并按空数组处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-artifacts-'))
    const dbPath = join(dir, 'session.db')
    try {
      const writer = new SessionStore(dbPath)
      const conversation = writer.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
      writer.appendMessage({
        conversationId: conversation.id,
        senderType: 'agent',
        senderId: 'a1',
        contentBlocks: [{ type: 'text', text: '脏数据前的好消息' }],
        artifacts: [{ callId: 'c1', name: '周报.md', size: 1, mime: 'text/markdown' }],
      })
      writer.close()

      // 绕开 store 直接改库注入脏 JSON。
      const raw = new DatabaseSync(dbPath)
      raw.prepare('UPDATE messages SET artifacts_json = ?').run('{not-json')
      raw.close()

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const reopened = new SessionStore(dbPath)
        const rows = reopened.listMessages(conversation.id)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.artifacts).toEqual([])
        reopened.close()
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('chatDirect：tool 结果带 produce 时产物卡片随消息落库（callId 关联到本次调用）', async () => {
    const store = new SessionStore(':memory:')
    store.upsertAgent({ ...AGENT, tools: ['file_produce'] })
    const conversation = store.createConversation({ kind: 'direct', memberAgentIds: ['a1'] })
    const callId = brandString<ToolCallId>('call-p1')
    const llm = {
      stream(options: GenerateOptions) {
        const step = options.messages.length > 1 ? 2 : 1
        const chunks: StreamChunk[] =
          step === 1
            ? [
                {
                  type: 'block-end',
                  index: 0,
                  block: { type: 'tool-call', id: callId, name: 'file_produce', arguments: '{}' },
                },
                { type: 'finish', reason: { kind: 'tool-calls' } },
              ]
            : [
                { type: 'text-delta', index: 0, text: '已生成' },
                { type: 'block-end', index: 0, block: { type: 'text', text: '已生成' } },
                { type: 'finish', reason: { kind: 'stop' } },
              ]
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* chunks
        })()
      },
    } as unknown as LlmRuntime
    const produceTool = {
      name: 'file_produce',
      description: '产出文件',
      parameters: { type: 'object' },
      async execute() {
        return {
          content: '已生成',
          produce: { path: '/w/周报.md', name: '周报.md', size: 1234, mime: 'text/markdown' },
        }
      },
    }
    const coordinator = new SessionCoordinator({ store, llm, tools: [produceTool] })
    for await (const _ of coordinator.chatDirect(conversation.id, 'a1', '写周报', { workspaceRoot: process.cwd() })) {
      /* drain */
    }

    const toolRow = store.listMessages(conversation.id).find((row) => {
      return row.toolCallId !== undefined
    })
    expect(toolRow).toBeDefined()
    expect(toolRow!.artifacts).toEqual([
      { callId, path: '/w/周报.md', name: '周报.md', size: 1234, mime: 'text/markdown' },
    ])
    store.close()
  })
})
