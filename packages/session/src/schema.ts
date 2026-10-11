/**
 * SQLite 模式与迁移。
 *
 * 沿用 dsh 的持久化演进规则：`SCHEMA_VERSION` 单调递增，只新增新版本迁移，
 * 永不修改或删除已发布的迁移函数；每个迁移把库从版本 N-1 带到 N。
 * 版本号存 SQLite 的 `user_version` pragma。
 * @module @ryagent/session/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** 当前 schema 版本；每次变更表结构时 +1 并追加迁移函数。 */
export const SCHEMA_VERSION = 1

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

/** 全部迁移：索引即目标版本。新增迁移只追加，不改动既有条目。 */
export const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = {
  1: migrateV1,
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
