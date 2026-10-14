/**
 * 进化子系统 schema 与迁移（evolve_meta 自管版本轴，只追加规则）。
 * @module @ryagent/evolve/schema
 */

import type { DatabaseSync } from 'node:sqlite'

export const EVOLVE_SCHEMA_VERSION = 2

/** playbook 条目的 section 分类。 */
export type PlaybookSection = 'strategy' | 'pitfall' | 'preference' | 'tooling'

/** 条目状态：deprecated 软删（可恢复）。 */
export type EntryStatus = 'active' | 'deprecated'

/** 反思状态：pending 待验证 → converted 转正 / expired 到期清理。 */
export type ReflectionStatus = 'pending' | 'converted' | 'expired'

/**
 * 条目溯源种类（证据链）：
 * - `trajectory`：产生该条目的那一轮对话（Curator add / 改写）。
 * - `reflection`：转正进手册的那条教训。
 * - `feedback`：一次 👍/👎 反馈（refId = feedback_events.id）。
 * - `memory`：巩固时按词面重叠关联上的长期记忆（refId = memories.id）。
 * - `seed`：冷启动模板（refId = 模板 key）。
 */
export type EntryOriginKind = 'trajectory' | 'reflection' | 'feedback' | 'memory' | 'seed'

/** harmful 计数达到该阈值自动 deprecate。 */
export const AUTO_DEPRECATE_HARMFUL = 3

/** 教训转正阈值：注入后验证成功次数 ≥2。 */
export const CONVERT_HIT_THRESHOLD = 2

function migrateV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE playbook_entries (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      section    TEXT NOT NULL CHECK (section IN ('strategy', 'pitfall', 'preference', 'tooling')),
      content    TEXT NOT NULL,
      helpful    INTEGER NOT NULL DEFAULT 0,
      harmful    INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source     TEXT NOT NULL DEFAULT 'curator'   -- curator | reflection | seed | manual
    );
    CREATE INDEX idx_playbook_agent ON playbook_entries (agent_id, status, section);

    CREATE TABLE reflections (
      id                   TEXT PRIMARY KEY,
      agent_id             TEXT NOT NULL,
      lesson               TEXT NOT NULL,
      context_digest       TEXT NOT NULL DEFAULT '',
      source_conversation_id TEXT,
      hit_count            INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'expired')),
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX idx_reflections_agent ON reflections (agent_id, status);

    CREATE TABLE feedback_events (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      turn_index      INTEGER NOT NULL,
      signal          TEXT NOT NULL CHECK (signal IN ('thumb_up', 'thumb_down')),
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE evolve_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

/**
 * 条目溯源（证据链）。UNIQUE(entry_id, kind, ref_id) 让重复记账变成 no-op：
 * 巩固每 6 小时跑一次、反馈可以反复点，没有这层约束 origins 会无限膨胀。
 */
function migrateV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE entry_origins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id   TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('trajectory', 'reflection', 'feedback', 'memory', 'seed')),
      ref_id     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE (entry_id, kind, ref_id)
    );
    CREATE INDEX idx_entry_origins_entry ON entry_origins (entry_id, created_at);
  `)
}

const MIGRATIONS: Readonly<Record<number, (db: DatabaseSync) => void>> = { 1: migrateV1, 2: migrateV2 }

/** 迁移到 EVOLVE_SCHEMA_VERSION；幂等。 */
export function migrateEvolve(db: DatabaseSync): void {
  const probe = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'evolve_meta'")
    .get() as { count: number }
  const current =
    Number(probe.count) === 0
      ? 0
      : Number(
          (
            db.prepare("SELECT value FROM evolve_meta WHERE key = 'schema_version'").get() as
              | { value: string }
              | undefined
          )?.value ?? 0,
        )
  if (current >= EVOLVE_SCHEMA_VERSION) return
  db.exec('BEGIN')
  try {
    for (let version = current + 1; version <= EVOLVE_SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version]
      if (migration === undefined) throw new Error(`@ryagent/evolve: missing migration to version ${version}`)
      migration(db)
    }
    db.prepare(
      "INSERT INTO evolve_meta (key, value) VALUES ('schema_version', ?)" +
        ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(String(EVOLVE_SCHEMA_VERSION))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
