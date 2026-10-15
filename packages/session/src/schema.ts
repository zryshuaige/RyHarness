/**
 * SQLite 模式与迁移。
 *
 * 沿用 dsh 的持久化演进规则：`SCHEMA_VERSION` 单调递增，只新增新版本迁移，
 * 永不修改或删除已发布的迁移函数；每个迁移把库从版本 N-1 带到 N。
 * 版本号存 SQLite 的 `user_version` pragma。
 * @module @ryagent/session/schema
 */

import type { DatabaseSync } from 'node:sqlite'
import { bigrams, messageSearchText } from './fts.ts'

/** 当前 schema 版本；每次变更表结构时 +1 并追加迁移函数。 */
export const SCHEMA_VERSION = 6

/** 版本 1：初始表结构。 */
function migrateV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      avatar        TEXT,
      system_prompt TEXT NOT NULL,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      temperature   REAL,
      tools         TEXT NOT NULL DEFAULT '[]',
      is_builtin    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE conversations (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
      title               TEXT NOT NULL DEFAULT '',
      member_agent_ids    TEXT NOT NULL DEFAULT '[]',
      dispatcher_agent_id TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX idx_conversations_updated_at ON conversations (updated_at DESC);

    CREATE TABLE messages (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      sender_type     TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
      sender_id       TEXT,
      content_blocks  TEXT NOT NULL DEFAULT '[]',
      mentions        TEXT NOT NULL DEFAULT '[]',
      turn_index      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_conversation_seq ON messages (conversation_id, seq);

    CREATE TABLE dispatch_events (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      from_agent      TEXT,
      to_agent        TEXT NOT NULL,
      reason          TEXT NOT NULL DEFAULT '',
      turn_index      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_dispatch_conversation ON dispatch_events (conversation_id, created_at);
  `)
}

/** 版本 2：messages 增加 tool_call_id——AgentLoop 的工具结果消息需要带回 callId 才能重建多轮请求历史。 */
function migrateV2(db: DatabaseSync): void {
  db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT')
}

/** 版本 3：conversations 增加 last_read_seq——未读徽标语义（用户已读到的消息序号）。 */
function migrateV3(db: DatabaseSync): void {
  db.exec('ALTER TABLE conversations ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0')
}

/**
 * 版本 4：messages 增加 usage 列——token 用量随消息落库（此前 llm 层已产出
 * usage，全仓无消费者，成本不可见）。存 JSON：字段随供应商演进，查询用
 * json_extract 做会话级求和。
 */
function migrateV4(db: DatabaseSync): void {
  db.exec('ALTER TABLE messages ADD COLUMN usage TEXT')
}

/**
 * 版本 5：messages_fts —— 消息正文的 FTS5 索引（与记忆侧同一套 bigram 分词）。
 *
 * 正文存在 content_blocks 的 JSON 里，不可索引，于是关键词搜索只能把整库消息
 * 分页拉进内存做子串匹配（每条都要 JSON.parse），会话一多就是全库同步扫描。
 * 索引行以 messages.seq（rowid 别名）为键，存储层在写消息时同步维护、删会话时
 * 同步清理；存量消息在这次迁移里一次性补齐。
 */
function migrateV5(db: DatabaseSync): void {
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize = 'unicode61')")
  const rows = db.prepare('SELECT seq, content_blocks FROM messages').all() as {
    seq: number
    content_blocks: string
  }[]
  const insert = db.prepare('INSERT INTO messages_fts (rowid, content) VALUES (?, ?)')
  for (const row of rows) {
    const text = messageSearchText(parseBlocks(row.content_blocks))
    // 纯工具结果消息没有文本块，不占索引行（与写入路径同一口径）。
    if (text.length === 0) continue
    insert.run(Number(row.seq), bigrams(text))
  }
}

/**
 * 版本 6：agents 增加 persona 列——性格四维、生日、口头禅、形象、音色、亲密度。
 *
 * 一列 JSON 而不是十几个标量：人格是一个整体（读出来要么是它、要么是默认值），
 * 且字段还会长（新增维度不该再写一次 ALTER TABLE）。存量行 persona 为 NULL，
 * 存储层按 {@link PERSONA_DEFAULTS} 补齐——旧 agent 打开即有默认人格，不必回填。
 */
function migrateV6(db: DatabaseSync): void {
  db.exec('ALTER TABLE agents ADD COLUMN persona TEXT')
}

/** 迁移里解析 content_blocks（脏数据按空数组处理，不让一条坏行废掉迁移）。 */
function parseBlocks(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 全部迁移：索引即目标版本。新增迁移只追加，不改动既有条目。 */
export const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = {
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
  5: migrateV5,
  6: migrateV6,
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/**
 * 把库迁移到 {@link SCHEMA_VERSION}。已有数据跳过对应迁移；
 * 缺失的迁移在单事务里依次应用，任一失败整体回滚。
 * @param db - 打开的数据库。
 */
export function migrate(db: DatabaseSync): void {
  const current = userVersion(db)
  if (current === SCHEMA_VERSION) return
  if (current > SCHEMA_VERSION) {
    throw new Error(`@ryagent/session: database schema version ${current} is newer than supported ${SCHEMA_VERSION}`)
  }
  db.exec('BEGIN')
  try {
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version]
      if (migration === undefined) throw new Error(`@ryagent/session: missing migration to version ${version}`)
      migration(db)
      db.exec(`PRAGMA user_version = ${version}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
