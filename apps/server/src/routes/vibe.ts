/**
 * RyVibe 路由：一句话进，一份完整产品方案出。
 *
 * 这一页背后的流程：
 * 1. 用户说一句话（"给独立开发者做个记账工具"）。
 * 2. 服务端开一个**群会话**，成员是小队；这次会话额外装上「grill me」这套方法
 *    （skill 注入系统提示）与盘问工具（见 server 的 skillContext / extraTools 装配）。
 * 3. 小队看完需求：需求够清楚就直接出方案；不够清楚就**盘问**——每题带选项，
 *    用户点一下就是答案（见 plugins/grill-me.ts）。
 * 4. 用户点完，这轮收口，小队继续；问完这一轮就该给方案。
 *
 * 页面不订阅 WS：它轮询 {@link GET /api/vibe/:id} 拿「现在问到哪、还差几个答案、
 * 方案出来没有」。这比把整条对话搬进一个页面简单得多，也让「一句话进、一份方案出」
 * 这件事在界面上是真的成立——用户全程只需要点几下。
 * @module @ryharness/server/routes/vibe
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { Conversation, SessionStore, StoredMessage } from '@ryharness/session'
import { normalizePersona, TOOL_RESULT_PREFIX } from '@ryharness/session'
import { QuestionError, type QuestionStore } from '../plugins/ask-user-store.ts'
import { GRILL_ME_SKILL_ID } from '../plugins/skills.ts'
import type { TodoItem, TodoStore } from '../plugins/todo-store.ts'
import { HttpRequestError, json, type Router, strField } from '../router.ts'
import type { DeliverableKind } from '../vibe/project.ts'
import {
  MAX_REQUIREMENT_LENGTH,
  MAX_ROUNDS,
  VibeError,
  type VibeSession,
  type VibeStatus,
  type VibeStore,
} from '../vibe/store.ts'
import type { TurnConversation } from './conversations.ts'

/** 小队最多几个人：再多人就成群聊了，用户会看到一堆头像在抢着说话。 */
export const MAX_SQUAD_SIZE = 4

/** 项目文件读回上限（字节）：骨架里的文件都是人看的文档，超大就没必要整份拉回来。 */
const MAX_PROJECT_FILE_BYTES = 512 * 1024

/** 内置小队成员（按这个顺序入队）：总管打头，职能互补的两位跟上。 */
const BUILTIN_SQUAD_ORDER = ['ryen', 'ryen-team-coding', 'ryen-team-writing']

/** RyVibe 路由的依赖。 */
export interface VibeRoutesDeps {
  store: SessionStore
  vibe: VibeStore
  questions: QuestionStore
  /** 待办存储：落盘时写进去的任务清单要跟着下发给页面。 */
  todos: TodoStore
  /** 把一轮对话排进该会话的串行链；返回它领到的轮次序号。 */
  enqueueTurn: (conversation: TurnConversation, text: string) => number
  /** 这个会话此刻有没有在跑（或排队）的一轮。 */
  isTurnActive: (conversationId: string) => boolean
}

/** 落盘的项目骨架（页面据此显示形态、预览文件）。 */
export interface VibeProjectView {
  name: string
  /** 目录名（slug）。 */
  slug: string
  /** 产物形态：app / doc / sheet / flow。 */
  kind: DeliverableKind
  /** 项目目录的绝对路径。 */
  dir: string
  /** 写出去的文件。 */
  files: { name: string; size: number }[]
  createdAt: number
}

/** 页面看到的一次 RyVibe。 */
export interface VibeSessionView {
  id: string
  conversationId: string
  requirement: string
  skillId: string
  /** 小队成员（id + 名字 + 形象 + 性格）。 */
  squad: VibeSquadMemberView[]
  createdAt: number
  /** 现在到哪一步了。 */
  status: VibeStatus
  /** 这一轮还有没有在跑（小队还在说话）。页面据此决定轮询快慢。 */
  busy: boolean
  /** 这一轮还差几个答案。 */
  pendingAnswers: number
  /** 问过几轮。 */
  round: number
  /** 最多还有几轮。 */
  maxRounds: number
  /** 失败时的一句人话原因。 */
  error?: string
  /** 落盘的项目骨架；没有就是还没落盘。 */
  project?: VibeProjectView
}

/**
 * 小队里的一位成员。
 *
 * 除了 id 与名字，还带上**形象**与**性格**：
 * - 形象：页面上要把"谁在问 / 谁在说"画出来，光有名字就只能写一行文字；
 * - 性格：头像动效的幅度与节奏由性格四维决定（见渲染层的 lib/avatar-motion.ts），
 *   同一个助理动起来什么样，得由服务端把这份事实送过去。
 */
export interface VibeSquadMemberView {
  id: string
  name: string
  /** 形象字段（立绘 / 立体动物 / 品牌猫）。 */
  avatar?: string
  /** 性格三维：决定头像动效的幅度与节奏。 */
  temperament?: { extroversion: number; rigor: number; humor: number }
}

/** 页面上的一道盘问题。 */
export interface VibeQuestionView {
  id: string
  question: string
  options: string[]
  agentId?: string
  /** 用户已经答过了（已答的题折成一行小字留在页面上，不从记录里消失）。 */
  answered?: boolean
  /** 用户勾了哪些选项。 */
  selected?: string[]
  /** 用户自己写的那句（选了「我自己说」时）。 */
  answer?: string
}

/** 页面上的一段产出。 */
export interface VibeOutputView {
  senderId: string
  text: string
  createdAt: number
  /** 库里这条消息的序号：页面拿它当游标，下一次只取新的。 */
  seq: number
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

/**
 * 挑小队：内置的三位优先，其余按通讯录顺序补，最多 {@link MAX_SQUAD_SIZE} 位。
 *
 * 为什么有上限：RyVibe 的承诺是「用户只需要点几下」。六个 agent 同时抢着盘问，
 * 用户看到的是六个头像在问六件事——那不叫一句话做产品，叫问卷。
 */
export function pickSquad(agents: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  const byId = new Map(
    agents.map((agent) => {
      return [agent.id, agent]
    }),
  )
  const picked: { id: string; name: string }[] = []
  for (const id of BUILTIN_SQUAD_ORDER) {
    const agent = byId.get(id)
    if (agent === undefined) continue
    picked.push({ id: agent.id, name: agent.name })
    if (picked.length >= MAX_SQUAD_SIZE) return picked
  }
  for (const agent of agents) {
    if (picked.length >= MAX_SQUAD_SIZE) break
    if (
      picked.some((member) => {
        return member.id === agent.id
      })
    ) {
      continue
    }
    picked.push({ id: agent.id, name: agent.name })
  }
  return picked
}

/** 一条消息的纯文本（工具行与结构块只取文字部分）。 */
function textOf(message: StoredMessage): string {
  const parts: string[] = []
  for (const raw of message.contentBlocks ?? []) {
    if (!isRecord(raw)) continue
    if (raw.type !== 'text') continue
    const text = raw.text
    if (typeof text === 'string' && text.length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * 这条消息是不是一次工具调用的结果（而不是某个人说的话）。
 *
 * 工具结果在库里的正文是 `〔tool〕<名字>: <结果>`（见 packages/session/src/coordinator.ts），
 * 它落库是为了**回放给模型看**，不是小队对用户说的话。此前产出流不认它，于是盘问工具
 * 那句「这个问题已经进到卡片里…」被原样画成了聊天正文——同一个内部提示在屏幕上连着
 * 出现四次，而用户一个字也看不懂。
 */
function isToolRow(message: StoredMessage): boolean {
  if (message.toolCallId !== undefined) return true
  return textOf(message).startsWith(TOOL_RESULT_PREFIX)
}

/**
 * 这一轮之后小队产出了什么：最后一条用户消息之后的 agent 消息。
 *
 * 取「最后一条用户消息之后」而不是「本轮」：一轮里用户可能又被问了一次、答了一次，
 * 按消息位置切最贴近用户看到的东西。
 */
export function outputOf(messages: readonly StoredMessage[]): VibeOutputView[] {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined) continue
    if (message.senderType === 'user') {
      lastUser = i
      break
    }
  }
  const out: VibeOutputView[] = []
  for (const message of messages.slice(lastUser + 1)) {
    if (message.senderType !== 'agent') continue
    // 工具行不是小队说的话：内部机制不该上屏（问题卡才是小队问的那句话）。
    if (isToolRow(message)) continue
    const text = textOf(message)
    if (text.length === 0) continue
    out.push({ senderId: message.senderId ?? '', text, createdAt: message.createdAt, seq: message.seq })
  }
  return out
}

/** 一条待提交的答案。 */
interface AnswerItem {
  questionId: string
  selected?: string[]
  text?: string
}

/**
 * 从请求体里取出这一批答案。
 *
 * 两种形态都认：一张卡一次交（`answers: [...]`）与一道一交（`questionId` + `selected`）。
 */
function answerItemsOf(body: Record<string, unknown>): AnswerItem[] {
  const raw = body.answers
  if (Array.isArray(raw)) {
    const items: AnswerItem[] = []
    for (const entry of raw) {
      if (!isRecord(entry)) continue
      const questionId = strField(entry, 'questionId')
      if (questionId === undefined || questionId.length === 0) continue
      const selected = entry.selected === undefined ? undefined : stringArray(entry.selected)
      const text = strField(entry, 'text')?.trim()
      items.push({
        questionId,
        ...(selected === undefined ? {} : { selected }),
        ...(text === undefined || text.length === 0 ? {} : { text }),
      })
    }
    return items
  }
  const questionId = strField(body, 'questionId')
  if (questionId === undefined || questionId.length === 0) return []
  const selected = body.selected === undefined ? undefined : stringArray(body.selected)
  const text = strField(body, 'text')?.trim()
  return [
    {
      questionId,
      ...(selected === undefined ? {} : { selected }),
      ...(text === undefined || text.length === 0 ? {} : { text }),
    },
  ]
}

/**
 * 把这一轮的答案拼成小队共同看到的一段话。
 *
 * 答案必须**进正文**而不是只进某个 agent 的系统提示：问是全队一起问的，答案也得
 * 全队一起看见——否则没提问的那几位下一轮又缺同一块信息，用户就会被问两遍。
 */
function summaryOf(
  answered: readonly { question: string; answer?: string; selected?: string[] }[],
  skipped: boolean,
): string {
  const head = skipped ? '就按你们的默认方案来，不用再问了。' : '我选好了，按这些继续。'
  const lines = answered.map((entry) => {
    // 自己写的字优先于选项：用户写在题下面的那句话才是他要的答案，顺手勾着的
    // 那个选项只是预选，不该盖掉他写的内容。
    const own = entry.answer?.trim() ?? ''
    const choice = own.length > 0 ? own : (entry.selected ?? []).join('、')
    return `· ${entry.question} → ${choice}`
  })
  return lines.length === 0 ? head : [head, ...lines].join('\n')
}

/** 提问存储的领域错误翻成 4xx（与 routes/questions.ts 同一套约定）。 */
function sendQuestionFailure(error: unknown): never {
  if (error instanceof QuestionError) {
    if (error.code === 'NOT_FOUND') {
      throw new HttpRequestError(404, error.message, 'VIBE_UNKNOWN_QUESTION')
    }
    throw new HttpRequestError(400, error.message, 'VIBE_BAD_ANSWER')
  }
  throw error
}

/** 造出 RyVibe 路由的 handler。 */
export function registerVibeRoutes(router: Router, deps: VibeRoutesDeps): void {
  const { store, vibe, questions } = deps

  const viewOf = (session: VibeSession, pending: number): VibeSessionView => {
    const squad = session.memberAgentIds.map((id) => {
      const agent = store.getAgent(id)
      if (agent === undefined) return { id, name: id }
      const persona = normalizePersona(agent.persona)
      return {
        id,
        name: agent.name,
        ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
        temperament: {
          extroversion: persona.extroversion,
          rigor: persona.rigor,
          humor: persona.humor,
        },
      }
    })
    const busy = deps.isTurnActive(session.conversationId)
    // 状态是**存出来的**，不是现算的：现算的话一轮失败会落到「没有待答题、没有在跑
    // 的轮子」= done，页面于是宣布「方案好了」而下面空空如也。
    const status: VibeStatus =
      session.status === 'failed'
        ? 'failed'
        : session.status === 'done'
          ? 'done'
          : pending > 0
            ? 'asking'
            : busy
              ? 'building'
              : session.status
    return {
      id: session.id,
      conversationId: session.conversationId,
      requirement: session.requirement,
      skillId: session.skillId,
      squad,
      createdAt: session.createdAt,
      status,
      busy,
      pendingAnswers: pending,
      round: session.round,
      maxRounds: MAX_ROUNDS,
      ...(session.failure === undefined ? {} : { error: session.failure }),
      ...(session.project === undefined
        ? {}
        : {
            project: {
              name: session.project.name,
              slug: session.project.slug,
              kind: session.project.kind,
              dir: session.project.dir,
              files: session.project.files.map((file) => {
                return { name: file.name, size: file.size }
              }),
              createdAt: session.project.createdAt,
            },
          }),
    }
  }

  /** 会话必须还在（助理被删光时它也还在，只是没法再说话）。 */
  const conversationOf = (session: VibeSession): Conversation | undefined => {
    return store.getConversation(session.conversationId)
  }

  /** 开一次新的 RyVibe。 */
  router.post('/api/vibe', async (req, res) => {
    const body = await req.body()
    const requirement = strField(isRecord(body) ? body : {}, 'requirement')?.trim()
    if (requirement === undefined || requirement.length === 0) {
      throw new HttpRequestError(400, '说一句话就行：把你要做的东西写在这里', 'VIBE_BAD_REQUIREMENT')
    }
    if (requirement.length > MAX_REQUIREMENT_LENGTH) {
      throw new HttpRequestError(
        400,
        `写得太长了（${requirement.length} 字，上限 ${MAX_REQUIREMENT_LENGTH}）：一句话说清要什么，细节交给小队问`,
        'VIBE_BAD_REQUIREMENT',
      )
    }
    const squad = pickSquad(store.listAgents())
    const leader = squad[0]
    if (leader === undefined) {
      throw new HttpRequestError(409, '通讯录里还没有助理，先建一位再来', 'VIBE_NO_SQUAD')
    }
    const title = `RyVibe · ${requirement.slice(0, 18)}`
    const conversation = store.createConversation({
      kind: 'group',
      title,
      memberAgentIds: squad.map((member) => {
        return member.id
      }),
      dispatcherAgentId: leader.id,
    })
    const session = await vibe.create({
      conversationId: conversation.id,
      requirement,
      skillId: GRILL_ME_SKILL_ID,
      memberAgentIds: squad.map((member) => {
        return member.id
      }),
    })
    // 第一轮就是用户那句话本身：对话读起来是自然的，方法由 skill 注入，
    // 不必在用户的话上挂任何前缀。
    deps.enqueueTurn(
      {
        id: conversation.id,
        kind: conversation.kind,
        memberAgentIds: [...conversation.memberAgentIds],
        ...(conversation.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: conversation.dispatcherAgentId }),
      },
      requirement,
    )
    json(res, 201, { session: viewOf(session, 0) })
  })

  /** 一次 RyVibe 的当前状态：问到哪、还差几个答案、方案出来没有。 */
  router.get('/api/vibe/:id', async (req, res) => {
    const id = req.params.id ?? ''
    const session = vibe.get(id)
    if (session === undefined) {
      json(res, 404, { error: '没有这次 RyVibe' })
      return
    }
    const pending = questions.list(session.conversationId, 'pending')
    const messages = store.listMessages(session.conversationId, { limit: 60 })
    // 增量：页面拿它上次收到的最后一条序号当游标，只取新的产出。一段长方案每 1.2 秒
    // 重发整份，光传输就能把本机打满。
    const afterRaw = Number(req.query.get('after') ?? '0')
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0
    json(res, 200, {
      session: viewOf(session, pending.length),
      // 任务清单：落盘时写进待办的那几条。页面据此显示一份能打勾的清单——
      // 用户不用去聊天页右侧找，也知道"接下来要做什么"。
      todos: deps.todos.list(session.conversationId).items.map((item) => {
        return { id: item.id, text: item.text, done: item.done, createdAt: item.createdAt }
      }) satisfies TodoItem[],
      // 下发**全部**问题（已答的也在）：答完就该从卡片上消失的话，用户就没法核对
      // 「AI 到底问过我什么」——信任是从这里断的。已答的折成一行小字留在页面上。
      questions: questions.list(session.conversationId, 'all').map((question) => {
        return {
          id: question.id,
          question: question.question,
          options: question.options ?? [],
          ...(question.agentId === undefined ? {} : { agentId: question.agentId }),
          ...(question.answeredAt === undefined ? {} : { answered: true }),
          ...(question.selected === undefined ? {} : { selected: question.selected }),
          ...(question.answer === undefined ? {} : { answer: question.answer }),
        } satisfies VibeQuestionView
      }),
      output: outputOf(messages).filter((item) => {
        return item.seq > after
      }),
    })
  })

  /**
   * 读项目骨架里的一个文件。
   *
   * 只认落盘时记下的那份文件清单（白名单）：目录名与文件名都来自模型，让请求随便
   * 传一个路径进来，就等于开了一条任意文件读取的口子。
   */
  router.get('/api/vibe/:id/file', async (req, res) => {
    const id = req.params.id ?? ''
    const session = vibe.get(id)
    if (session === undefined) {
      json(res, 404, { error: '没有这次 RyVibe' })
      return
    }
    const project = session.project
    if (project === undefined) {
      json(res, 404, { error: '这次 RyVibe 还没有落盘项目' })
      return
    }
    const name = req.query.get('name') ?? ''
    const file = project.files.find((candidate) => {
      return candidate.name === name
    })
    if (file === undefined) {
      json(res, 404, { error: '项目里没有这个文件' })
      return
    }
    if (!existsSync(file.path)) {
      json(res, 404, { error: '文件已经不在了（可能被手动删掉或移动过）' })
      return
    }
    const size = statSync(file.path).size
    if (size > MAX_PROJECT_FILE_BYTES) {
      json(res, 413, { error: `文件太大（${size} 字节），读不了` })
      return
    }
    json(res, 200, { name: file.name, size, content: readFileSync(file.path, 'utf8') })
  })

  /**
   * 用户回答盘问：一次提交这张卡上的全部答案。
   *
   * 一次请求交全部（而不是一道一交）有两个好处：答案不���以只到提问的那位 agent
   * 手里（它被写进小队共同看到的那条消息里，谁都能读到）；也不会出现"四个请求
   * 依次到达、其中两个都以为答完了"而把小队跑两遍。
   *
   * `skipped` = 用户点了「按你们的默认方案来」：答案照旧落库（他们选的就是
   * 预选项），只是给小队的话术不同。
   */
  router.post('/api/vibe/:id/answer', async (req, res) => {
    const id = req.params.id ?? ''
    const session = vibe.get(id)
    if (session === undefined) {
      json(res, 404, { error: '没有这次 RyVibe' })
      return
    }
    const body = await req.body()
    if (!isRecord(body)) throw new HttpRequestError(400, '请求体必须是 JSON 对象', 'VIBE_BAD_ANSWER')
    const items = answerItemsOf(body)
    if (items.length === 0) {
      throw new HttpRequestError(400, '没有要回答的问题', 'VIBE_BAD_ANSWER')
    }
    const owned = questions.list(session.conversationId, 'all')
    for (const item of items) {
      // 归属先查：把 A 会话的题 id 传到 B 会话来答，答案会落进 A 的小队手里。
      const target = owned.find((question) => {
        return question.id === item.questionId
      })
      if (target === undefined) {
        throw new HttpRequestError(404, '这道题不在这条 RyVibe 里', 'VIBE_UNKNOWN_QUESTION')
      }
      const text = item.text ?? ''
      if (text.trim().length === 0 && (item.selected === undefined || item.selected.length === 0)) {
        throw new HttpRequestError(400, '选一个，或者自己写一句', 'VIBE_BAD_ANSWER')
      }
      // **自己写的字优先于选项**：用户在题下面写了话，那个字就是他真正要的答案；
      // 顺手勾着的那个选项只是预选，不该盖掉他写的内容。
      const answer = text.trim().length > 0 ? text.trim() : (item.selected ?? []).join('、')
      try {
        await questions.answer(item.questionId, {
          text: answer,
          ...(item.selected === undefined ? {} : { selected: item.selected }),
        })
      } catch (error) {
        // 提问存储的领域错误翻成 4xx（与 routes/questions.ts 同一套约定）：
        // 不翻就冒成 500，桌面端只能显示一句「再试一次」，看不出是自己 id 写错了。
        sendQuestionFailure(error)
      }
    }
    const pending = questions.list(session.conversationId, 'pending')
    const answered = questions.list(session.conversationId, 'answered')
    const skipped = body.skipped === true
    const summary = summaryOf(answered, skipped)
    // 「按你们的默认方案来」= 不再问了：之后小队拿到的是「问够了，去出方案」，
    // 而不是「还有三问，接着问」。
    if (skipped) await vibe.stopAsking(session.id)
    // 答案变了才让小队再跑一遍：同样的答案重复提交不必让它白跑一趟。
    const changed = await vibe.answer(session.id, pending.length, summary)
    if (changed) {
      const conversation = conversationOf(session)
      if (conversation !== undefined) {
        deps.enqueueTurn(
          {
            id: conversation.id,
            kind: conversation.kind,
            memberAgentIds: [...conversation.memberAgentIds],
            ...(conversation.dispatcherAgentId === undefined
              ? {}
              : { dispatcherAgentId: conversation.dispatcherAgentId }),
          },
          summary,
        )
      }
    }
    json(res, 200, { session: viewOf(session, pending.length) })
  })

  /**
   * 再来一次：把这一轮重新排一遍。
   *
   * 失败之后用户最需要的就是"再试一次"——失败原因（模型报错、额度用尽）多半是
   * 临时的。已经把答案交上去的，重试时带着答案一起走，免得再问一遍。
   */
  router.post('/api/vibe/:id/retry', async (req, res) => {
    const id = req.params.id ?? ''
    const session = vibe.get(id)
    if (session === undefined) {
      throw new VibeError('NOT_FOUND', '没有这次 RyVibe')
    }
    const conversation = conversationOf(session)
    if (conversation === undefined) {
      throw new VibeError('NOT_FOUND', '这次 RyVibe 的会话已经不在了')
    }
    const text = session.lastSummary ?? session.requirement
    await vibe.setStatus(session.id, 'building')
    deps.enqueueTurn(
      {
        id: conversation.id,
        kind: conversation.kind,
        memberAgentIds: [...conversation.memberAgentIds],
        ...(conversation.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: conversation.dispatcherAgentId }),
      },
      text,
    )
    json(res, 202, { session: viewOf(session, 0) })
  })

  /** 最近几次 RyVibe（页面上的「回到上次」）。 */
  router.get('/api/vibe', async (_req, res) => {
    json(res, 200, {
      sessions: vibe
        .list()
        .slice(0, 10)
        .map((session) => {
          const pending = questions.list(session.conversationId, 'pending')
          return viewOf(session, pending.length)
        }),
    })
  })
}
