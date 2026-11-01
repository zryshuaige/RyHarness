/**
 * 身份存储：把「这次安装的 id」放在应用数据目录里。
 *
 * 文件里只有两样东西：这个 id，和它生成的时间。没有别的——
 * 塞进来的每一样都是个人信息。
 *
 * 三种操作：
 * - {@link IdentityStore.read}：只读。文件不在就是 `undefined`。
 * - {@link IdentityStore.ensure}：读不到就生成一个并落盘。**同一个安装反复调
 *   拿到的是同一个 id**。
 * - {@link IdentityStore.reset}：把文件删掉，重新生成一个（新的安装视角）。
 *
 * 文件坏了（写了一半、被别的程序改过）当成没有：重新生成一个。
 * 这里放的是关联用的 id，不是要紧的数据——为它拦住整个应用启动不划算。
 * @module @ryharness/identity/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateAnonymousId, isValidAnonymousId } from './id.ts'
import type { IdentityStoreOptions, InstallationIdentity } from './types.ts'

/** id 文件的默认名字。 */
export const IDENTITY_FILE_NAME = 'installation-id.json'

/** 文件里的结构版本。 */
export const IDENTITY_FILE_VERSION = 1

/** 文件里存的东西。 */
interface IdentityFile {
  readonly version: number
  readonly id: string
  readonly createdAt: number
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/** 判断一个值是不是普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 身份存储。
 */
export class IdentityStore {
  private readonly filePath: string
  private readonly newId: () => string
  private readonly now: () => number

  /**
   * @param options - 配置。
   */
  constructor(options: IdentityStoreOptions) {
    this.filePath = join(options.dataDir, options.fileName ?? IDENTITY_FILE_NAME)
    this.newId = options.newId ?? (() => generateAnonymousId())
    this.now = options.now ?? Date.now
  }

  /** id 文件的完整路径。 */
  get path(): string {
    return this.filePath
  }

  /**
   * 读出这次安装的身份。
   *
   * 文件不在、读不出来、或者内容不是一份身份，都给 `undefined`——
   * 「读不到」与「没有」在调用方那里是一回事：都该去 `ensure()` 拿一个。
   * @returns 身份；没有就是 `undefined`。
   */
  read(): InstallationIdentity | undefined {
    if (!existsSync(this.filePath)) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      return undefined
    }
    if (!isPlainObject(parsed)) return undefined
    const id = parsed['id']
    const createdAt = parsed['createdAt']
    if (typeof id !== 'string' || !isValidAnonymousId(id)) return undefined
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
    return { id, createdAt }
  }

  /**
   * 拿到这次安装的身份；没有就生成一个并落盘。
   *
   * 同一个安装反复调，拿到的都是同一个 id（文件在且没坏的情况下）。
   * @returns 这次安装的身份。
   */
  ensure(): InstallationIdentity {
    const existing = this.read()
    if (existing !== undefined) return existing
    const identity: InstallationIdentity = { id: this.newId(), createdAt: this.now() }
    this.write(identity)
    return identity
  }

  /**
   * 删掉 id 文件，重新生成一个。
   *
   * 这是「当作一次全新安装」的操作：旧 id 不再作废（它可能已经发到外面去了），
   * 但本机不再用它。
   * @returns 新的身份。
   */
  reset(): InstallationIdentity {
    rmSync(this.filePath, { force: true })
    const identity: InstallationIdentity = { id: this.newId(), createdAt: this.now() }
    this.write(identity)
    return identity
  }

  /**
   * 把身份写进文件。
   *
   * 原子写：先写同目录临时文件，再 rename 覆盖目标。崩在写一半时留下的
   * 不是半份 JSON，而是一份完整的旧数据。
   */
  private write(identity: InstallationIdentity): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: IdentityFile = {
      version: IDENTITY_FILE_VERSION,
      id: identity.id,
      createdAt: identity.createdAt,
    }
    const tmp = `${this.filePath}.${process.pid}.${tempSeq++}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.filePath)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
      }
      throw error
    }
  }
}
