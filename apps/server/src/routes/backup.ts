/**
 * 备份路由：一键把整库导出成独立的 SQLite 文件。
 *
 * 全部会话、长期记忆与进化数据共享一个 ryharness.db，README 却只说「升级前请
 * 备份」而不给工具——用户只能去文件管理器里碰运气。这里把 VACUUM INTO 包成
 * 一个 POST：导出文件落在 dataDir/backups 内（不许写到外面），按时间戳命名，
 * 保留最近 10 份。
 * @module @ryharness/server/routes/backup
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionStore } from '@ryharness/session'
import { json, type Router } from '../router.ts'

/** 手动备份的保留份数：够回溯最近的几次误操作，又不至于吃满磁盘。 */
export const BACKUPS_KEPT = 10

/** 备份文件名：ryharness-<yyyymmdd-hhmmss>.db（固定宽度，按名字排序即按时间排序）。 */
export function backupFileName(now = new Date()): string {
  const pad = (value: number): string => {
    return String(value).padStart(2, '0')
  }
  const stamp = [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('-')
  return `ryharness-${stamp}.db`
}

/** 挑出目录里的备份文件名。 */
function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      return /^ryharness-\d{8}-\d{6}(-\d+)?\.db$/.test(name)
    })
  } catch {
    return []
  }
}

/**
 * 淘汰旧备份：按修改时间删最旧，只留最近 keep 份。
 *
 * 不能按名字排——同一秒连点会产生 `-1/-2` 序号后缀，字典序与创建顺序不一致
 * （`-10` 排在 `-2` 前面），按名字删会删错份。stat 不到的按「最新」处理：
 * 宁可多留一份，不冒删掉未知文件的风险。
 */
function pruneBackups(dir: string, keep: number): void {
  const ranked = listBackups(dir)
    .map((name) => {
      try {
        return { name, at: statSync(join(dir, name)).mtimeMs }
      } catch {
        return { name, at: Number.POSITIVE_INFINITY }
      }
    })
    .sort((a, b) => {
      return a.at - b.at || (a.name < b.name ? -1 : 1)
    })
  for (const item of ranked.slice(0, Math.max(0, ranked.length - keep))) {
    try {
      rmSync(join(dir, item.name))
    } catch {
      // Windows 句柄滞后删不掉就留着，下一轮备份再删。
    }
  }
}

/** 备份路由的依赖。 */
export interface BackupRoutes {
  dataDir: string
  store: SessionStore
}

/** 注册备份路由（鉴权由 app 层的 token 中间件统一把关，这里不再重复）。 */
export function registerBackupRoutes(router: Router, deps: BackupRoutes): void {
  router.post('/api/backup', async (_req, res) => {
    const dir = join(deps.dataDir, 'backups')
    mkdirSync(dir, { recursive: true })
    // 同一秒连点：VACUUM INTO 拒绝覆盖已有文件，加序号避开而不是失败。
    const base = backupFileName()
    let target = join(dir, base)
    for (let n = 1; existsSync(target); n++) {
      target = join(dir, base.replace(/\.db$/, `-${n}.db`))
    }
    // 整个数据库文件（会话+记忆+进化）一份即全部；失败原样抛给 app 层回 500。
    deps.store.backupTo(target)
    pruneBackups(dir, BACKUPS_KEPT)
    json(res, 200, { path: target })
  })
}
