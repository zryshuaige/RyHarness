/**
 * 配置的落盘。
 *
 * 改过的设置必须**重启后还在**，否则设置页就是个摆设：用户填了一遍，关掉应用再打开，
 * 又得从头填。所以本包带一个文件后端。
 *
 * 落盘的是**明文的配置值**（超时几秒、要不要开日志），不是密钥——插件的密钥归宿主
 * 那个 `SecretCodec` 管（系统密钥库加密），这一层不碰。
 *
 * 写入走「临时文件 + rename」：崩在写一半时留下的不是半份 JSON，而是一份完整的旧
 * 数据。
 * @module @ryharness/settings/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SettingsValues } from './types.ts'

/** 落盘的一份状态：一个插件的配置与版本号。 */
export interface SettingsSnapshot {
  /** 插件 id。 */
  readonly pluginId: string
  /** 当前值。 */
  readonly values: SettingsValues
  /** 版本号。 */
  readonly revision: number
}

/** 配置的存取接口：宿主也可以自己实现一份（存数据库、存远端）。 */
export interface SettingsStore {
  /** 读出全部状态。 */
  load(): readonly SettingsSnapshot[]
  /** 存下全部状态（整体覆盖）。 */
  save(snapshots: readonly SettingsSnapshot[]): void
}

/** 内存后端：进程活着就有，进程死了就没（测试与临时用法）。 */
export class MemorySettingsStore implements SettingsStore {
  private snapshots: SettingsSnapshot[] = []

  load(): readonly SettingsSnapshot[] {
    return this.snapshots.map((snapshot) => {
      return { ...snapshot, values: { ...snapshot.values } }
    })
  }

  save(snapshots: readonly SettingsSnapshot[]): void {
    this.snapshots = snapshots.map((snapshot) => {
      return { ...snapshot, values: { ...snapshot.values } }
    })
  }
}

/** 文件后端的构造参数。 */
export interface FileSettingsStoreOptions {
  /** 文件路径（父目录会自动建）。 */
  readonly filePath: string
}

/** 文件里存的东西。 */
interface SettingsFile {
  plugins: SettingsSnapshot[]
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/** 文件后端：一个 JSON 文件装全部插件的配置。 */
export class FileSettingsStore implements SettingsStore {
  private readonly filePath: string

  constructor(options: FileSettingsStoreOptions) {
    this.filePath = options.filePath
  }

  load(): readonly SettingsSnapshot[] {
    if (!existsSync(this.filePath)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      // 半份 JSON 说明上次崩在写入中途：这份数据不可信，当没有配置。
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const raw = (parsed as { plugins?: unknown }).plugins
    if (!Array.isArray(raw)) return []
    const out: SettingsSnapshot[] = []
    for (const item of raw) {
      const snapshot = parseSnapshot(item)
      if (snapshot !== undefined) out.push(snapshot)
    }
    return out
  }

  save(snapshots: readonly SettingsSnapshot[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: SettingsFile = {
      plugins: snapshots.map((snapshot) => {
        return { ...snapshot, values: { ...snapshot.values } }
      }),
    }
    const tmp = `${this.filePath}.${process.pid}.${tempSeq++}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
      }
      throw error
    }
  }
}

/** 读一条状态；缺字段就当没有这条。 */
function parseSnapshot(value: unknown): SettingsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { pluginId?: unknown; revision?: unknown; values?: unknown }
  const pluginId = record.pluginId
  const revision = record.revision
  const values = record.values
  if (typeof pluginId !== 'string' || pluginId.length === 0) return undefined
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return undefined
  if (typeof values !== 'object' || values === null) return undefined
  const out: SettingsValues = {}
  for (const [key, item] of Object.entries(values)) {
    if (typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') out[key] = item
  }
  return { pluginId, values: out, revision }
}
