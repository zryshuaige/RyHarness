/**
 * 工作区记录的落盘：一个 JSON 文件装全部工作区与会话归属。
 *
 * 为什么是一份文件而不是「一个工作区一个文件」：工作区是**人的项目量级**
 * （几十个），整份读写比维护一堆小文件省心，也不会出现「目录里堆了几百个文件」
 * 这种没人愿意收拾的场面。
 *
 * 写入走「临时文件 + rename」：崩在写一半时留下的不是半份 JSON，
 * 而是一份完整的旧数据。
 *
 * 读的时候坏数据**不挡启动也不当没有**：整份文件坏掉就抛
 * {@link WorkspaceStoreError}，因为工作区列表是用户攒下来的东西，
 * 悄悄当成空列表等于把他们的项目全弄没了——得让人先看一眼现场。
 * @module @ryharness/workspace/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WorkspaceStoreError } from './errors.ts'
import type { SessionPlacement, Workspace } from './types.ts'

/** 文件里的版本号。以后改结构时靠它认旧数据。 */
export const WORKSPACE_FILE_VERSION = 1

/** 文件里存的东西。 */
export interface WorkspaceFile {
  /** 结构版本。 */
  readonly version: number
  /** 全部工作区，按建立顺序排。 */
  readonly workspaces: Workspace[]
  /** 会话归属：会话 id → 归属。 */
  readonly sessions: Record<string, SessionPlacement>
}

/** 临时文件序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/** 判断一个值是不是普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一条工作区记录；缺字段就当没有这条。
 *
 * 逐条丢而不是整份丢：一个人一个项目坏掉，不该让别的项目也没了。
 */
function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isPlainObject(value)) return undefined
  const id = value['id']
  const name = value['name']
  const rootPath = value['rootPath']
  const createdAt = value['createdAt']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof rootPath !== 'string' || rootPath.length === 0) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  return { id, name, rootPath, createdAt }
}

/** 读一条会话归属；缺字段就当没有这条。 */
function parsePlacement(value: unknown): SessionPlacement | undefined {
  if (!isPlainObject(value)) return undefined
  const workspaceId = value['workspaceId']
  const hidden = value['hidden']
  if (workspaceId === null) return { workspaceId: null, hidden: hidden === true }
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined
  return { workspaceId, hidden: hidden === true }
}

/**
 * 工作区记录的存储。
 *
 * 不给路径就只在内存里：进程退出就没了（测试与一次性脚本用）。
 */
export class WorkspaceStore {
  private readonly filePath: string | undefined

  /**
   * @param options - 配置。
   */
  constructor(options: { readonly filePath?: string } = {}) {
    this.filePath = options.filePath
  }

  /** 存储落地的路径；内存存储没有路径。 */
  get path(): string | undefined {
    return this.filePath
  }

  /**
   * 读出全部记录。
   *
   * 文件不存在时给空记录（还没建过工作区是正常状态，不是坏数据）。
   * @returns 工作区与会话归属。
   * @throws WorkspaceStoreError - 文件在但读不出来时。
   */
  load(): WorkspaceFile {
    const filePath = this.filePath
    if (filePath === undefined) return { version: WORKSPACE_FILE_VERSION, workspaces: [], sessions: {} }
    if (!existsSync(filePath)) return { version: WORKSPACE_FILE_VERSION, workspaces: [], sessions: {} }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkspaceStoreError(filePath, `不是合法的 JSON（${reason}）`)
    }
    if (!isPlainObject(parsed)) {
      throw new WorkspaceStoreError(filePath, 'JSON 里的内容不像一份工作区记录')
    }
    const rawWorkspaces = parsed['workspaces']
    const workspaces: Workspace[] = []
    if (Array.isArray(rawWorkspaces)) {
      for (const raw of rawWorkspaces) {
        const workspace = parseWorkspace(raw)
        if (workspace !== undefined) workspaces.push(workspace)
      }
    }
    const rawSessions = parsed['sessions']
    const sessions: Record<string, SessionPlacement> = {}
    if (isPlainObject(rawSessions)) {
      for (const [sessionId, raw] of Object.entries(rawSessions)) {
        const placement = parsePlacement(raw)
        if (placement !== undefined) sessions[sessionId] = placement
      }
    }
    return { version: WORKSPACE_FILE_VERSION, workspaces, sessions }
  }

  /**
   * 把全部记录写回去。
   *
   * 原子写：先写同目录临时文件，再 rename 覆盖目标。
   * @param file - 要写的内容。
   */
  save(file: WorkspaceFile): void {
    const filePath = this.filePath
    if (filePath === undefined) return
    mkdirSync(dirname(filePath), { recursive: true })
    const payload = { version: WORKSPACE_FILE_VERSION, workspaces: file.workspaces, sessions: file.sessions }
    const tmp = `${filePath}.${process.pid}.${tempSeq++}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, filePath)
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
