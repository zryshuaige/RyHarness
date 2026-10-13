/**
 * 记忆子系统 schema 与迁移。
 *
 * 与 @ryagent/session 共用同一 SQLite 文件，但版本号不归 PRAGMA user_version
 * 管（那是 session 的演进轴）——本包用 `memory_meta` 表自管版本，同样遵守
 * 只追加迁移的规则。
 * @module @ryagent/memory/schema
 */

import type { DatabaseSync } from 'node:sqlite'

/** 本包 schema 版本（独立于 session 的 SCHEMA_VERSION）。 */
export const MEMORY_SCHEMA_VERSION = 1

/** 共享用户画像空间的 agent_id（写隔离、读共享，调研 §3.6）。 */
export const SHARED_SPACE = '*shared*'

/** 记忆种类。 */
export type MemoryKind = 'profile' | 'fact' | 'preference' | 'event'

/** 记忆状态：UPDATE/DELETE 走 superseded 软删保历史（Zep 思路）。 */
export type MemoryStatus = 'active' | 'superseded' | 'deleted'

/** v1：memories + FTS5 + embedding 缓存。 */
function migrateV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE memories (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,              -- SHARED_SPACE 表示共享用户画像
      kind          TEXT NOT NULL CHECK (kind IN ('profile', 'fact', 'preference', 'event')),
      content       TEXT NOT NULL,
      embedding     BLOB,                       -- Float32Array 小端 BLOB，可空（纯 FTS 降级）
      dim           INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL DEFAULT 0,
      access_count  INTEGER NOT NULL DEFAULT 0,
      source_conversation_id TEXT,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
      supersedes_id TEXT                        -- 本条取代的旧记忆（软删链）
    );
    CREATE INDEX idx_memories_space_status ON memories (agent_id, status, kind);
    CREATE INDEX idx_memories_updated ON memories (updated_at);

    -- 独立 FTS5 表（按 memory_id 关联，手动同步，避免外部内容模式的触发器复杂度）
    CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize = 'unicode61');

    -- embedding 缓存：相同文本不重复请求（hash = sha256(text)）
    CREATE TABLE embedding_cache (
      hash       TEXT PRIMARY KEY,
      vector     BLOB NOT NULL,
      dim        INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE memory_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = { 1: migrateV1 }

function metaVersion(db: DatabaseSync): number {
  // memory_meta 可能不存在（全新库）：用模板表探测。
  const probe = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'memory_meta'")
    .get() as { count: number }
  if (Number(probe.count) === 0) return 0
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  return row === undefined ? 0 : Number(row.value)
}

/** 把记忆库迁移到 MEMORY_SCHEMA_VERSION；幂等，可安全重复调用。 */
export function migrateMemory(db: DatabaseSync): void {
  const current = metaVersion(db)
  if (current >= MEMORY_SCHEMA_VERSION) return
  db.exec('BEGIN')
  try {
    for (let version = current + 1; version <= MEMORY_SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version]
      if (migration === undefined) throw new Error(`@ryagent/memory: missing migration to version ${version}`)
      migration(db)
    }
    db.prepare(
      "INSERT INTO memory_meta (key, value) VALUES ('schema_version', ?)" +
        ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(String(MEMORY_SCHEMA_VERSION))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
