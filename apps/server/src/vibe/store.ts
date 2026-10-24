/**
 * RyVibe 会话存储：`<dataDir>/vibe/sessions.json`。
 *
 * 一次 RyVibe = 一个群会话 + 一份「这次要按什么方法做事」的记录。两者必须一起
 * 活下来：方法（skill）要跨轮注入，问题与答案要跨轮回到 agent 手里，页面上还要
 * 知道「现在问到第几轮、还差几个答案」。所以这里落盘，而不是只放在内存里。
 *
 * 为什么不进数据库：这个功能是**一次性的工作流**（一句话进、一份方案出），它
 * 需要的是「这次会话的元信息」，不是「用户的历史数据」。落文件让它的生命周期
 * 与插件开关一样清楚：数据在 dataDir 里，删掉文件就没了，不用写迁移。
 *
 * 写改读由一条 Promise 队列串起来（与提问存储同一套写法）：并发写会把次序弄乱，
 * 而「本轮已问几题」这种计数一旦算错，用户就会被问超量的问题。
 * @module @ryharness/server/vibe/store
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DeliverableKind, VibeProject, VibeProjectFile } from './project.ts'

/**
 * 一次 RyVibe 的状态。
 *
 * `status` 是**真源**，不是现算的：现算的话，一轮失败（模型报错、用户点停止、
 * 助理被删）会落到「没有待答题、也没有在跑的轮子」= 算出 done，页面于是宣布
 * 「方案好了」而下面空空如也。失败必须是一个能被看见的状态。
 */
export type VibeStatus = 'asking' | 'building' | 'done' | 'failed'

/** 一次 RyVibe 会话的记录。 */
export interface VibeSession {
  id: string
  /** 底下那个群会话的 id：RyVibe 的一切都发生在它里面。 */
  conversationId: string
  /** 用户那句话（原文）。 */
  requirement: string
  /** 这次用的 skill id（方法）。 */
  skillId: string
  /** 参与的小队（agent id）。 */
  memberAgentIds: string[]
  createdAt: number
  /** 用户已经回答过几轮（每答完一轮 +1）。 */
  round: number
  /** 本轮已经问了几题。 */
  askedInRound: number
  /** 本轮问出的问题 id（按顺序）。 */
  questionIds: string[]
  /**
   * 用户点了「按你们的默认方案来」：不再问了，直接出方案。
   *
   * 它是一个**状态**而不是一个计数：跳过之后「还剩几轮」已经不重要了，重要的是
   * 小队别再问。计数被顶到上限也能达到同样效果，但那样界面上会显示成「4/4 轮」——
   * 用户明明只答了一题。
   */
  noMoreQuestions?: boolean
  /**
   * 上一次交给小队的答案摘要。
   *
   * 它是幂等位：用户一次提交四道题会连着发四个请求，只有最后一个看到"都答完了"；
   * 拿摘要比一下，答案没变就不再让小队白跑一遍。改了主意再提交，摘要变了才重跑。
   */
  lastSummary?: string
  status: VibeStatus
  /** 失败时的一句人话原因（给界面看的，不给日志看）。 */
  failure?: string
  /**
   * 落盘的项目骨架（方案 → 产品的那一步）。
   *
   * 没有它，这次 RyVibe 就只产出了一段文字：用户手上没有能打开的东西，也没有
   * 下一步的清单。落盘由工具做，这里只存结果，页面据此显示"项目已生成"。
   */
  project?: VibeProject
}

/**
 * 一轮问几题：一题。
 *
 * 改成「一轮一题」是因为一次丢四张卡给用户等于没有交互——用户看到的是一张问卷，
 * 不是一次对话。一题一问之后，小队每问一题都要等用户回答，才能问下一题；用户点一下，
 * 小队接着往下走，这一段才真的像对话。
 */
export const MAX_QUESTIONS_PER_ROUND = 1
/**
 * 最多问几轮（一轮 = 一道题 + 用户的一个回答）：四轮就是四道题。
 *
 * 问完就该出方案。剩下的不确定由小队自己拿主意（skill 里写死了「能自己定的就
 * 自己定」），而不是把用户当问卷填。
 */
export const MAX_ROUNDS = 4
/** 需求字数上限：它要当群会话的第一条消息，太长会被当成需求说明书。 */
export const MAX_REQUIREMENT_LENGTH = 500

/**
 * 还能不能再问一题。
 *
 * `ok: false` 时带上原因，因为两种原因给模型的信号完全不同：问够了该**出方案**，
 * 上一题没答该**停下等**。只回一个「不行」，模型会自己猜——猜错就是提前出方案，
 * 或者用户都答完了它还在等。
 */
export type AskSlot = { ok: true } | { ok: false; reason: 'budget' | 'pending' }

/** 领域错误：路由据此映射 HTTP 状态。 */
export class VibeError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_REQUIREMENT' | 'NO_SQUAD' | 'NOT_A_VIBE',
    message: string,
  ) {
    super(message)
    this.name = 'VibeError'
  }
}

interface SessionsFile {
  sessions: VibeSession[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => {
    return typeof item === 'string'
  })
}

function parseSession(value: unknown): VibeSession | undefined {
  if (!isRecord(value)) return undefined
  const { id, conversationId, requirement, skillId, createdAt } = value
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  if (typeof requirement !== 'string') return undefined
  if (typeof skillId !== 'string' || skillId.length === 0) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  const status: VibeStatus = value.status === 'done' || value.status === 'building' ? value.status : 'asking'
  const project = parseProject(value.project)
  return {
    id,
    conversationId,
    requirement,
    skillId,
    memberAgentIds: stringArray(value.memberAgentIds),
    createdAt,
    round: typeof value.round === 'number' && Number.isFinite(value.round) ? value.round : 0,
    askedInRound:
      typeof value.askedInRound === 'number' && Number.isFinite(value.askedInRound) ? value.askedInRound : 0,
    questionIds: stringArray(value.questionIds),
    ...(value.noMoreQuestions === true ? { noMoreQuestions: true } : {}),
    ...(typeof value.lastSummary === 'string' ? { lastSummary: value.lastSummary } : {}),
    ...(typeof value.failure === 'string' ? { failure: value.failure } : {}),
    ...(project === undefined ? {} : { project }),
    status,
  }
}

/** 读回来的项目骨架；字段缺一个就当没有（骨架是产物，不是存档）。 */
function parseProject(value: unknown): VibeProject | undefined {
  if (!isRecord(value)) return undefined
  const { name, slug, dir, files, createdAt } = value
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof slug !== 'string' || slug.length === 0) return undefined
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (!Array.isArray(files)) return undefined
  // 形态是后加的字段：老存档里没有，按 app 认（旧存档只有软件形态这一种可能）。
  const kind: DeliverableKind =
    value.kind === 'doc' || value.kind === 'sheet' || value.kind === 'flow' ? value.kind : 'app'
  const parsed: VibeProjectFile[] = []
  for (const raw of files) {
    if (!isRecord(raw)) continue
    const { name: fileName, path, size } = raw
    if (typeof fileName !== 'string' || fileName.length === 0) continue
    if (typeof path !== 'string' || path.length === 0) continue
    if (typeof size !== 'number' || !Number.isFinite(size)) continue
    parsed.push({ name: fileName, path, size })
  }
  return { name, slug, kind, dir, files: parsed, createdAt }
}

/** 临时文件名序号：同一毫秒内两次写也要落在不同文件上。 */
let tempSeq = 0

/**
 * RyVibe 会话存储。
 *
 * 写盘用「临时文件 + rename」的原子写法；读改写走一条 Promise 队列。
 */
export class VibeStore {
  private readonly sessions = new Map<string, VibeSession>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.load()
  }

  /** 一次 RyVibe 的落盘位置。 */
  private get path(): string {
    return join(this.dataDir, 'vibe', 'sessions.json')
  }

  /** 读盘：整份坏了就是空的；重复 id 只留第一条。 */
  private load(): void {
    const path = this.path
    if (!existsSync(path)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return
      const seen = new Set<string>()
      for (const raw of parsed.sessions) {
        const session = parseSession(raw)
        if (session === undefined || seen.has(session.id)) continue
        seen.add(session.id)
        this.sessions.set(session.id, session)
      }
    } catch {
      // 存档坏了就当没有：RyVibe 是新功能，丢了重来一遍就好。
    }
  }

  /** 原子写：先写临时文件再 rename。 */
  private save(): void {
    const path = this.path
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${tempSeq++}.tmp`
    const payload: SessionsFile = { sessions: [...this.sessions.values()] }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  /** 排队跑一段对存档的改动。 */
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 列出全部会话（新的在前）。 */
  list(): VibeSession[] {
    return [...this.sessions.values()].sort((a, b) => {
      return b.createdAt - a.createdAt
    })
  }

  /** 取一个会话。 */
  get(id: string): VibeSession | undefined {
    return this.sessions.get(id)
  }

  /** 按底层群会话取（内核注入 skill 与工具时要按会话查）。 */
  byConversation(conversationId: string): VibeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.conversationId === conversationId) return session
    }
    return undefined
  }

  /** 新建一次 RyVibe。 */
  create(input: {
    conversationId: string
    requirement: string
    skillId: string
    memberAgentIds: readonly string[]
  }): Promise<VibeSession> {
    return this.enqueue(() => {
      const session: VibeSession = {
        id: randomUUID(),
        conversationId: input.conversationId,
        requirement: input.requirement,
        skillId: input.skillId,
        memberAgentIds: [...input.memberAgentIds],
        createdAt: Date.now(),
        round: 0,
        askedInRound: 0,
        questionIds: [],
        status: 'asking',
      }
      this.sessions.set(session.id, session)
      this.save()
      return session
    })
  }

  /**
   * 问一道新题之前先占一个名额。
   *
   * 两种「不能问」给模型的信号不一样，混成一句模型就会乱来：
   * - `budget`：问够了（四轮用完，或用户点了「按默认方案来」）→ 该去出方案了。
   * - `pending`：已经有一道题在等用户回答 → 该**停下等**，别再问、也别出方案。
   *
   * 计数与写入在同一条队列里：四位小队成员并发调用时只有前一个算数，其余拿到的是
   * `pending`（用户面前已经有那道题了）。
   *
   * 之所以先占名额再落问题：提问存储里没有「删掉一道题」这个动作，先记后判会留下
   * 一道用户其实不该看到的题。
   */
  async reserveAsk(sessionId: string): Promise<AskSlot> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      if (session.noMoreQuestions === true) return { ok: false, reason: 'budget' }
      if (session.round >= MAX_ROUNDS) return { ok: false, reason: 'budget' }
      if (session.askedInRound >= MAX_QUESTIONS_PER_ROUND) return { ok: false, reason: 'pending' }
      session.askedInRound += 1
      session.status = 'asking'
      this.save()
      return { ok: true }
    })
  }

  /** 记下刚落盘的那道题（页面上按它把问题排出来）。 */
  async noteQuestion(sessionId: string, questionId: string): Promise<void> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      session.questionIds.push(questionId)
      this.save()
    })
  }

  /**
   * 记一次用户回答：当前这题答完了就把这一轮收掉，小队可以接着往下走。
   *
   * `summary` 是这一轮答案的摘要（由调用方把「问了什么、选了什么」拼成一句）。
   * 拿它做幂等位：**同样的答案不必让小队再跑一遍**——重复提交（网络重试、用户又点
   * 了一次提交）会带着同一份摘要回来，此时不再触发新一轮。改了主意再提交，摘要变了，
   * 才重跑。
   *
   * 「改主意」那一支是**另一道题还没答**的时候改的（用户先答了第一题、小队问了第二题，
   * 用户回头改第一题）。这时 pendingCount > 0，本轮不收口，也**先不让小队跑**——
   * 新答案跟着下一道题的答案一起过去，小队只重跑一次，界面上不会冒出一版半成品方案。
   *
   * @param sessionId - 会话 id。
   * @param pendingCount - 还没回答的问题数（由调用方按提问存储数出来）。
   * @param summary - 这一轮答案的摘要。
   * @returns 小队现在是否该跑这一轮（答案变了、且当前这轮已收口）。
   */
  async answer(sessionId: string, pendingCount: number, summary: string): Promise<boolean> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      const changed = session.lastSummary !== summary
      if (changed) session.lastSummary = summary
      // 当前这题答完了：这一轮收口，小队可以接着往下走（问下一题或直接出方案）。
      // 「本轮已问的题」清空，下一次提问重新从零计数——一题一问就是这么转起来的。
      // 条件里的 askedInRound > 0 是防重复提交：同一份答案交两次不会白吃一轮名额。
      if (pendingCount === 0 && session.askedInRound > 0) {
        session.askedInRound = 0
        session.questionIds = []
        session.round += 1
        session.status = 'building'
      }
      this.save()
      return changed && pendingCount === 0
    })
  }

  /**
   * 收摊：用户点了「按你们的默认方案来」，不再问了。
   *
   * 之后 {@link reserveAsk} 一律回 `budget`——小队拿到的是「问够了，去出方案」，
   * 而不是「还有三问，接着问」。用户已经明说了，剩下的事该小队自己拿主意。
   */
  async stopAsking(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      session.noMoreQuestions = true
      this.save()
    })
  }

  /** 改状态（出方案了 / 失败了 / 还在问）。 */
  async setStatus(sessionId: string, status: VibeStatus, failure?: string): Promise<VibeSession> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      session.status = status
      if (failure === undefined) delete session.failure
      else session.failure = failure
      this.save()
      return session
    })
  }

  /**
   * 记下落盘的项目骨架。
   *
   * 重复落盘会覆盖上一次的记录：用户改了主意让小队重出一版，页面上要显示的
   * 应该是**现在这一个**项目，而不是第一次那个。
   */
  async setProject(sessionId: string, project: VibeProject): Promise<VibeSession> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      session.project = project
      this.save()
      return session
    })
  }

  /**
   * 把一个问出来但没落成题的名额还回去。
   *
   * 盘问工具是「先占名额、再落题」的：落题失败（问题太长、选项里有空串）时，
   * 名额不能白吃——否则模型问坏一次，这一轮就再问不出题了，而用户一道题都没见到。
   */
  async releaseAsk(sessionId: string): Promise<void> {
    return this.enqueue(() => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) throw new VibeError('NOT_FOUND', `没有这次 RyVibe：${sessionId}`)
      if (session.askedInRound > 0) session.askedInRound -= 1
      this.save()
    })
  }
}
