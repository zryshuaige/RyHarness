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
export const MEMORY_SCHEMA_VERSION = 4

/** 共享用户画像空间的 agent_id（写隔离、读共享，调研 §3.6）。 */
export const SHARED_SPACE = '*shared*'

/** 记忆种类。 */
export type MemoryKind = 'profile' | 'fact' | 'preference' | 'event'

/**
 * 记忆状态：
 * - active：参与检索与注入；
 * - superseded / deleted：软删（保留历史，用户可见）；
 * - inactive：巩固任务对长期零访问记忆的归档（不参与检索，也不物理删除）。
 */
export type MemoryStatus = 'active' | 'superseded' | 'deleted' | 'inactive'

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

/**
 * v2：embedding 向量带模型溯源。
 * 换 embedding 模型后，同一段文本的旧向量与新向量语义空间不同，混在一起
 * 会让维度不符的余弦静默返回 -1。缓存主键改为 (hash, model)，记忆行记录
 * 向量来源模型；旧缓存行以 model='' 保留（永不命中新模型，按未命中重算）。
 */
function migrateV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE embedding_cache_v2 (
      hash       TEXT NOT NULL,
      model      TEXT NOT NULL,
      vector     BLOB NOT NULL,
      dim        INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (hash, model)
    );
    INSERT INTO embedding_cache_v2 (hash, model, vector, dim, created_at)
      SELECT hash, '', vector, dim, created_at FROM embedding_cache;
    DROP TABLE embedding_cache;
    ALTER TABLE embedding_cache_v2 RENAME TO embedding_cache;

    ALTER TABLE memories ADD COLUMN embedding_model TEXT;
  `)
}

/**
 * v3：状态机加入 'inactive'（巩固归档位）。SQLite 的 CHECK 约束只能随表
 * 重建而改：新建表 → 拷贝 → 删旧表 → 改名 → 重建索引（数据零丢失）。
 */
function migrateV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE memories_v3 (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('profile', 'fact', 'preference', 'event')),
      content       TEXT NOT NULL,
      embedding     BLOB,
      dim           INTEGER,
      embedding_model TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL DEFAULT 0,
      access_count  INTEGER NOT NULL DEFAULT 0,
      source_conversation_id TEXT,
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'superseded', 'deleted', 'inactive')),
      supersedes_id TEXT
    );
    INSERT INTO memories_v3 (id, agent_id, kind, content, embedding, dim, embedding_model, created_at,
                             updated_at, last_accessed_at, access_count, source_conversation_id, status,
                             supersedes_id)
      SELECT id, agent_id, kind, content, embedding, dim, embedding_model, created_at, updated_at,
             last_accessed_at, access_count, source_conversation_id, status, supersedes_id
      FROM memories;
    DROP TABLE memories;
    ALTER TABLE memories_v3 RENAME TO memories;
    CREATE INDEX idx_memories_space_status ON memories (agent_id, status, kind);
    CREATE INDEX idx_memories_updated ON memories (updated_at);
  `)
}

/**
 * v4：把非 active 记忆的历史残留清出 FTS 索引。
 *
 * 归档（inactive）与软删（superseded/deleted）此前只改 status，FTS 行留着：
 * 检索时逐行过滤掉，BM25 候选窗口（limit*3）被死行吃光，召回质量随时间单调
 * 退化。存量库一次性清干净，之后由存储层在归档时同步删除（restore 时重建，
 * 遵守 rowid 唯一约束）。
 */
function migrateV4(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM memories_fts WHERE rowid IN (
      SELECT rowid FROM memories WHERE status != 'active'
    );
  `)
}

export const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = {
  1: migrateV1,
  2: migrateV2,
  3: migrateV3,
  4: migrateV4,
}

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
