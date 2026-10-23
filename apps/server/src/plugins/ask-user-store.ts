/**
 * 提问存储：`<dataDir>/questions.json`，按会话（以及发起提问的 agent）归档。
 *
 * 为什么单独落盘而不是只放在内存里：`ask_user` 的语义是「本轮到此为止，等用户
 * 回答」，回答可能发生在进程重启之后；提问与回答只有一起活下来，下一轮才有东西
 * 可以注入给模型。写入与待办共用「临时文件 + rename」的原子写法，读改写由一条
 * Promise 队列串起来。
 *
 * `deliveredAt` 是协调器的记账位：同一份问答只注入一次。它不属于产品可见的
 * 问题字段，但缺了它，模型会在之后每一轮都重新看到这条旧问答。
 * @module @ryharness/server/plugins/ask-user-store
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 一条提问（文件、工具、接口的共同形状）。 */
export interface QuestionEntry {
  id: string
  conversationId: string
  /** 发起提问的 agent（群聊里用来把答案只交给问的人）。 */
  agentId?: string
  question: string
  /** 可选项；给出时要求 2–6 项。 */
  options?: string[]
  /** 是否允许多选；缺省按单选理解。 */
  multiple?: boolean
  askedAt: number
  answer?: string
  /** 用户勾选的选项（与自由文本回答一起保存）。 */
  selected?: string[]
  answeredAt?: number
  /** 协调器已把这条问答注入模型的时间；持久化后不会再注入。 */
  deliveredAt?: number
}

/** 列表过滤：待答、已答或全部。 */
export type QuestionStatus = 'pending' | 'answered' | 'all'

/** 提问的硬上限：问题卡是对话的一部分，不是第二个知识库。 */
export const MAX_QUESTION_LENGTH = 200
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
export const MAX_OPTION_LENGTH = 80
export const MAX_ANSWER_LENGTH = 4000
export const MAX_CONVERSATION_ID_LENGTH = 128

/** 提问领域错误：工具与路由按 code 给出可读结论。 */
export class QuestionError extends Error {
  constructor(
    readonly code: 'BAD_CONVERSATION' | 'BAD_QUESTION' | 'BAD_OPTIONS' | 'BAD_ANSWER' | 'BAD_SELECTED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'QuestionError'
  }
}

/** questions.json 的形状；坏字段逐条丢弃，不让一份数据挡住启动。 */
interface QuestionsFile {
  questions: QuestionEntry[]
}

/** 临时文件名序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 字符串数组的读取：只收非空字符串，过滤空项。 */
function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text.length > 0) items.push(text)
  }
  return items
}

function parseQuestion(value: unknown): QuestionEntry | undefined {
  if (!isRecord(value)) return undefined
  const { id, conversationId, agentId, question, askedAt } = value
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  if (typeof question !== 'string' || question.length === 0) return undefined
  if (typeof askedAt !== 'number' || !Number.isFinite(askedAt)) return undefined
  const entry: QuestionEntry = { id, conversationId, question, askedAt }
  if (typeof agentId === 'string' && agentId.length > 0) entry.agentId = agentId
  const options = parseStringArray(value.options)
  if (options !== undefined && options.length >= MIN_OPTIONS) entry.options = options
  if (value.multiple === true) entry.multiple = true
  if (typeof value.answer === 'string') entry.answer = value.answer
  const selected = parseStringArray(value.selected)
  if (selected !== undefined && selected.length > 0) entry.selected = selected
  if (typeof value.answeredAt === 'number' && Number.isFinite(value.answeredAt)) {
    entry.answeredAt = value.answeredAt
  }
  if (typeof value.deliveredAt === 'number' && Number.isFinite(value.deliveredAt)) {
    entry.deliveredAt = value.deliveredAt
  }
  return entry
}

/** 读文件：整份坏了就是空列表；重复 id 只保留第一条。 */
function readFile(path: string): QuestionEntry[] {
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return []
    const seen = new Set<string>()
    const questions: QuestionEntry[] = []
    for (const raw of parsed.questions) {
      const entry = parseQuestion(raw)
      if (entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      questions.push(entry)
    }
    return questions
  } catch {
    // 读不出来按空列表处理：下一次写入会生成一份新的完整文件。
    return []
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 写盘走**异步**：这份文件会被反复重写（提问、回答、标记送达各一次），而同步写
 * 会把整个服务端卡住——实测 5000 条时一次写 142ms，正卡在 agent 出字的路径上，
 * 群聊里就表现成"字一顿一顿"。队列（enqueue）保证次序，异步写不改变次序。
 */
async function writeFileAtomic(path: string, questions: readonly QuestionEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const file: QuestionsFile = { questions: [...questions] }
  const tmp = `${path}.${process.pid}.${tempSeq++}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // 临时文件可能根本没写出来；清理失败不掩盖原始错误。
    }
    throw error
  }
}

/** 字面意义上的「字」：按码点计数，避免一个 emoji 被算成两个字。 */
function charLength(text: string): number {
  return [...text].length
}

/** 送达标记的落盘合并窗口（ms）。 */
const WRITE_DEBOUNCE_MS = 300
/** 答完且送达的问答保留多少条（问答记录页还要看，砍太多用户就核对不了了）。 */
const KEEP_DELIVERED_QUESTIONS = 200

/** 把若干条已回答的问答拼成注入给模型的 system 文本。 */
export function renderQuestionContext(entries: readonly QuestionEntry[]): string {
  if (entries.length === 0) return ''
  const lines = ['[用户已回答你此前的提问]']
  for (const entry of entries) {
    const selected =
      entry.selected === undefined || entry.selected.length === 0 ? '' : `（选择：${entry.selected.join('、')}）`
    lines.push(`你此前问过：${entry.question}；用户回答：${entry.answer ?? ''}${selected}`)
  }
  return lines.join('\n')
}

/**
 * 提问存储。
 *
 * 构造时同步读一次；之后每次变更都重写整份文件（问题卡是人的交互量级）。
 * 返回给调用方的对象都是副本，改数组不会绕过持久化。
 */
export class QuestionStore {
  private questions: QuestionEntry[]
  /** 读改写串行链：并发回答/提问不会都从同一份旧快照出发。 */
  private queue: Promise<void> = Promise.resolve()
  /** 送达标记的落盘合并：一轮里的多次标记只写一次盘。 */
  private writeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string) {
    this.questions = readFile(path)
  }

  /** 记录一条提问；返回落盘后的条目。 */
  ask(input: {
    conversationId: string
    agentId?: string
    question: string
    options?: readonly string[]
    multiple?: boolean
  }): Promise<QuestionEntry> {
    this.assertConversationId(input.conversationId)
    const question = input.question.trim()
    if (question.length === 0) {
      throw new QuestionError('BAD_QUESTION', '问题不能为空')
    }
    if (charLength(question) > MAX_QUESTION_LENGTH) {
      throw new QuestionError('BAD_QUESTION', `问题最多 ${MAX_QUESTION_LENGTH} 字`)
    }
    const options = this.normalizeOptions(input.options)
    if (input.multiple !== undefined && typeof input.multiple !== 'boolean') {
      throw new QuestionError('BAD_OPTIONS', 'multiple 必须是布尔值')
    }
    const agentId = input.agentId?.trim()
    return this.enqueue(async () => {
      const entry: QuestionEntry = {
        id: randomUUID(),
        conversationId: input.conversationId,
        question,
        askedAt: Date.now(),
        ...(agentId === undefined || agentId.length === 0 ? {} : { agentId }),
        ...(options === undefined ? {} : { options }),
        ...(input.multiple === true ? { multiple: true } : {}),
      }
      const next = [...this.questions, entry]
      await writeFileAtomic(this.path, next)
      this.questions = next
      return this.copy(entry)
    })
  }

  /** 保存用户回答；重复回答会覆盖上一次并重新进入待注入状态。 */
  answer(id: string, input: { text: string; selected?: readonly string[] }): Promise<QuestionEntry> {
    const text = input.text.trim()
    if (text.length === 0) {
      throw new QuestionError('BAD_ANSWER', '回答内容不能为空')
    }
    if (charLength(text) > MAX_ANSWER_LENGTH) {
      throw new QuestionError('BAD_ANSWER', `回答最多 ${MAX_ANSWER_LENGTH} 字`)
    }
    const selected = this.normalizeSelected(input.selected)
    return this.enqueue(async () => {
      const index = this.questions.findIndex((entry) => {
        return entry.id === id
      })
      if (index < 0) throw new QuestionError('NOT_FOUND', `没有这条提问：${id}`)
      const current = this.questions[index] as QuestionEntry
      const answered: QuestionEntry = {
        ...current,
        answer: text,
        answeredAt: Date.now(),
        ...(selected === undefined ? {} : { selected }),
      }
      // 重新回答意味着用户改了主意：清掉送达标记，下一轮让模型看到新答案。
      delete answered.deliveredAt
      const next = [...this.questions]
      next[index] = answered
      await writeFileAtomic(this.path, next)
      this.questions = next
      return this.copy(answered)
    })
  }

  /** 按会话列出问题；status 缺省是全部。 */
  list(conversationId: string, status: QuestionStatus = 'all'): QuestionEntry[] {
    this.assertConversationId(conversationId)
    return this.questions
      .filter((entry) => {
        if (entry.conversationId !== conversationId) return false
        if (status === 'pending') return entry.answeredAt === undefined
        if (status === 'answered') return entry.answeredAt !== undefined
        return true
      })
      .map((entry) => {
        return this.copy(entry)
      })
  }

  /**
   * 取该 agent 已答、尚未注入的问答。
   *
   * 没有 agentId 的历史条目对所有 agent 可见（旧数据没有归属信息）；一旦有归属，
   * 就只给发起提问的那一个——群聊里别人问的问题不该出现在你的系统提示里。
   */
  pendingAnswers(conversationId: string, agentId?: string): QuestionEntry[] {
    this.assertConversationId(conversationId)
    return this.questions
      .filter((entry) => {
        if (entry.conversationId !== conversationId) return false
        if (entry.answeredAt === undefined || entry.deliveredAt !== undefined) return false
        if (entry.agentId === undefined || agentId === undefined) return true
        return entry.agentId === agentId
      })
      .map((entry) => {
        return this.copy(entry)
      })
  }

  /**
   * 标记这些问答已经注入过（尽力持久化）。
   *
   * 写失败不抛：送达标记只用来防止重复注入，丢一次最多让模型下一轮再看到同一段
   * 问答，不能反过来让一趟已经开始的对话因为记账失败而报错。
   */
  markDelivered(ids: readonly string[]): void {
    const wanted = new Set(ids)
    if (wanted.size === 0) return
    const now = Date.now()
    let changed = false
    const next = this.questions.map((entry) => {
      if (!wanted.has(entry.id) || entry.answeredAt === undefined || entry.deliveredAt !== undefined) return entry
      changed = true
      return { ...entry, deliveredAt: now }
    })
    if (!changed) return
    this.questions = next
    // 送达标记是每轮每个 agent 一次（群聊里 6 位就是 6 次），每次都重写整份文件太奢侈：
    // 这里合并成一次异步写，落盘失败也不影响——内存里已经标记过，同一进程内不会重复注入。
    this.scheduleWrite(this.pruneDelivered(next))
  }

  /**
   * 丢掉老早答完又送达到的问答。
   *
   * 这份文件只增不减：三个月后每写一次都要重写整份（实测两万条时单次 14ms），
   * 而累计写盘量能到几十 GB。已答完的问答唯一的用处是"别再注入"，注入之后就没有
   * 用了——留最近的一批（问答记录页还要看）就够。
   */
  private pruneDelivered(questions: readonly QuestionEntry[]): QuestionEntry[] {
    const done = questions.filter((entry) => {
      return entry.answeredAt !== undefined && entry.deliveredAt !== undefined
    })
    if (done.length <= KEEP_DELIVERED_QUESTIONS) return [...questions]
    const dropped = new Set(
      done.slice(0, done.length - KEEP_DELIVERED_QUESTIONS).map((entry) => {
        return entry.id
      }),
    )
    return questions.filter((entry) => {
      return !dropped.has(entry.id)
    })
  }

  /**
   * 攒一次写盘：连续几次标记送达只落一次盘。
   *
   * 送达标记的语义是"别再注入同一段问答"，它丢一次最多让模型下一轮再看一遍；反过来，
   * 每个 agent 一次同步重写整份文件才是真代价（5000 条时一次 142ms，六个 agent 一轮
   * 就是 850ms 的事件循环阻塞）。
   */
  private scheduleWrite(questions: readonly QuestionEntry[]): void {
    if (this.writeTimer !== undefined) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      void writeFileAtomic(this.path, questions).catch(() => {
        // 送达标记丢了不影响正确性，见上面的注释。
      })
    }, WRITE_DEBOUNCE_MS)
    this.writeTimer.unref?.()
  }

  private normalizeOptions(options: readonly string[] | undefined): string[] | undefined {
    if (options === undefined) return undefined
    if (!Array.isArray(options)) {
      throw new QuestionError('BAD_OPTIONS', 'options 必须是字符串数组')
    }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new QuestionError('BAD_OPTIONS', `选项需要 ${MIN_OPTIONS}–${MAX_OPTIONS} 项`)
    }
    const normalized: string[] = []
    for (const raw of options) {
      if (typeof raw !== 'string') {
        throw new QuestionError('BAD_OPTIONS', '每个选项都必须是字符串')
      }
      const text = raw.trim()
      if (text.length === 0) {
        throw new QuestionError('BAD_OPTIONS', '选项不能为空')
      }
      if (charLength(text) > MAX_OPTION_LENGTH) {
        throw new QuestionError('BAD_OPTIONS', `每个选项最多 ${MAX_OPTION_LENGTH} 字`)
      }
      normalized.push(text)
    }
    return normalized
  }

  private normalizeSelected(selected: readonly string[] | undefined): string[] | undefined {
    if (selected === undefined) return undefined
    if (!Array.isArray(selected)) {
      throw new QuestionError('BAD_SELECTED', 'selected 必须是字符串数组')
    }
    const normalized: string[] = []
    for (const raw of selected) {
      if (typeof raw !== 'string') {
        throw new QuestionError('BAD_SELECTED', 'selected 里只能放字符串')
      }
      const text = raw.trim()
      if (text.length === 0) continue
      if (!normalized.includes(text)) normalized.push(text)
    }
    return normalized.length === 0 ? undefined : normalized
  }

  private assertConversationId(conversationId: string): void {
    if (conversationId.trim().length === 0) {
      throw new QuestionError('BAD_CONVERSATION', 'conversationId 是必填的')
    }
    if (conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
      throw new QuestionError('BAD_CONVERSATION', `conversationId 最多 ${MAX_CONVERSATION_ID_LENGTH} 个字符`)
    }
  }

  private copy(entry: QuestionEntry): QuestionEntry {
    return {
      ...entry,
      ...(entry.options === undefined ? {} : { options: [...entry.options] }),
      ...(entry.selected === undefined ? {} : { selected: [...entry.selected] }),
    }
  }

  /** 串行执行读改写；前一次失败不毒化后面的队列。 */
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
