/**
 * SQLite 会话存储：Agent 定义、会话、消息、调度事件的 CRUD 与分页查询。
 *
 * 单写者模型：一个 SessionStore 实例拥有其 DatabaseSync 句柄；不做跨进程
 * 并发写。所有时间戳为 Unix 毫秒。
 * @module @ryagent/session/store
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { migrate, SCHEMA_VERSION } from './schema.ts'
import type {
  Conversation,
  ConversationKind,
  DispatchEvent,
  SenderType,
  StoredAgent,
  StoredMessage,
  StoredUsage,
  UsageTotals,
} from './types.ts'

/** 创建/更新 Agent 定义的输入。 */
export type AgentInput = Omit<StoredAgent, 'isBuiltin' | 'createdAt' | 'updatedAt'> & { isBuiltin?: boolean }

/** 创建会话的输入。 */
export interface ConversationInput {
  kind: ConversationKind
  title?: string
  memberAgentIds: string[]
  dispatcherAgentId?: string
}

/** 追加消息的输入。 */
export interface MessageInput {
  conversationId: string
  senderType: SenderType
  senderId?: string
  contentBlocks: unknown[]
  mentions?: string[]
  /** 工具结果消息：对应 tool_call 的 callId。 */
  toolCallId?: string
  turnIndex?: number
  /** 关联模型调用的 token 用量（assistant 消息才有）。 */
  usage?: StoredUsage
}

/** 消息分页查询参数。 */
export interface MessagePage {
  /** 返回条数（默认 50）。 */
  limit?: number
  /** 只取 seq 小于该值的记录（向过去翻页）。 */
  beforeSeq?: number
}

/** 删除一个 Agent 时各处的级联清理条数（供 API 回执与测试断言）。 */
export interface DeleteAgentResult {
  /** 被摘掉该成员的会话数。 */
  conversationsUpdated: number
  /** 删除的长期记忆行数。 */
  memories: number
  /** 删除的经验手册条目数。 */
  playbookEntries: number
  /** 删除的反思（教训）数。 */
  reflections: number
  /** 删除的反馈事件数。 */
  feedback: number
}

/**
 * SQL 片段：消息 content_blocks 里存在 type=text 块。
 * 纯 tool_call 的 assistant 消息（无文本块）不计未读、不作会话预览。
 */
const HAS_TEXT_BLOCK_SQL = `EXISTS (
  SELECT 1 FROM json_each(messages.content_blocks)
  WHERE json_extract(value, '$.type') = 'text'
)`

function parseJsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) ? parsed : []
}

/** usage 列是 JSON 文本；脏数据（手工改库/旧版本）一律按无用量处理。 */
function parseUsage(value: unknown): StoredUsage | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<StoredUsage>
    if (typeof parsed.inputTokens !== 'number' || typeof parsed.outputTokens !== 'number') return undefined
    return parsed as StoredUsage
  } catch {
    return undefined
  }
}

/** 消息落库时序列化 usage（缺省不写列）。 */
function usageColumn(usage: StoredUsage | undefined): string | null {
  return usage === undefined ? null : JSON.stringify(usage)
}

/** RyAgent 会话存储。构造时打开（必要时创建）数据库并应用缺失迁移。 */
export class SessionStore {
  private readonly db: DatabaseSync

  /** @param path - 数据库文件路径，或 ':memory:'（测试/临时）。 */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    migrate(this.db)
  }

  /** 当前 schema 版本（即迁移目标版本）。 */
  get schemaVersion(): number {
    return SCHEMA_VERSION
  }

  /** 关闭数据库句柄。 */
  close(): void {
    this.db.close()
  }

  // ---- agents ----

  /** 创建或全量覆盖一个 Agent 定义；isBuiltin 的创建者需显式传 isBuiltin: true。 */
  upsertAgent(input: AgentInput): StoredAgent {
    const now = Date.now()
    const existing = this.getAgent(input.id)
    this.db
      .prepare(`
      INSERT INTO agents (id, name, avatar, system_prompt, provider, model, temperature, tools, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, avatar = excluded.avatar, system_prompt = excluded.system_prompt,
        provider = excluded.provider, model = excluded.model, temperature = excluded.temperature,
        tools = excluded.tools, updated_at = excluded.updated_at
    `)
      .run(
        input.id,
        input.name,
        input.avatar ?? null,
        input.systemPrompt,
        input.provider,
        input.model,
        input.temperature ?? null,
        JSON.stringify(input.tools),
        input.isBuiltin === true ? 1 : 0,
        existing?.createdAt ?? now,
        now,
      )
    const stored = this.getAgent(input.id)
    if (stored === undefined) throw new Error(`@ryagent/session: upsert of agent "${input.id}" did not persist`)
    return stored
  }

  /** 读取一个 Agent 定义；不存在返回 undefined。 */
  getAgent(id: string): StoredAgent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.rowToAgent(row)
  }

  /** 列出全部 Agent 定义，按创建时间排序。 */
  listAgents(): StoredAgent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at, id').all() as Record<string, unknown>[]
    return rows.map((row) => {
      return this.rowToAgent(row)
    })
  }

  private rowToAgent(row: Record<string, unknown>): StoredAgent {
    return {
      id: String(row.id),
      name: String(row.name),
      ...(row.avatar === null || row.avatar === undefined ? {} : { avatar: String(row.avatar) }),
      systemPrompt: String(row.system_prompt),
      provider: String(row.provider),
      model: String(row.model),
      ...(row.temperature === null || row.temperature === undefined ? {} : { temperature: Number(row.temperature) }),
      tools: parseJsonArray(String(row.tools)) as string[],
      isBuiltin: Number(row.is_builtin) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  // ---- conversations ----

  /** 删除一个 Agent：摘出会话成员身份，并级联清掉它的长期记忆与经验手册。 */
  deleteAgent(id: string): DeleteAgentResult {
    this.db.exec('BEGIN')
    let result: DeleteAgentResult = { conversationsUpdated: 0, memories: 0, playbookEntries: 0, reflections: 0, feedback: 0 }
    try {
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
      for (const conversation of this.listConversations(10_000)) {
        const members = conversation.memberAgentIds.filter((member) => {
          return member !== id
        })
        const dispatcherRemoved = conversation.dispatcherAgentId === id
        if (members.length === conversation.memberAgentIds.length && !dispatcherRemoved) continue
        this.db
          .prepare('UPDATE conversations SET member_agent_ids = ?, dispatcher_agent_id = ? WHERE id = ?')
          .run(
            JSON.stringify(members),
            dispatcherRemoved ? null : (conversation.dispatcherAgentId ?? null),
            conversation.id,
          )
        result.conversationsUpdated++
      }
      // 记忆与进化共用同一个 SQLite 文件（各自的表没有指向 agents 的外键，
      // 跨包没法靠 ON DELETE CASCADE）。这里显式清一次：留着就是孤儿行——
      // agent 没了，画像/教训/反馈却还在被检索与统计。
      if (this.tableExists('memories_fts') && this.tableExists('memories')) {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE agent_id = ?)').run(id)
      }
      result.memories = this.deleteAgentRows('memories', id)
      result.playbookEntries = this.deleteAgentRows('playbook_entries', id)
      result.reflections = this.deleteAgentRows('reflections', id)
      result.feedback = this.deleteAgentRows('feedback_events', id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return result
  }

  /** 表是否存在（记忆/进化子系统被关闭时它们的迁移还没跑过）。 */
  private tableExists(table: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
      count: number
    }
    return Number(row.count) > 0
  }

  /** 按 agent_id 清理一张附属表的行；表不存在（子系统未启用）返回 0。 */
  private deleteAgentRows(table: string, id: string): number {
    if (!this.tableExists(table)) return 0
    return Number(this.db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id).changes)
  }

  /** 创建会话。 */
  createConversation(input: ConversationInput): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title ?? '',
      memberAgentIds: [...input.memberAgentIds],
      ...(input.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: input.dispatcherAgentId }),
      lastReadSeq: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(`
      INSERT INTO conversations (id, kind, title, member_agent_ids, dispatcher_agent_id, last_read_seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        conversation.id,
        conversation.kind,
        conversation.title,
        JSON.stringify(conversation.memberAgentIds),
        conversation.dispatcherAgentId ?? null,
        0,
        now,
        now,
      )
    return conversation
  }

  /** 读取会话；不存在返回 undefined。 */
  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : this.rowToConversation(row)
  }

  /** 删除会话（消息与调度事件由外键级联删除）。 */
  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  /** 未读数：seq 大于 lastReadSeq、非用户发送、且含文本块（排除纯 tool_call 行）的消息条数。 */
  unreadCount(conversationId: string, lastReadSeq: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND seq > ? AND sender_type != 'user' AND ${HAS_TEXT_BLOCK_SQL}`,
      )
      .get(conversationId, lastReadSeq) as { count: number }
    return Number(row.count)
  }

  /** 标记已读：lastReadSeq 推进到当前最新消息序号；返回推进后的值。 */
  markConversationRead(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { max_seq: number }
    const seq = Number(row.max_seq)
    this.db.prepare('UPDATE conversations SET last_read_seq = ? WHERE id = ?').run(seq, conversationId)
    return seq
  }

  /** 最近会话列表，按 updatedAt 倒序。 */
  listConversations(limit = 50): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => {
      return this.rowToConversation(row)
    })
  }

  /**
   * 会话列表 + 末条预览 + 未读数（单查询，避免 N+1）。
   * 未读 = seq > last_read_seq、非用户发送、且含文本块的消息数；
   * 预览取最近一条含文本块的消息（跳过纯 tool_call 行）。
   */
  listConversationsWithPreview(limit = 50): (Conversation & { lastMessagePreview: string; unreadCount: number })[] {
    const rows = this.db
      .prepare(`
      SELECT c.*,
        (SELECT content_blocks FROM messages
          WHERE conversation_id = c.id AND ${HAS_TEXT_BLOCK_SQL}
          ORDER BY seq DESC LIMIT 1) AS last_blocks,
        (SELECT COUNT(*) FROM messages
          WHERE conversation_id = c.id AND seq > c.last_read_seq AND sender_type != 'user'
            AND ${HAS_TEXT_BLOCK_SQL}) AS unread_count
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT ?
    `)
      .all(limit) as Record<string, unknown>[]
    return rows.map((row) => {
      const blocks = parseJsonArray(String(row.last_blocks ?? '[]')) as { type?: string; text?: string }[]
      const preview = (
        blocks.find((b) => {
          return b.type === 'text' && typeof b.text === 'string'
        })?.text ?? ''
      ).slice(0, 120)
      return {
        ...this.rowToConversation(row),
        lastMessagePreview: preview,
        unreadCount: Number(row.unread_count ?? 0),
      }
    })
  }

  /** 刷新会话的 updatedAt（新消息落库后调用）。 */
  touchConversation(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id)
  }

  private rowToConversation(row: Record<string, unknown>): Conversation {
    return {
      id: String(row.id),
      kind: String(row.kind) as ConversationKind,
      title: String(row.title),
      memberAgentIds: parseJsonArray(String(row.member_agent_ids)) as string[],
      ...(row.dispatcher_agent_id === null || row.dispatcher_agent_id === undefined
        ? {}
        : { dispatcherAgentId: String(row.dispatcher_agent_id) }),
      lastReadSeq: Number(row.last_read_seq ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  // ---- messages ----

  /** 追加一条消息并刷新会话 updatedAt；返回完整记录（含分配的 seq）。 */
  appendMessage(input: MessageInput): StoredMessage {
    const now = Date.now()
    const message: StoredMessage = {
      id: randomUUID(),
      seq: 0,
      conversationId: input.conversationId,
      senderType: input.senderType,
      ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
      contentBlocks: input.contentBlocks,
      mentions: input.mentions ?? [],
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      turnIndex: input.turnIndex ?? 0,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      createdAt: now,
    }
    const result = this.db
      .prepare(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_blocks, mentions, tool_call_id, turn_index, usage, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        message.id,
        message.conversationId,
        message.senderType,
        message.senderId ?? null,
        JSON.stringify(message.contentBlocks),
        JSON.stringify(message.mentions),
        message.toolCallId ?? null,
        message.turnIndex,
        usageColumn(input.usage),
        now,
      )
    message.seq = Number(result.lastInsertRowid)
    this.touchConversation(input.conversationId, now)
    return message
  }

  /**
   * 回填一条 assistant 消息的 token 用量。
   *
   * 模型调用结束后才拿到 usage，而消息在流组装完成时就落库了，因此用量走
   * 二次 UPDATE 挂到"本次调用产出的那条消息"上，而不是写进 INSERT。
   */
  attachUsage(messageId: string, usage: StoredUsage): void {
    this.db.prepare('UPDATE messages SET usage = ? WHERE id = ?').run(JSON.stringify(usage), messageId)
  }

  /** 会话级累计用量（单查询求和；total 缺失时按 input+output 兜底）。 */
  conversationUsage(conversationId: string): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CAST(json_extract(usage, '$.inputTokens') AS INTEGER)), 0) AS input,
           COALESCE(SUM(CAST(json_extract(usage, '$.outputTokens') AS INTEGER)), 0) AS output,
           COALESCE(SUM(COALESCE(
             CAST(json_extract(usage, '$.totalTokens') AS INTEGER),
             CAST(json_extract(usage, '$.inputTokens') AS INTEGER) + CAST(json_extract(usage, '$.outputTokens') AS INTEGER)
           )), 0) AS total,
           COUNT(usage) AS messages
         FROM messages WHERE conversation_id = ? AND usage IS NOT NULL`,
      )
      .get(conversationId) as { input: number; output: number; total: number; messages: number }
    return {
      inputTokens: Number(row.input),
      outputTokens: Number(row.output),
      totalTokens: Number(row.total),
      messages: Number(row.messages),
    }
  }

  /** 按会话取消息，seq 升序；用返回值的 seq 作为 beforeSeq 向过去翻页。 */
  listMessages(conversationId: string, page: MessagePage = {}): StoredMessage[] {
    const limit = page.limit ?? 50
    const rows = (
      page.beforeSeq === undefined
        ? this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
            .all(conversationId, limit)
        : this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
            .all(conversationId, page.beforeSeq, limit)
    ) as Record<string, unknown>[]
    return rows.reverse().map((row) => {
      return this.rowToMessage(row)
    })
  }

  /** 会话的下一个 turn 序号（max(turn_index) + 1，首条为 0）。 */
  nextTurnIndex(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { next: number }
    return Number(row.next)
  }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    return {
      id: String(row.id),
      seq: Number(row.seq),
      conversationId: String(row.conversation_id),
      senderType: String(row.sender_type) as SenderType,
      ...(row.sender_id === null || row.sender_id === undefined ? {} : { senderId: String(row.sender_id) }),
      contentBlocks: parseJsonArray(String(row.content_blocks)),
      mentions: parseJsonArray(String(row.mentions)) as string[],
      ...(row.tool_call_id === null || row.tool_call_id === undefined ? {} : { toolCallId: String(row.tool_call_id) }),
      turnIndex: Number(row.turn_index),
      ...(parseUsage(row.usage) === undefined ? {} : { usage: parseUsage(row.usage) as StoredUsage }),
      createdAt: Number(row.created_at),
    }
  }

  // ---- dispatch events ----

  /** 记录一次群聊调度决策。 */
  recordDispatchEvent(input: Omit<DispatchEvent, 'id' | 'createdAt'>): DispatchEvent {
    const event: DispatchEvent = { id: randomUUID(), createdAt: Date.now(), ...input }
    this.db
      .prepare(`
      INSERT INTO dispatch_events (id, conversation_id, from_agent, to_agent, reason, turn_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        event.id,
        event.conversationId,
        event.fromAgent ?? null,
        event.toAgent,
        event.reason,
        event.turnIndex,
        event.createdAt,
      )
    return event
  }

  /** 按会话列出调度事件，写入顺序（rowid）升序——同毫秒时间戳也能保持确定性顺序。 */
  listDispatchEvents(conversationId: string): DispatchEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM dispatch_events WHERE conversation_id = ? ORDER BY rowid')
      .all(conversationId) as Record<string, unknown>[]
    return rows.map((row): DispatchEvent => {
      return {
        id: String(row.id),
        conversationId: String(row.conversation_id),
        ...(row.from_agent === null || row.from_agent === undefined ? {} : { fromAgent: String(row.from_agent) }),
        toAgent: String(row.to_agent),
        reason: String(row.reason),
        turnIndex: Number(row.turn_index),
        createdAt: Number(row.created_at),
      }
    })
  }
}
