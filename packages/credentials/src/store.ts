/**
 * 凭据**引用**的落盘。
 *
 * 这里存的是引用（id、供应商、名字、末四位），**不是密钥**。密钥归宿主那个加密存储
 * 管（桌面端走系统密钥库）——配置文件里只该出现凭据的名字，这样把配置文件发给别人
 * 也不至于把密钥发出去。
 *
 * 引用要落盘，是因为配置里写着 `credentialId: "gh-main"`，重启之后这个 id 得还对得上
 * 那个引用，否则配置就指向了一个不存在的东西。
 * @module @ryharness/credentials/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CredentialRef } from './types.ts'

/** 落盘的一条引用。 */
export interface CredentialSnapshot {
  /** 引用本身。 */
  readonly ref: CredentialRef
  /** 是不是已经吊销了。 */
  readonly revoked: boolean
}

/** 引用的存取接口：宿主也可以自己实现一份。 */
export interface CredentialStore {
  /** 读出全部引用。 */
  load(): readonly CredentialSnapshot[]
  /** 存下全部引用（整体覆盖）。 */
  save(snapshots: readonly CredentialSnapshot[]): void
}

/** 内存后端：进程活着就有。 */
export class MemoryCredentialStore implements CredentialStore {
  private snapshots: CredentialSnapshot[] = []

  load(): readonly CredentialSnapshot[] {
    return this.snapshots.map((snapshot) => {
      return { ...snapshot, ref: { ...snapshot.ref } }
    })
  }

  save(snapshots: readonly CredentialSnapshot[]): void {
    this.snapshots = snapshots.map((snapshot) => {
      return { ...snapshot, ref: { ...snapshot.ref } }
    })
  }
}

/** 文件后端的构造参数。 */
export interface FileCredentialStoreOptions {
  /** 文件路径（父目录会自动建）。 */
  readonly filePath: string
}

/** 文件里存的东西。 */
interface CredentialFile {
  credentials: CredentialSnapshot[]
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/** 文件后端：一个 JSON 文件装全部引用。 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string

  constructor(options: FileCredentialStoreOptions) {
    this.filePath = options.filePath
  }

  load(): readonly CredentialSnapshot[] {
    if (!existsSync(this.filePath)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      // 半份 JSON 说明上次崩在写入中途：这份数据不可信，当没有引用。
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) return []
    const raw = (parsed as { credentials?: unknown }).credentials
    if (!Array.isArray(raw)) return []
    const out: CredentialSnapshot[] = []
    for (const item of raw) {
      const snapshot = parseSnapshot(item)
      if (snapshot !== undefined) out.push(snapshot)
    }
    return out
  }

  save(snapshots: readonly CredentialSnapshot[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: CredentialFile = {
      credentials: snapshots.map((snapshot) => {
        return { ...snapshot, ref: { ...snapshot.ref } }
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

/** 读一条引用；缺字段就当没有这条。 */
function parseSnapshot(value: unknown): CredentialSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { ref?: unknown; revoked?: unknown }
  const raw = record.ref
  if (typeof raw !== 'object' || raw === null) return undefined
  const ref = raw as { id?: unknown; providerId?: unknown; label?: unknown; hint?: unknown; createdAt?: unknown }
  const id = ref.id
  const providerId = ref.providerId
  const label = ref.label
  const createdAt = ref.createdAt
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof providerId !== 'string' || providerId.length === 0) return undefined
  if (typeof label !== 'string') return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  const hint = ref.hint
  return {
    ref: {
      id,
      providerId,
      label,
      ...(typeof hint === 'string' && hint.length > 0 ? { hint } : {}),
      createdAt,
    },
    revoked: record.revoked === true,
  }
}
