/**
 * 迁移前快照（构造函数里的 VACUUM INTO）与整库备份（SessionStore.backupTo）。
 *
 * 迁移是就地单事务，全部会话与记忆都在一个文件里：升级写坏等于全量丢失。这里
 * 钉住三件事——真升级前快照确实落盘且数据完好、快照份数有上限（否则升级次数
 * 积累成日志目录）、快照失败不把「升级」变成「打不开」。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentInput } from '@ryharness/session'
import { MIGRATIONS, SCHEMA_VERSION, SessionStore } from '@ryharness/session'
import { describe, expect, it } from 'vitest'

/** 造一个停在第 version 版的旧库（迁移逐步跑到 v，再写一条 agent 数据）。 */
function makeOldDb(path: string, version: number): void {
  const db = new DatabaseSync(path)
  for (let v = 1; v <= version; v++) {
    const migration = MIGRATIONS[v]
    if (migration !== undefined) migration(db)
  }
  db.exec(`PRAGMA user_version = ${version}`)
  db.exec(`
    INSERT INTO agents (id, name, system_prompt, provider, model, tools, is_builtin, created_at, updated_at)
    VALUES ('a1', '旧助理', '系统提示', 'siliconflow', 'm', '[]', 0, 1, 1)
  `)
  db.close()
}

const agent: AgentInput = {
  id: 'a1',
  name: 'a1',
  systemPrompt: '你是测试 agent。',
  provider: 'siliconflow',
  model: 'm',
  tools: [],
}

describe('迁移前快照', () => {
  it('真升级前先落一份旧版快照，升级后数据仍在；再次打开不重复快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-snap-'))
    const dbPath = join(dir, 'ryharness.db')
    try {
      makeOldDb(dbPath, 1)
      const snapshot = `${dbPath}.pre-migrate-v1.db`
      const store = new SessionStore(dbPath)
      expect(existsSync(snapshot)).toBe(true)
      // 升级照常完成，旧数据保留。
      expect(store.schemaVersion).toBe(SCHEMA_VERSION)
      expect(store.getAgent('a1')?.name).toBe('旧助理')
      store.close()
      // 快照是合法 SQLite，且停在旧版本、带着升级前的数据。
      const snap = new DatabaseSync(snapshot)
      expect((snap.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
      expect((snap.prepare("SELECT name FROM agents WHERE id = 'a1'").get() as { name: string }).name).toBe('旧助理')
      snap.close()
      // 库已是最新版本：再打开不再快照（也不会撞同名目标）。
      const again = new SessionStore(dbPath)
      again.close()
      expect(existsSync(`${dbPath}.pre-migrate-v${SCHEMA_VERSION}.db`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('快照按版本号保留最近 3 份，多出来的删最旧', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-snap-'))
    const dbPath = join(dir, 'ryharness.db')
    try {
      makeOldDb(dbPath, 6)
      // 预置三份更早的快照（内容无所谓，淘汰只看名字）。
      for (const version of [2, 3, 5]) {
        writeFileSync(`${dbPath}.pre-migrate-v${version}.db`, '')
      }
      new SessionStore(dbPath).close()
      // 本次升级产生 v6 快照，共 4 份 → 保留 v3/v5/v6，删掉最旧的 v2。
      expect(existsSync(`${dbPath}.pre-migrate-v2.db`)).toBe(false)
      expect(existsSync(`${dbPath}.pre-migrate-v3.db`)).toBe(true)
      expect(existsSync(`${dbPath}.pre-migrate-v5.db`)).toBe(true)
      expect(existsSync(`${dbPath}.pre-migrate-v6.db`)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('全新库（user_version=0）与 :memory: 不快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-snap-'))
    const dbPath = join(dir, 'ryharness.db')
    try {
      new SessionStore(dbPath).close()
      expect(existsSync(`${dbPath}.pre-migrate-v0.db`)).toBe(false)
      new SessionStore(':memory:').close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('快照失败不阻塞迁移：库照样升到最新并可用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-snap-'))
    const dbPath = join(dir, 'ryharness.db')
    try {
      makeOldDb(dbPath, 1)
      // 把快照目标位置占成一个目录：VACUUM INTO 必然失败。
      mkdirSync(`${dbPath}.pre-migrate-v1.db`)
      const store = new SessionStore(dbPath)
      expect(store.schemaVersion).toBe(SCHEMA_VERSION)
      expect(store.getAgent('a1')?.name).toBe('旧助理')
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('backupTo', () => {
  it('VACUUM 出一份合法 SQLite，含写入后的数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-backup-'))
    const dbPath = join(dir, 'ryharness.db')
    try {
      const store = new SessionStore(dbPath)
      store.upsertAgent(agent)
      const target = join(dir, 'manual-backup.db')
      expect(store.backupTo(target)).toBe(target)
      expect(existsSync(target)).toBe(true)
      const copy = new DatabaseSync(target)
      const tables = copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
      expect(tables.n).toBeGreaterThan(0)
      expect((copy.prepare("SELECT name FROM agents WHERE id = 'a1'").get() as { name: string }).name).toBe('a1')
      copy.close()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('目标已存在时拒绝覆盖（备份不该悄悄顶掉旧备份）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ryharness-backup-'))
    try {
      const store = new SessionStore(':memory:')
      const target = join(dir, 'exists.db')
      expect(store.backupTo(target)).toBe(target)
      expect(() => {
        store.backupTo(target)
      }).toThrow()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
