/**
 * 改名那天的数据目录迁移。
 *
 * 产品从 RyAgent 改成 RyHarness 时，数据目录的位置与文件名都跟着变了
 * （`%APPDATA%\RyAgent\ryagent-data\ryagent.db` → `%APPDATA%\RyHarness\
 * ryharness-data\ryharness.db`）。
 *
 * 不迁的话，用户升级后打开应用会发现会话、长期记忆、助理配置全没了——那些数据还
 * 在老目录里躺着，只是没人去读。这是最难查的一类"数据丢了"。
 *
 * 单独成模块是为了能单测：main.ts 一 import 就带进 electron，测试里跑不动，而这段
 * 逻辑恰恰是"用户的数据还在不在"的第一道保障。
 *
 * @module apps/desktop/electron/data-dir
 */

import { join } from 'node:path'

/** 迁移要用的文件系统动作（注入是为了能单测）。 */
export interface DataDirMigrationIo {
  /** 路径是否存在。 */
  exists: (path: string) => boolean
  /** 移动目录。 */
  move: (from: string, to: string) => void
  /** 目录下的文件是否存在。 */
  fileExists: (path: string) => boolean
  /** 重命名文件。 */
  rename: (from: string, to: string) => void
}

/** 一次迁移的结果。 */
export interface DataDirMigrationResult {
  /** 数据目录是否搬过去了。 */
  migrated: boolean
  /** 没搬的原因 / 搬的过程中出的问题。 */
  reason?: string
}

/**
 * 把老版本的数据目录搬到新位置。
 *
 * 只在**新目录不存在**时搬：用户自己建过新目录就说明他不要老数据。
 *
 * 目录里的数据库也要改名：新名字下找不到文件的话，服务端会建一个空库，用户看到的
 * 就是"数据全没了"——那比迁移失败更糟。
 */
export function migrateLegacyDataDir(
  input: {
    /** 新的数据目录（<userData>\ryharness-data）。 */
    dataDir: string
    /** 老的数据目录（%APPDATA%\RyAgent\ryagent-data）。 */
    legacyDataDir: string
  } & DataDirMigrationIo,
): DataDirMigrationResult {
  if (input.exists(input.dataDir)) return { migrated: false, reason: 'new-exists' }
  if (!input.exists(input.legacyDataDir)) return { migrated: false, reason: 'no-legacy' }
  try {
    input.move(input.legacyDataDir, input.dataDir)
  } catch (error) {
    return { migrated: false, reason: `move failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const legacyDb = join(input.dataDir, 'ryagent.db')
  const newDb = join(input.dataDir, 'ryharness.db')
  try {
    if (input.fileExists(legacyDb)) input.rename(legacyDb, newDb)
  } catch (error) {
    return { migrated: true, reason: `db rename failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { migrated: true }
}
