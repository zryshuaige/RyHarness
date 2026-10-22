/**
 * 待办存储：`<dataDir>/todos.json`，按会话分组。
 *
 * 写入走「临时文件 + rename」：直接覆盖目标文件时，进程在写到一半退出会留下半份
 * JSON，下一次启动读到的就是一份永久损坏的清单；rename 在同一分区上是原子的，读的
 * 人要么看到旧版本、要么看到新版本。同一进程内的读改写由一条 Promise 队列串起来，
 * 并发 add 不会互相覆盖。
 * @module @ryharness/server/plugins/todo-store
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一条待办。 */
export interface TodoItem {
  id: string
  text: string
  done: boolean
  createdAt: number
}

/** 一个会话的清单（文件与接口的共同形状）。 */
export interface TodoGroup {
  conversationId: string
  items: TodoItem[]
}

/** 待办领域错误：路由与工具都要按 code 给出可读结论，而不是吞成 500。 */
export class TodoError extends Error {
  constructor(
    readonly code: 'BAD_CONVERSATION' | 'EMPTY_TEXT' | 'TEXT_TOO_LONG' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'TodoError'
  }
}

/** 单个会话 id 与单条待办的硬上限：清单是给人看的，不是第二个数据库。 */
export const MAX_CONVERSATION_ID_LENGTH = 128
/** 单条待办正文的硬上限。 */
export const MAX_TODO_TEXT_LENGTH = 500

/** todos.json 的形状；没有版本号，也没有迁移——旧文件缺字段时逐条丢弃。 */
interface TodosFile {
  conversations: TodoGroup[]
}

/** 临时文件名序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseItem(value: unknown): TodoItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, text, done, createdAt } = value
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof text !== 'string' || text.length === 0) return undefined
  if (typeof done !== 'boolean') return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  return { id, text, done, createdAt }
}

function parseGroup(value: unknown): TodoGroup | undefined {
  if (!isRecord(value)) return undefined
  const conversationId = value.conversationId
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  if (!Array.isArray(value.items)) return undefined
  const seen = new Set<string>()
  const items: TodoItem[] = []
  for (const raw of value.items) {
    const item = parseItem(raw)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  return { conversationId, items }
}

/** 读到的坏字段逐条丢弃；整份文件坏了就是空清单，不让启动被一份数据挡住。 */
function readFile(path: string): Map<string, TodoItem[]> {
  const groups = new Map<string, TodoItem[]>()
  if (!existsSync(path)) return groups
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.conversations)) return groups
    for (const raw of parsed.conversations) {
      const group = parseGroup(raw)
      if (group !== undefined) groups.set(group.conversationId, group.items)
    }
  } catch {
    // 读不出来按空清单处理：下一次写入会生成一份新的完整文件。
  }
  return groups
}

/** 原子写：先写同目录临时文件，再 rename 覆盖目标。 */
function writeFileAtomic(path: string, groups: Map<string, TodoItem[]>): void {
  mkdirSync(dirname(path), { recursive: true })
  const file: TodosFile = {
    conversations: [...groups].map(([conversationId, items]) => {
      return { conversationId, items }
    }),
  }
  const tmp = `${path}.${process.pid}.${tempSeq++}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    // 失败路径上清掉临时文件：下次启动不该看到一堆半成品。
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
    }
    throw error
  }
}

/**
 * 按会话分组的待办存储。
 *
 * 构造时同步读一次；之后每次变更都重新写整份文件（清单规模是人的待办量级，
 * 不需要增量日志）。读接口返回副本，调用方改数组不会绕过持久化。
 */
export class TodoStore {
  private byConversation: Map<string, TodoItem[]>
  /** 读改写串行链：并发 add 不会都从同一份旧快照出发。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {
    this.byConversation = readFile(path)
  }

  /** 当前会话的清单；没有时是空数组。 */
  list(conversationId: string): TodoGroup {
    this.assertConversationId(conversationId)
    return this.groupOf(conversationId, this.byConversation.get(conversationId) ?? [])
  }

  /** 追加一条待办，返回追加后的清单。 */
  add(conversationId: string, text: string): Promise<TodoGroup> {
    this.assertConversationId(conversationId)
    const normalized = text.trim()
    if (normalized.length === 0) throw new TodoError('EMPTY_TEXT', '待办内容不能为空')
    if (normalized.length > MAX_TODO_TEXT_LENGTH) {
      throw new TodoError('TEXT_TOO_LONG', `待办内容最多 ${MAX_TODO_TEXT_LENGTH} 字`)
    }
    return this.enqueue(() => {
      const items = [...(this.byConversation.get(conversationId) ?? [])]
      items.push({ id: randomUUID(), text: normalized, done: false, createdAt: Date.now() })
      return this.commit(conversationId, items)
    })
  }

  /**
   * 勾选/取消勾选一条待办。
   * @param conversationId - 会话 id。
   * @param id - 待办 id。
   * @param done - 目标状态；缺省时翻转当前状态（模型用 toggle 语义）。
   */
  setDone(conversationId: string, id: string, done?: boolean): Promise<TodoGroup> {
    this.assertConversationId(conversationId)
    return this.enqueue(() => {
      const items = [...(this.byConversation.get(conversationId) ?? [])]
      const index = items.findIndex((item) => {
        return item.id === id
      })
      const current = index >= 0 ? items[index] : undefined
      if (current === undefined) throw new TodoError('NOT_FOUND', `没有这条待办：${id}`)
      items[index] = { ...current, done: done ?? !current.done }
      return this.commit(conversationId, items)
    })
  }

  /** 清空一个会话的清单，返回空清单。 */
  clear(conversationId: string): Promise<TodoGroup> {
    this.assertConversationId(conversationId)
    return this.enqueue(() => {
      const next = new Map(this.byConversation)
      next.delete(conversationId)
      writeFileAtomic(this.path, next)
      this.byConversation = next
      return { conversationId, items: [] }
    })
  }

  /**
   * 撤销清空：把一批待办**原样**写回（id / 完成态 / 创建时间都不变）。
   *
   * 清空是侧栏里一个不起眼的小按钮，一点就没——没有反悔机会就等于"不可逆"。
   * 撤销写回的是原来那几条（不是新建）：id 不变，勾选状态也不丢。
   */
  restore(conversationId: string, items: readonly TodoItem[]): Promise<TodoGroup> {
    this.assertConversationId(conversationId)
    return this.enqueue(() => {
      return this.commit(
        conversationId,
        items.map((item) => {
          return { ...item }
        }),
      )
    })
  }

  private assertConversationId(conversationId: string): void {
    if (conversationId.trim().length === 0) {
      throw new TodoError('BAD_CONVERSATION', 'conversationId 是必填的')
    }
    if (conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
      throw new TodoError('BAD_CONVERSATION', `conversationId 最多 ${MAX_CONVERSATION_ID_LENGTH} 个字符`)
    }
  }

  private groupOf(conversationId: string, items: readonly TodoItem[]): TodoGroup {
    return {
      conversationId,
      items: items.map((item) => {
        return { ...item }
      }),
    }
  }

  private commit(conversationId: string, items: TodoItem[]): TodoGroup {
    const next = new Map(this.byConversation)
    next.set(conversationId, items)
    writeFileAtomic(this.path, next)
    this.byConversation = next
    return this.groupOf(conversationId, items)
  }

  /** 串行执行读改写；前一次失败不毒化后面的队列。 */
  private enqueue<T>(task: () => T): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
