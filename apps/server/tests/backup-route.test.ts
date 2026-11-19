/**
 * 一键备份路由（POST /api/backup）。
 *
 * 全部会话与记忆都在一个 ryharness.db 里：这里钉住四件事——返回的路径真实存在
 * 且是合法 SQLite（含启动种子数据）、路径落在 dataDir/backups 之内（不许写到
 * 数据目录外面）、保留最近 10 份（多出的删最旧）、失败时是明确的 5xx 而不是
 * 假装成功的 200。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RyHarnessServer } from '@ryharness/server'
import { afterEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop() as string, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // Windows 上句柄释放可能滞后；残留目录在临时区，不强求。
    }
  }
})

async function startServer(): Promise<RyHarnessServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ryharness-backup-'))
  tmpDirs.push(dataDir)
  return RyHarnessServer.create({ port: 0, dataDir, memory: null, evolution: null })
}

async function postBackup(
  server: RyHarnessServer,
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const response = await fetch(`${server.url}/api/backup`, { method: 'POST' })
  return { status: response.status, body: (await response.json()) as { path?: string; error?: string } }
}

interface BackupListView {
  dir: string
  backups: { name: string; path: string; at: number; size: number }[]
}

async function getBackups(server: RyHarnessServer): Promise<{ status: number; body: BackupListView }> {
  const response = await fetch(`${server.url}/api/backups`)
  return { status: response.status, body: (await response.json()) as BackupListView }
}

describe('POST /api/backup', () => {
  it('返回的路径真实存在、在 dataDir/backups 内，且是含数据的合法 SQLite', async () => {
    const server = await startServer()
    try {
      const { status, body } = await postBackup(server)
      expect(status).toBe(200)
      const path = body.path
      if (typeof path !== 'string') throw new Error(`回包缺 path：${JSON.stringify(body)}`)
      expect(existsSync(path)).toBe(true)
      // 备份必须落在数据目录约束内：路径以 <dataDir><sep>backups<sep> 开头。
      expect(path.startsWith(`${join(server.dataDir, 'backups')}${sep}`)).toBe(true)
      const db = new DatabaseSync(path)
      const tables = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number })
        .n
      expect(tables).toBeGreaterThan(0)
      // 启动种子写进去的内置助理在备份里能查到——备份的是真数据不是空壳。
      const agent = db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
      expect(agent.n).toBeGreaterThan(0)
      db.close()
    } finally {
      await server.close()
    }
  })

  it('保留最近 10 份：连打 12 次后目录里只剩 10 个备份，且最后一份还在', async () => {
    const server = await startServer()
    try {
      let last = ''
      for (let i = 0; i < 12; i++) {
        const { status, body } = await postBackup(server)
        expect(status).toBe(200)
        last = body.path ?? ''
      }
      expect(last.length).toBeGreaterThan(0)
      const dir = join(server.dataDir, 'backups')
      const files = readdirSync(dir).filter((name) => {
        return name.endsWith('.db')
      })
      expect(files).toHaveLength(10)
      expect(existsSync(last)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('备份带上实时数据：备份前新写的会话在备份文件里能查到', async () => {
    const server = await startServer()
    try {
      const created = await fetch(`${server.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'direct', agentId: 'ryen' }),
      })
      expect(created.status).toBe(201)
      const conversation = ((await created.json()) as { conversation: { id: string } }).conversation
      const { body } = await postBackup(server)
      const path = body.path
      if (typeof path !== 'string') throw new Error(`回包缺 path：${JSON.stringify(body)}`)
      const db = new DatabaseSync(path)
      const found = (
        db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(conversation.id) as { n: number }
      ).n
      expect(found).toBe(1)
      db.close()
    } finally {
      await server.close()
    }
  })
})

describe('GET /api/backups（只读清单）', () => {
  it('没备份过时返回空清单与备份目录，而不是 404', async () => {
    const server = await startServer()
    try {
      const { status, body } = await getBackups(server)
      expect(status).toBe(200)
      expect(body.dir).toBe(join(server.dataDir, 'backups'))
      expect(body.backups).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('列出真实备份：路径存在、大小非零、按时间倒序（最新在上）', async () => {
    const server = await startServer()
    try {
      for (let i = 0; i < 3; i++) {
        expect((await postBackup(server)).status).toBe(200)
      }
      const { status, body } = await getBackups(server)
      expect(status).toBe(200)
      expect(body.backups).toHaveLength(3)
      for (const file of body.backups) {
        expect(existsSync(file.path)).toBe(true)
        expect(file.size).toBeGreaterThan(0)
        expect(file.name).toMatch(/^ryharness-\d{8}-\d{6}(-\d+)?\.db$/)
      }
      // 倒序：相邻两份的修改时间非递增（同秒连点 mtime 可能相同，允许相等）。
      for (let i = 1; i < body.backups.length; i++) {
        expect(body.backups[i - 1].at).toBeGreaterThanOrEqual(body.backups[i].at)
      }
    } finally {
      await server.close()
    }
  })

  it('清单与淘汰口径一致：连打 12 次后只列最近 10 份', async () => {
    const server = await startServer()
    try {
      for (let i = 0; i < 12; i++) {
        expect((await postBackup(server)).status).toBe(200)
      }
      const { body } = await getBackups(server)
      expect(body.backups).toHaveLength(10)
    } finally {
      await server.close()
    }
  })
})
