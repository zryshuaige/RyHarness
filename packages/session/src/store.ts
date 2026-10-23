/**
 * SQLite 会话存储：Agent 定义、会话、消息、调度事件的 CRUD、分页查询与消息全文索引。
 *
 * 单写者模型：一个 SessionStore 实例拥有其 DatabaseSync 句柄；不做跨进程
 * 并发写。所有时间戳为 Unix 毫秒。
 * @module @ryharness/session/store
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { bigrams, ftsMatchQuery, messageSearchText } from './fts.ts'
import type { AffinityEvent, AgentPersona } from './persona.ts'
import { nextAffinity, normalizePersona, serializePersona } from './persona.ts'
import { migrate, SCHEMA_VERSION } from './schema.ts'
import type {
  Conversation,
  ConversationKind,
  DispatchEvent,
  MessageArtifact,
  SenderType,
  StoredAgent,
  StoredMessage,
  StoredUsage,
  UsageTotals,
} from './types.ts'

/**
 * 创建/更新 Agent 定义的输入。
 *
 * persona 可选且可只给部分字段：调用方（种子、模板实例化、旧测试）不必为了
 * 存一个 agent 先拼一整个人格，缺的部分由 {@link normalizePersona} 补默认值。
 */
export type AgentInput = Omit<StoredAgent, 'isBuiltin' | 'createdAt' | 'updatedAt' | 'persona'> & {
  isBuiltin?: boolean
  persona?: Partial<AgentPersona>
}

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
  /** 工具结果消息携带的产物卡片（file_produce 类工具的产出）。 */
  artifacts?: readonly MessageArtifact[]
}

/** 消息分页查询参数。 */
export interface MessagePage {
  /** 返回条数（默认 50）。 */
  limit?: number
  /** 只取 seq 小于该值的记录（向过去翻页）。 */
  beforeSeq?: number
}

/** 历史增量读的回翻页大小：预算窗口通常远小于一页，200 行把长会话的取数次数压到个位数。 */
const HISTORY_READ_PAGE_SIZE = 200

/** {@link SessionStore.listMessagesForHistory} 的读法参数。 */
export interface HistoryReadOptions {
  /**
   * 逐行计量：返回该行进入历史窗口的预算权重（token，与 @ryharness/agent 的
   * trimHistoryToBudget 同一口径）；返回 undefined 表示该行不属于历史（不进窗口、
   * 不占预算）——“哪些行算历史”由调用方在这里编码。
   */
  weightOf: (row: StoredMessage) => number | undefined
  /**
   * 窗口是否至少保留最新一条计入行。单聊传 true（对齐 trimHistoryToBudget 的
   * “至少保留最新一条”）；群聊传 false（buildGroupContext 允许把历史裁空）。
   * 默认 true。
   */
  keepNewest?: boolean
  /** 只读 turnIndex 小于该值的行（群聊排除本轮已落库的消息）；缺省不过滤。 */
  beforeTurnIndex?: number
}

/** 关键词搜索参数。 */
export interface MessageSearchOptions {
  /** 限定会话（缺省 = 全部会话）。 */
  conversationId?: string
  /** 返回条数上限（默认 50）。 */
  limit?: number
  /** BM25 候选窗口（默认 {@link MESSAGE_SEARCH_WINDOW}）：过滤后仍要凑够 limit 条。 */
  window?: number
}

/** 一条关键词命中（只带定位与展示需要的字段，不含完整 content_blocks）。 */
export interface MessageSearchHit {
  messageId: string
  conversationId: string
  seq: number
  senderType: SenderType
  senderId?: string
  createdAt: number
  /** 命中行的可搜索正文（建索引时的抽取结果，调用侧据此截片段）。 */
  text: string
  /** BM25 相关度（越小越相关，与 SQLite 的 bm25() 口径一致）。 */
  score: number
}

/** 关键词搜索的默认 BM25 候选窗口。 */
export const MESSAGE_SEARCH_WINDOW = 200

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

/** persona 列解析：NULL（v6 之前）或脏 JSON 都返回 undefined，交给归一走默认值。 */
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
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

/**
 * artifacts_json 列解析：NULL/空串 → 无产物；脏 JSON（手工改库/旧版本）记一行
 * 日志并按空数组处理，绝不让历史加载抛错。
 */
function parseArtifacts(value: unknown): MessageArtifact[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed as MessageArtifact[]
  } catch {
    console.warn('@ryharness/session: messages.artifacts_json 不是合法 JSON，按空产物处理')
    return []
  }
  console.warn('@ryharness/session: messages.artifacts_json 不是 JSON 数组，按空产物处理')
  return []
}

/** 消息落库时序列化 usage（缺省不写列）。 */
function usageColumn(usage: StoredUsage | undefined): string | null {
  return usage === undefined ? null : JSON.stringify(usage)
}

/** 消息落库时序列化产物卡片（缺省不写列，读侧按 NULL → 无产物处理）。 */
function artifactsColumn(artifacts: readonly MessageArtifact[] | undefined): string | null {
  return artifacts === undefined ? null : JSON.stringify(artifacts)
}

/** 预编译语句缓存上界（SQL 文本种类固定，留两倍余量足够）。 */
const MAX_PREPARED = 64

/** RyHarness 会话存储。构造时打开（必要时创建）数据库并应用缺失迁移。 */
export class SessionStore {
  private readonly db: DatabaseSync
  /**
   * 预编译语句缓存：`DatabaseSync.prepare()` 每次都要重新解析 SQL 并向 SQLite 要一份
   * 执行计划，而这里的语句全是固定 SQL + 变长参数（长会话里每翻一页消息、每写一条
   * 消息都要 prepare 一次）。按 SQL 文本缓存后，同一条语句整个进程只解析一次。
   * 上界 {@link MAX_PREPARED}：SQL 文本种类固定（表结构固定），留两倍余量足够。
   */
  private readonly statements = new Map<string, StatementSync>()
  /** 命中缓存的次数（诊断用：证明缓存真的在生效，而不是每次都重新 prepare）。 */
  private statementHits = 0

  /** @param path - 数据库文件路径，或 ':memory:'（测试/临时）。 */
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL 下 synchronous = NORMAL 已足够安全：事务只在 checkpoint 时真正 fsync，
    // 掉电最多丢最后未 checkpoint 的事务，库不会损坏；默认 FULL 等于每次 commit
    // 都多停一次事件循环等 fsync，写密集的落库路径（每条消息一个 commit）代价明显。
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    migrate(this.db)
  }

  /** 取预编译语句（首次解析后缓存）。 */
  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached !== undefined) {
      this.statementHits += 1
      return cached
    }
    const prepared = this.db.prepare(sql)
    this.statements.set(sql, prepared)
    while (this.statements.size > MAX_PREPARED) {
      const oldest = this.statements.keys().next()
      if (oldest.done === true) break
      this.statements.delete(oldest.value)
    }
    return prepared
  }

  /** 预编译语句缓存的规模与命中次数（诊断与测试断言用）。 */
  preparedStats(): { cached: number; reuse: number } {
    return { cached: this.statements.size, reuse: this.statementHits }
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
    this.stmt(`
      INSERT INTO agents (id, name, avatar, system_prompt, provider, model, temperature, reasoning_effort, tools, persona, is_builtin, route_locked, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, avatar = excluded.avatar, system_prompt = excluded.system_prompt,
        provider = excluded.provider, model = excluded.model, temperature = excluded.temperature,
        reasoning_effort = excluded.reasoning_effort,
        tools = excluded.tools, persona = excluded.persona,
        route_locked = excluded.route_locked, updated_at = excluded.updated_at
    `).run(
      input.id,
      input.name,
      input.avatar ?? null,
      input.systemPrompt,
      input.provider,
      input.model,
      input.temperature ?? null,
      input.reasoningEffort ?? null,
      JSON.stringify(input.tools),
      // 未给 persona 时沿用库里的那份：亲密度是互动累积出来的，一条不带 persona
      // 的 PATCH（只改模型名）不该把它清零。给了就补齐缺的字段再归一。
      serializePersona(
        normalizePersona(input.persona === undefined ? existing?.persona : { ...existing?.persona, ...input.persona }),
      ),
      input.isBuiltin === true ? 1 : 0,
      // 没给 routeLocked 时沿用库里的那份：服务器自动改绑不该顺手把「用户手动挑过
      // 路由」这个标记抹掉，抹掉等于把用户的选择重新交回默认值。
      (input.routeLocked ?? existing?.routeLocked) === true ? 1 : 0,
      existing?.createdAt ?? now,
      now,
    )
    const stored = this.getAgent(input.id)
    if (stored === undefined) throw new Error(`@ryharness/session: upsert of agent "${input.id}" did not persist`)
    return stored
  }

  /**
   * 亲密度推进一轮互动（对话轮数 / 点赞 / 点踩）。
   *
   * 增长规则只有 {@link nextAffinity} 一处定义；这里只负责读—算—写，顺带刷
   * updatedAt 让通讯录按"最近变过的"排。不存在的 agent 返回 undefined（调用方
   * 多半刚删过它，不该为此抛错）。
   */
  bumpAgentAffinity(id: string, event: AffinityEvent): StoredAgent | undefined {
    const existing = this.getAgent(id)
    if (existing === undefined) return undefined
    const affinity = nextAffinity(existing.persona.affinity, event)
    if (affinity === existing.persona.affinity) return existing
    this.stmt('UPDATE agents SET persona = ?, updated_at = ? WHERE id = ?').run(
      serializePersona({ ...existing.persona, affinity }),
      Date.now(),
      id,
    )
    return this.getAgent(id)
  }

  /**
   * 同一消息同一信号是否已反馈过（/api/feedback 的防刷去重）。
   *
   * feedback_events 是进化子系统的表（与 session 共用同一个 SQLite 文件）：
   * 进化关闭时表可能还没建，按「没反馈过」处理——那条路由此时本来就回 409。
   */
  hasFeedback(messageId: string, signal: 'thumb_up' | 'thumb_down'): boolean {
    if (!this.tableExists('feedback_events')) return false
    return (
      this.stmt('SELECT 1 AS ok FROM feedback_events WHERE message_id = ? AND signal = ? LIMIT 1').get(
        messageId,
        signal,
      ) !== undefined
    )
  }

  /** 读取一个 Agent 定义；不存在返回 undefined。 */
  getAgent(id: string): StoredAgent | undefined {
    const row = this.stmt('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.rowToAgent(row)
  }

  /** 读一条设置；不存在返回 undefined（调用方给默认值，不要在这里编造）。 */
  getSetting(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as Record<string, unknown> | undefined
    return row === undefined ? undefined : String(row.value)
  }

  /** 写一条设置。同 key 覆盖。 */
  setSetting(key: string, value: string): void {
    this.stmt(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  /** 列出全部 Agent 定义，按创建时间排序。 */
  listAgents(): StoredAgent[] {
    const rows = this.stmt('SELECT * FROM agents ORDER BY created_at, id').all() as Record<string, unknown>[]
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
      ...(row.reasoning_effort === null || row.reasoning_effort === undefined
        ? {}
        : { reasoningEffort: String(row.reasoning_effort) }),
      tools: parseJsonArray(String(row.tools)) as string[],
      // persona 列可能是 NULL（v6 之前的行）或脏 JSON：一律走归一，读出来必是完整一份。
      persona: normalizePersona(parseJsonValue(row.persona)),
      isBuiltin: Number(row.is_builtin) === 1,
      ...(Number(row.route_locked) === 1 ? { routeLocked: true } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  // ---- conversations ----

  /** 删除一个 Agent：摘出会话成员身份，并级联清掉它的长期记忆与经验手册。 */
  deleteAgent(id: string): DeleteAgentResult {
    this.db.exec('BEGIN')
    const result: DeleteAgentResult = {
      conversationsUpdated: 0,
      memories: 0,
      playbookEntries: 0,
      reflections: 0,
      feedback: 0,
    }
    try {
      this.stmt('DELETE FROM agents WHERE id = ?').run(id)
      for (const conversation of this.listConversations(10_000)) {
        const members = conversation.memberAgentIds.filter((member) => {
          return member !== id
        })
        const dispatcherRemoved = conversation.dispatcherAgentId === id
        if (members.length === conversation.memberAgentIds.length && !dispatcherRemoved) continue
        this.stmt('UPDATE conversations SET member_agent_ids = ?, dispatcher_agent_id = ? WHERE id = ?').run(
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
        this.stmt('DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE agent_id = ?)').run(id)
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
    const row = this.stmt("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(
      table,
    ) as {
      count: number
    }
    return Number(row.count) > 0
  }

  /** 按 agent_id 清理一张附属表的行；表不存在（子系统未启用）返回 0。 */
  private deleteAgentRows(table: string, id: string): number {
    if (!this.tableExists(table)) return 0
    return Number(this.stmt(`DELETE FROM ${table} WHERE agent_id = ?`).run(id).changes)
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
    this.stmt(`
      INSERT INTO conversations (id, kind, title, member_agent_ids, dispatcher_agent_id, last_read_seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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

  /** 读取会话；不存在**或已软删**返回 undefined。 */
  getConversation(id: string): Conversation | undefined {
    const row = this.stmt('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : this.rowToConversation(row)
  }

  /** 删除会话（消息与调度事件由外键级联删除）。 */
  deleteConversation(id: string): void {
    // FTS 表不在外键树里（它只按 rowid 关联 messages）：不显式清就留下孤儿索引行，
    // 它们照样占 BM25 候选窗口，搜出来的却是已经删掉的消息。
    this.stmt('DELETE FROM messages_fts WHERE rowid IN (SELECT seq FROM messages WHERE conversation_id = ?)').run(id)
    this.stmt('DELETE FROM conversations WHERE id = ?').run(id)
  }

  /**
   * 标记会话已删除（软删）：列表不再显示它，数据一条不动。
   *
   * 与 {@link deleteConversation} 的区别就是"能不能撤销"：物理删之后用户连
   * "我删错了"都说不出口，而删除会话恰恰是最容易手滑的一下。软删只打标记，
   * {@link restoreConversation} 把标记清掉就回来了。
   *
   * 消息、FTS 索引、调度事件**一律保留**——撤销要的就是它们原样还在。
   *
   * @returns 真的标记了（会话存在且此前没被删）才为 true。
   */
  markConversationDeleted(id: string, now = Date.now()): boolean {
    const result = this.stmt(
      'UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(now, now, id)
    return Number(result.changes) > 0
  }

  /**
   * 撤销删除：清掉标记，会话回到列表。
   *
   * @returns 真的恢复了（会话存在且此前被删）才为 true。
   */
  restoreConversation(id: string): boolean {
    const result = this.stmt('UPDATE conversations SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(
      id,
    )
    return Number(result.changes) > 0
  }

  /** 会话是否已被软删（已删的会话在列表查询里看不到，但数据还在）。 */
  isConversationDeleted(id: string): boolean {
    const row = this.stmt('SELECT deleted_at FROM conversations WHERE id = ?').get(id) as
      | { deleted_at: number | null }
      | undefined
    if (row === undefined) return false
    return row.deleted_at !== null && row.deleted_at !== undefined
  }

  /** 未读数：seq 大于 lastReadSeq、非用户发送、且含文本块（排除纯 tool_call 行）的消息条数。 */
  unreadCount(conversationId: string, lastReadSeq: number): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND seq > ? AND sender_type != 'user' AND ${HAS_TEXT_BLOCK_SQL}`,
    ).get(conversationId, lastReadSeq) as { count: number }
    return Number(row.count)
  }

  /** 标记已读：lastReadSeq 推进到当前最新消息序号；返回推进后的值。 */
  markConversationRead(conversationId: string): number {
    const row = this.stmt('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ?').get(
      conversationId,
    ) as { max_seq: number }
    const seq = Number(row.max_seq)
    this.stmt('UPDATE conversations SET last_read_seq = ? WHERE id = ?').run(seq, conversationId)
    return seq
  }

  /** 最近会话列表，按 updatedAt 倒序（已软删的不在其中）。 */
  listConversations(limit = 50): Conversation[] {
    const rows = this.stmt('SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(
      limit,
    ) as Record<string, unknown>[]
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
    const rows = this.stmt(`
      SELECT c.*,
        (SELECT content_blocks FROM messages
          WHERE conversation_id = c.id AND ${HAS_TEXT_BLOCK_SQL}
          ORDER BY seq DESC LIMIT 1) AS last_blocks,
        (SELECT COUNT(*) FROM messages
          WHERE conversation_id = c.id AND seq > c.last_read_seq AND sender_type != 'user'
            AND ${HAS_TEXT_BLOCK_SQL}) AS unread_count
      FROM conversations c
      WHERE c.deleted_at IS NULL
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[]
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
    this.stmt('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id)
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

  /** 追加一条消息：消息 INSERT、会话 touch 与 FTS 索引三写同事务提交（原子，不留半条消息）。 */
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
      ...(input.artifacts === undefined ? {} : { artifacts: [...input.artifacts] }),
      turnIndex: input.turnIndex ?? 0,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      createdAt: now,
    }
    // 三条写（消息行 / 会话 updatedAt / FTS 索引）此前各自隐式事务：中途失败会
    // 留下有行无索引、会话未刷新的半条消息。BEGIN IMMEDIATE 在写入前就拿写锁，
    // 单写者模型下不引入额外争用；usage 若有也在同一条 INSERT 里写入。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.stmt(`
      INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_blocks, mentions, tool_call_id, turn_index, usage, artifacts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        message.id,
        message.conversationId,
        message.senderType,
        message.senderId ?? null,
        JSON.stringify(message.contentBlocks),
        JSON.stringify(message.mentions),
        message.toolCallId ?? null,
        message.turnIndex,
        usageColumn(input.usage),
        artifactsColumn(input.artifacts),
        now,
      )
      message.seq = Number(result.lastInsertRowid)
      this.touchConversation(input.conversationId, now)
      this.indexMessage(message.seq, input.contentBlocks)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return message
  }

  /** 给一条消息写全文索引（无正文的消息不占索引行，与迁移补索引同口径）。 */
  private indexMessage(seq: number, contentBlocks: unknown[]): void {
    const text = messageSearchText(contentBlocks)
    if (text.length === 0) return
    this.stmt('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)').run(seq, bigrams(text))
  }

  // ---- 历史改写（编辑 / 重生成 / 分支）----

  /**
   * 截断历史：删掉 seq ≥ fromSeq 的消息（fromSeq 这一条也删）。
   *
   * "编辑并重发"与"重新生成"共用它：前者要删掉被改那条之后的一切，后者要删掉
   * 那条回复本身及其之后的一切。整段在一个事务里完成，删到一半失败不会留下
   * 一个"消息没了、索引还在"的半截状态。
   *
   * 连带要清的三样，漏掉任何一样都会留下可见的错：
   * - **FTS 索引行**：FTS 表不在外键树里，不显式清就留下孤儿索引行——它们照样
   *   占 BM25 候选窗口，搜出来的却是已经删掉的消息。
   * - **调度事件**：那一轮的消息一条不剩时，轨迹也就没有意义了（还剩消息的轮次
   *   保留轨迹：那一轮确实发生过）。
   * - **已读游标**：last_read_seq 不能落在被删的区间里，否则未读数会算错。
   *
   * @returns 删掉了几条消息。
   */
  truncateMessages(conversationId: string, fromSeq: number): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const turns = this.stmt('SELECT DISTINCT turn_index FROM messages WHERE conversation_id = ? AND seq >= ?').all(
        conversationId,
        fromSeq,
      ) as { turn_index: number }[]
      this.stmt(
        'DELETE FROM messages_fts WHERE rowid IN (SELECT seq FROM messages WHERE conversation_id = ? AND seq >= ?)',
      ).run(conversationId, fromSeq)
      const result = this.stmt('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?').run(
        conversationId,
        fromSeq,
      )
      for (const turn of turns) {
        const left = this.stmt(
          'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND turn_index = ?',
        ).get(conversationId, turn.turn_index) as { count: number }
        if (Number(left.count) > 0) continue
        this.stmt('DELETE FROM dispatch_events WHERE conversation_id = ? AND turn_index = ?').run(
          conversationId,
          turn.turn_index,
        )
      }
      this.stmt('UPDATE conversations SET last_read_seq = MIN(last_read_seq, ?) WHERE id = ?').run(
        fromSeq - 1,
        conversationId,
      )
      this.db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 改写一条用户消息的正文。
   *
   * 只允许改**纯文本**的用户消息：带附件或工具块的消息改正文会把那些块一起
   * 丢掉，用户看到的是"我写的那句话没了，附件也没了"。
   *
   * FTS 索引同步重写：不重写的话，搜索命中的还是旧正文。
   *
   * @returns 改到了才为 true（会话里没有这条 / 不是用户消息 / 不是纯文本 → false）。
   */
  updateUserMessageText(conversationId: string, seq: number, text: string): boolean {
    const row = this.stmt('SELECT sender_type, content_blocks FROM messages WHERE conversation_id = ? AND seq = ?').get(
      conversationId,
      seq,
    ) as { sender_type: string; content_blocks: string } | undefined
    if (row === undefined) return false
    if (row.sender_type !== 'user') return false
    const blocks = parseJsonArray(row.content_blocks) as { type?: string }[]
    const onlyText = blocks.every((block) => {
      return block.type === 'text'
    })
    if (!onlyText) return false
    const next = [{ type: 'text', text }]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.stmt('UPDATE messages SET content_blocks = ? WHERE conversation_id = ? AND seq = ?').run(
        JSON.stringify(next),
        conversationId,
        seq,
      )
      this.stmt('DELETE FROM messages_fts WHERE rowid = ?').run(seq)
      this.indexMessage(seq, next)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return true
  }

  /**
   * 把源会话里 seq ≤ upToSeq 的消息复制到目标会话（"从这里分支"）。
   *
   * 复制的是**内容**，不是引用：之后两边各说各的，改一边不影响另一边。消息
   * id 与 seq 重新分配（两者都是主键），其余字段（发言者、@提及、工具配对、
   * 轮次号、token 用量、产物卡片）原样带走。
   *
   * FTS 索引按新 seq 重写——目标会话的搜索要能命中复制过去的正文。
   *
   * @returns 复制了几条。
   */
  copyMessagesTo(sourceId: string, upToSeq: number, targetId: string): number {
    const rows = this.stmt('SELECT * FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq ASC').all(
      sourceId,
      upToSeq,
    ) as Record<string, unknown>[]
    if (rows.length === 0) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let last = 0
      for (const row of rows) {
        const blocks = parseJsonArray(String(row.content_blocks))
        const result = this.stmt(`
          INSERT INTO messages (id, conversation_id, sender_type, sender_id, content_blocks, mentions, tool_call_id, turn_index, usage, artifacts_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          targetId,
          String(row.sender_type),
          row.sender_id === null || row.sender_id === undefined ? null : String(row.sender_id),
          String(row.content_blocks),
          String(row.mentions ?? '[]'),
          row.tool_call_id === null || row.tool_call_id === undefined ? null : String(row.tool_call_id),
          Number(row.turn_index),
          row.usage === null || row.usage === undefined ? null : String(row.usage),
          row.artifacts_json === null || row.artifacts_json === undefined ? null : String(row.artifacts_json),
          Number(row.created_at),
        )
        const seq = Number(result.lastInsertRowid)
        last = seq
        this.indexMessage(seq, blocks)
      }
      // 复制过去的内容算"已读"：分支刚建好时不该挂着一排未读徽标。
      this.stmt('UPDATE conversations SET last_read_seq = ? WHERE id = ?').run(last, targetId)
      this.touchConversation(targetId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  /**
   * 消息全文搜索（FTS5 BM25）。
   *
   * 取代"每个会话倒序翻页 + 内存子串匹配"：那套做法每次搜索都要把整库消息
   * 拉出来 JSON.parse 一遍，会话多起来就是全库同步扫描。命中按 BM25 相关度
   * 升序（越小越相关）返回，调用方要时间序就自己再排。
   */
  searchMessages(query: string, options: MessageSearchOptions = {}): MessageSearchHit[] {
    const limit = Math.max(1, options.limit ?? 50)
    const window = Math.max(limit, options.window ?? MESSAGE_SEARCH_WINDOW)
    const matchQuery = ftsMatchQuery(query)
    if (matchQuery.length === 0) return []
    const rows = (
      options.conversationId === undefined
        ? this.stmt(
            'SELECT rowid, bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ? ORDER BY score LIMIT ?',
          ).all(matchQuery, window)
        : this.stmt(
            `SELECT messages_fts.rowid AS rowid, bm25(messages_fts) AS score FROM messages_fts
               JOIN messages m ON m.seq = messages_fts.rowid
              WHERE messages_fts MATCH ? AND m.conversation_id = ?
              ORDER BY score LIMIT ?`,
          ).all(matchQuery, options.conversationId, window)
    ) as { rowid: number; score: number }[]
    const out: MessageSearchHit[] = []
    for (const hit of rows) {
      const row = this.stmt('SELECT * FROM messages WHERE seq = ?').get(Number(hit.rowid)) as
        | Record<string, unknown>
        | undefined
      // 索引与消息行不该脱节；真脱节（外部改库）就跳过，不让搜索抛错。
      if (row === undefined) continue
      out.push({
        messageId: String(row.id),
        conversationId: String(row.conversation_id),
        seq: Number(row.seq),
        senderType: String(row.sender_type) as SenderType,
        ...(row.sender_id === null || row.sender_id === undefined ? {} : { senderId: String(row.sender_id) }),
        createdAt: Number(row.created_at),
        text: messageSearchText(parseJsonArray(String(row.content_blocks))),
        score: Number(hit.score),
      })
      if (out.length >= limit) break
    }
    return out
  }

  /** 全文索引行数（观测用：写消息会涨、删会话会降）。 */
  messageIndexSize(): number {
    return Number((this.stmt('SELECT COUNT(*) AS count FROM messages_fts').get() as { count: number }).count)
  }

  /**
   * 回填一条 assistant 消息的 token 用量。
   *
   * 模型调用结束后才拿到 usage，而消息在流组装完成时就落库了，因此用量走
   * 二次 UPDATE 挂到"本次调用产出的那条消息"上，而不是写进 INSERT。
   */
  attachUsage(messageId: string, usage: StoredUsage): void {
    this.stmt('UPDATE messages SET usage = ? WHERE id = ?').run(JSON.stringify(usage), messageId)
  }

  /** 会话级累计用量（单查询求和；total 缺失时按 input+output 兜底）。 */
  conversationUsage(conversationId: string): UsageTotals {
    const row = this.stmt(
      `SELECT
           COALESCE(SUM(CAST(json_extract(usage, '$.inputTokens') AS INTEGER)), 0) AS input,
           COALESCE(SUM(CAST(json_extract(usage, '$.outputTokens') AS INTEGER)), 0) AS output,
           COALESCE(SUM(COALESCE(
             CAST(json_extract(usage, '$.totalTokens') AS INTEGER),
             CAST(json_extract(usage, '$.inputTokens') AS INTEGER) + CAST(json_extract(usage, '$.outputTokens') AS INTEGER)
           )), 0) AS total,
           COUNT(usage) AS messages
         FROM messages WHERE conversation_id = ? AND usage IS NOT NULL`,
    ).get(conversationId) as { input: number; output: number; total: number; messages: number }
    return {
      inputTokens: Number(row.input),
      outputTokens: Number(row.output),
      totalTokens: Number(row.total),
      messages: Number(row.messages),
    }
  }

  /**
   * 取一条消息（按会话 + seq）；不存在返回 undefined。
   *
   * "编辑并重发""重新生成"都要先确认目标消息是谁、属于哪个会话，再决定能不能动。
   */
  getMessage(conversationId: string, seq: number): StoredMessage | undefined {
    const row = this.stmt('SELECT * FROM messages WHERE conversation_id = ? AND seq = ?').get(conversationId, seq) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : this.rowToMessage(row)
  }

  /**
   * 取 seq < beforeSeq 的最后一条**用户**消息。
   *
   * "重新生成"要重跑的是这条回复前面那条用户消息——找不到就没有可重放的提示词
   * （例如这条回复前面只有别的 agent 说的话）。
   */
  lastUserMessageBefore(conversationId: string, beforeSeq: number): StoredMessage | undefined {
    const row = this.stmt(
      "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? AND sender_type = 'user' ORDER BY seq DESC LIMIT 1",
    ).get(conversationId, beforeSeq) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.rowToMessage(row)
  }

  /** 按会话取消息，seq 升序；用返回值的 seq 作为 beforeSeq 向过去翻页。 */
  listMessages(conversationId: string, page: MessagePage = {}): StoredMessage[] {
    const limit = page.limit ?? 50
    const rows = (
      page.beforeSeq === undefined
        ? this.stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?').all(
            conversationId,
            limit,
          )
        : this.stmt('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(
            conversationId,
            page.beforeSeq,
            limit,
          )
    ) as Record<string, unknown>[]
    return rows.reverse().map((row) => {
      return this.rowToMessage(row)
    })
  }

  /**
   * 历史增量读：按 token 预算从最新往回取消息，替代“整读 1000 行再由调用方裁剪”
   * （内核评审 r1-02 的 P0-2：长会话每轮整读 1000 行并逐行 JSON.parse）。
   *
   * 从最新一条开始按 seq 降序分页取（游标复用 beforeSeq），逐行 weightOf 计量
   * 累计，某行的权重会顶破 budgetTokens 就停——取出的恰是“预算内装得下的最大
   * 最新后缀”，与“全量取回后从最旧贪心丢弃”的裁剪结果一致（权重口径一致时
   * 逐条相同）。返回按 seq 升序；窗口首条若是 tool 结果行（其 tool_call 已被
   * 排除在窗口外，模型侧序列非法）则丢弃：宁少一条，不给模型断掉的配对。
   *
   * budgetTokens 非有限（如 Infinity）表示不设预算、读全量，与
   * trimHistoryToBudget 对非有限预算的口径一致。
   */
  listMessagesForHistory(conversationId: string, budgetTokens: number, options: HistoryReadOptions): StoredMessage[] {
    const { weightOf, keepNewest = true, beforeTurnIndex } = options
    const newestFirst: StoredMessage[] = []
    let used = 0
    let cursor: number | undefined
    for (;;) {
      const page = this.listMessages(conversationId, { limit: HISTORY_READ_PAGE_SIZE, beforeSeq: cursor })
      if (page.length === 0) break
      cursor = page[0].seq
      // 页内从新到旧：预算一旦顶破，更旧的行一并排除（贪心后缀）。
      for (let index = page.length - 1; index >= 0; index--) {
        const row = page[index]
        if (beforeTurnIndex !== undefined && row.turnIndex >= beforeTurnIndex) continue
        const weight = weightOf(row)
        if (weight === undefined) continue
        if (newestFirst.length === 0 && keepNewest) {
          // 单聊口径：哪怕自身超预算，也至少保留最新一条计入行（对齐裁剪器）。
        } else if (used + weight > budgetTokens) {
          return this.finishHistoryWindow(newestFirst)
        }
        newestFirst.push(row)
        used += weight
      }
      if (page.length < HISTORY_READ_PAGE_SIZE) break
    }
    return this.finishHistoryWindow(newestFirst)
  }

  /** 收尾：转 seq 升序，并丢弃窗口首部的孤立 tool 结果行（配对不完整就不给模型看）。 */
  private finishHistoryWindow(newestFirst: StoredMessage[]): StoredMessage[] {
    const ascending = newestFirst.reverse()
    while (ascending.length > 1 && ascending[0].toolCallId !== undefined) ascending.shift()
    return ascending
  }

  /** 会话的下一个 turn 序号（max(turn_index) + 1，首条为 0）。 */
  nextTurnIndex(conversationId: string): number {
    const row = this.stmt(
      'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM messages WHERE conversation_id = ?',
    ).get(conversationId) as { next: number }
    return Number(row.next)
  }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    // usage 解析一次就够：翻一页历史要跑 50 次 JSON.parse，翻两遍纯属白花 CPU。
    const usage = parseUsage(row.usage)
    const artifacts = parseArtifacts(row.artifacts_json)
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
      ...(usage === undefined ? {} : { usage }),
      ...(artifacts === undefined ? {} : { artifacts }),
      createdAt: Number(row.created_at),
    }
  }

  // ---- dispatch events ----

  /** 记录一次群聊调度决策。 */
  recordDispatchEvent(input: Omit<DispatchEvent, 'id' | 'createdAt'>): DispatchEvent {
    const event: DispatchEvent = { id: randomUUID(), createdAt: Date.now(), ...input }
    this.stmt(`
      INSERT INTO dispatch_events (id, conversation_id, from_agent, to_agent, reason, turn_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    const rows = this.stmt('SELECT * FROM dispatch_events WHERE conversation_id = ? ORDER BY rowid').all(
      conversationId,
    ) as Record<string, unknown>[]
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
