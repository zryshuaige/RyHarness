/**
 * 配置的存储后端：落进 `@ryharness/storage` 的统一后端。
 *
 * ## 为什么不是自己写一份文件
 *
 * 插件配置、应用偏好、工作区清单、文档转换索引……这些数据每一种都自己写一套
 * 文件后端，意味着：落盘格式各不一样、出问题没地方统一查、备份要分别备份。
 *
 * 这一层把配置**摊在 storage 的记录模型上**：每个插件一条记录，插件 id 就是
 * 记录 id。于是配置与应用里的其它数据住在同一套后端里，同一份备份、同一个
 * 目录、同一种损坏处理。
 *
 * ## 与 {@link FileSettingsStore} 的关系
 *
 * 老的文件后端**保留**：它在磁盘上写一份人能直接打开的 JSON（`plugins: [...]`），
 * 排障时看得懂。新后端写的是 storage 的记录格式（一条记录一个文件）。
 *
 * **迁移**：{@link MigratingSettingsStore} 会先读老文件，读到就搬进新后端，
 * 搬完把老文件改名留底（不删——删用户数据这件事不能顺手做）。老文件不在时
 * 直接用新后端。
 *
 * @module @ryharness/settings/storage-store
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import type { StorageService } from '@ryharness/storage'
import type { SettingsSnapshot, SettingsStore } from './store.ts'
import type { SettingsValues } from './types.ts'

/** 配置在 storage 里的分组名。 */
export const SETTINGS_KIND = 'plugin-settings'

/** 存一份配置时记的内容。 */
interface SettingsRecordData {
  readonly values: SettingsValues
  readonly revision: number
}

/**
 * 把 storage 后端当配置的存储用。
 *
 * 每个插件一条记录：记录 id 是插件 id，内容是「值 + 版本号」。
 */
export class StorageSettingsStore implements SettingsStore {
  readonly #service: StorageService
  readonly #kind: string

  constructor(service: StorageService, kind: string = SETTINGS_KIND) {
    this.#service = service
    this.#kind = kind
  }

  /** 读出全部状态。 */
  load(): readonly SettingsSnapshot[] {
    const snapshots: SettingsSnapshot[] = []
    for (const record of this.#service.list<SettingsRecordData>(this.#kind)) {
      const data = record.data
      if (data === undefined || data === null || typeof data !== 'object') continue
      if (typeof data.revision !== 'number' || !Number.isFinite(data.revision)) continue
      const values = data.values
      if (typeof values !== 'object' || values === null) continue
      const clean: SettingsValues = {}
      for (const [key, item] of Object.entries(values)) {
        if (typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') clean[key] = item
      }
      snapshots.push({ pluginId: record.id, values: clean, revision: data.revision })
    }
    return snapshots
  }

  /** 存下全部状态（整体覆盖）。 */
  save(snapshots: readonly SettingsSnapshot[]): void {
    // 先删掉这批里没有的：整体覆盖的语义就是「现在只有这些」。
    const keep = new Set(snapshots.map((snapshot) => snapshot.pluginId))
    for (const record of this.#service.list(this.#kind)) {
      if (!keep.has(record.id)) this.#service.remove(this.#kind, record.id)
    }
    for (const snapshot of snapshots) {
      this.#service.put<SettingsRecordData>(this.#kind, snapshot.pluginId, {
        values: { ...snapshot.values },
        revision: snapshot.revision,
      })
    }
  }
}

/** 迁移用的存储后端的构造参数。 */
export interface MigratingSettingsStoreOptions {
  /** 新后端（storage）。 */
  readonly target: SettingsStore
  /** 老文件路径；文件不在就当没有。 */
  readonly legacyFilePath?: string
}

/**
 * 从老文件迁移到新后端的存储。
 *
 * **只在新后端还是空的时候搬**：新后端里已经有数据说明用户已经在用新版了，
 * 这时再把老文件盖上去等于把用户改过的配置冲掉。
 *
 * 搬完把老文件**改名留底**（`plugin-settings.json.migrated`），不删——删用户
 * 数据这件事不该顺手做，出问题时要能翻回去。
 */
export class MigratingSettingsStore implements SettingsStore {
  readonly #target: SettingsStore
  readonly #legacyFilePath: string | undefined

  constructor(options: MigratingSettingsStoreOptions) {
    this.#target = options.target
    this.#legacyFilePath = options.legacyFilePath
  }

  /** 读出全部状态（顺带做一次迁移）。 */
  load(): readonly SettingsSnapshot[] {
    const current = this.#target.load()
    if (current.length > 0) return current
    const legacy = this.#readLegacy()
    if (legacy === undefined) return current
    try {
      this.#target.save(legacy)
      this.#archiveLegacy()
    } catch {
      // 搬不动就当没搬：新后端仍然是空的，下次启动再试一次。
      return current
    }
    return legacy
  }

  /** 存下全部状态。 */
  save(snapshots: readonly SettingsSnapshot[]): void {
    this.#target.save(snapshots)
  }

  /** 读老文件；不在或读不出来都是 undefined。 */
  #readLegacy(): readonly SettingsSnapshot[] | undefined {
    const path = this.#legacyFilePath
    if (path === undefined || !existsSync(path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const raw = (parsed as { plugins?: unknown }).plugins
      if (!Array.isArray(raw)) return undefined
      const snapshots: SettingsSnapshot[] = []
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as { pluginId?: unknown; revision?: unknown; values?: unknown }
        if (typeof record.pluginId !== 'string' || record.pluginId.length === 0) continue
        if (typeof record.revision !== 'number' || !Number.isFinite(record.revision)) continue
        if (typeof record.values !== 'object' || record.values === null) continue
        const values: SettingsValues = {}
        for (const [key, value] of Object.entries(record.values)) {
          if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') values[key] = value
        }
        snapshots.push({ pluginId: record.pluginId, values, revision: record.revision })
      }
      return snapshots
    } catch {
      return undefined
    }
  }

  /** 把老文件改名留底。 */
  #archiveLegacy(): void {
    const path = this.#legacyFilePath
    if (path === undefined || !existsSync(path)) return
    try {
      renameSync(path, `${path}.migrated`)
    } catch {
      // 改不了名就留着原文件：下次启动会因为「新后端非空」而不再搬它。
    }
  }
}
