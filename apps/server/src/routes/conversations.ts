/**
 * 会话域路由：会话 CRUD 与界面态、消息收发与分页、取消、调度轨迹、全文搜索、
 * 以及产物文件的上传与下载。
 *
 * 文件两条路由放在这里而不是单列一个域：上传端点本身就是会话作用域的
 * （POST /api/conversations/:id/files），而下载端点与它共用同一份落盘目录和
 * 同一套叶子名校验——放在一起，"附件落在哪、怎么防穿越"只有一处实现。
 * @module @ryagent/server/routes/conversations
 */

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Conversation, SessionStore, StoredMessage } from '@ryagent/session'
import { ARTIFACTS_DIR, guessMime } from '@ryagent/tools'
import type { WsEvent } from '../events.ts'
import { HttpRequestError, json, type Router, strField } from '../router.ts'

/** 投递一轮对话所需的会话形状（组合根的调度链按它排程）。 */
export interface TurnConversation {
  id: string
  kind: string
  memberAgentIds: string[]
  dispatcherAgentId?: string
}

/** 会话的界面态覆盖（SQLite 会话表没有这些列，另存一份 JSON）。 */
export interface ConversationState {
  title?: string
  pinned?: boolean
  muted?: boolean
  memberAgentIds?: string[]
}

/** 对外的会话形状：存储字段 + 界面态（置顶/静音，恒为布尔）。 */
export type ConversationView = Conversation & { pinned: boolean; muted: boolean }

/** 会话路由的依赖。 */
export interface ConversationRoutes {
  store: SessionStore
  /** 工具读写文件的工作区根目录（产物目录在其下）。 */
  workspaceRoot: string
  /** 界面态覆盖表：路由就地读写，落盘交给 persistConversationStates。 */
  conversationStates: Map<string, ConversationState>
  /** 把界面态覆盖表原子落盘。 */
  persistConversationStates: () => void
  /** 该会话当前的事件序号（握手基线 / 发送回执）。 */
  lastSeq: (conversationId: string) => number
  /** 广播一条 WS 事件。 */
  publish: (event: WsEvent) => void
  /** 把一轮对话排进该会话的串行链（异步执行，过程经 WS 推送）。 */
  enqueueTurn: (conversation: TurnConversation, text: string) => void
  /** 在途轮次的中止器（取消端点用它打断 LLM 流与工具执行）。 */
  activeTurns: Map<string, AbortController>
}

/** 消息列表单页条数上限（?limit 的上限，也用作 ?since= 的翻页步长）。 */
const MAX_MESSAGE_PAGE = 200
/** `?around=` 命中窗口：命中前后各取多少条（?window= 的缺省值与上限）。 */
const DEFAULT_AROUND_WINDOW = 25
const MAX_AROUND_WINDOW = 50
/**
 * `?around=` 向前回扫找命中消息的最大条数。
 *
 * 存储层只有 beforeSeq 这一个游标（没有"按 id 取 seq"也没有"取某 seq 之后"），
 * 命中消息的 seq 只能靠回扫找出来。找不到就 404，不做无界扫描——一次搜索跳转
 * 不该把整个会话拖进内存。
 */
const MAX_AROUND_SCAN = 2000
/** 全文搜索返回的条数上限。 */
const MAX_SEARCH_RESULTS = 50
/** 全文搜索每个会话回看的消息条数上限（倒序翻页，够用且不让搜索变成全库扫描）。 */
const SEARCH_SCAN_PER_CONVERSATION = 500
/** 全文搜索回看的会话上限。 */
const MAX_SEARCH_CONVERSATIONS = 1000
/** 搜索命中窗口长度（snippet 前后各留的字符数）。 */
const SEARCH_SNIPPET_RADIUS = 60

/** 单个附件的大小上限（20MB，与渲染层的客户端预检同值）。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** 附件名的长度上限：够放下正常文件名，又不至于撞上文件系统上限。 */
const MAX_UPLOAD_NAME_LENGTH = 200
/** 同名去重的后缀尝试次数。 */
const MAX_UPLOAD_NAME_ATTEMPTS = 1000

/** 把界面态覆盖叠加到存储的会话行上。 */
function conversationView(conversation: Conversation, state: ConversationState | undefined): ConversationView {
  return {
    ...conversation,
    ...(state?.title === undefined ? {} : { title: state.title }),
    ...(state?.memberAgentIds === undefined ? {} : { memberAgentIds: state.memberAgentIds }),
    pinned: state?.pinned === true,
    muted: state?.muted === true,
  }
}

/**
 * 会话的对外视图：存储行 + 界面态覆盖。
 *
 * 成员覆盖按"当前仍存在的 agent"过滤：删 agent 时 store 会从会话成员里摘掉
 * 它，而覆盖表里的旧名单不该把它复活成幽灵成员。
 */
function conversationViewOf(
  store: SessionStore,
  states: Map<string, ConversationState>,
  conversation: Conversation,
): ConversationView {
  const state = states.get(conversation.id)
  if (state?.memberAgentIds === undefined) return conversationView(conversation, state)
  const memberAgentIds = state.memberAgentIds.filter((id) => {
    return store.getAgent(id) !== undefined
  })
  return conversationView(conversation, { ...state, memberAgentIds })
}

/** 校验群成员名单：非空、字符串、每个 agent 都已存在（不合法抛 400）。 */
function parseMemberAgentIds(store: SessionStore, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpRequestError(400, 'memberAgentIds must be a non-empty array of agent ids')
  }
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new HttpRequestError(400, 'memberAgentIds must be a non-empty array of agent ids')
    }
    if (ids.includes(entry)) continue
    if (store.getAgent(entry) === undefined) throw new HttpRequestError(400, `unknown agent "${entry}"`)
    ids.push(entry)
  }
  return ids
}

/** 消息行的可搜索正文（仅 type=text 块；工具载荷不进搜索索引）。 */
function messageSearchText(row: StoredMessage): string {
  return row.contentBlocks
    .filter((block) => {
      const candidate = block as { type?: string; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string'
    })
    .map((block) => {
      return String((block as { text?: unknown }).text ?? '')
    })
    .join('\n')
}

/** 搜索命中的一行（GET /api/search 的结果项）。 */
interface SearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  snippet: string
  /** 发言者 id：agent 消息是 agent id，用户消息是 'user'。 */
  agentId: string
  createdAt: number
}

/** 截一段以命中处为中心的上下文；命中位置未知时取开头。 */
function searchSnippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return flat.slice(0, SEARCH_SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + needle.length + SEARCH_SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * `?since=` 增量拉取：只要 seq 比游标大的消息，按 seq 升序、取最新 limit 条。
 *
 * store.listMessages 只有 beforeSeq（向过去翻页）这一个游标，没有"取某 seq
 * 之后"的语义，所以从最新一页往回走，攒够 limit 条或越过 since 为止。正常
 * 情况（一页 200 条之内）就是一次查询；断线很久也只多走几页。
 */
function listMessagesSince(
  store: SessionStore,
  conversationId: string,
  sinceSeq: number,
  limit: number,
): StoredMessage[] {
  const pageSize = MAX_MESSAGE_PAGE
  const collected: StoredMessage[] = []
  let beforeSeq: number | undefined
  for (;;) {
    const page = store.listMessages(conversationId, {
      limit: pageSize,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    })
    if (page.length === 0) break
    for (const message of page) {
      if (message.seq > sinceSeq) collected.push(message)
    }
    // 页内按 seq 升序：首条是本页最旧的一条，越过游标（或取空）就说明扫完了。
    const oldest = page[0]
    if (oldest === undefined || oldest.seq <= sinceSeq) break
    beforeSeq = oldest.seq
  }
  // 页是从新往旧取的，跨页拼回来的顺序是乱的：统一排成 seq 升序后取末尾
  // limit 条（末尾即最新）。
  collected.sort((a, b) => {
    return a.seq - b.seq
  })
  return collected.slice(-limit)
}

/**
 * 会话内消息全文搜索：每个会话倒序回看最近 {@link SEARCH_SCAN_PER_CONVERSATION}
 * 条，命中就取命中处上下文的片段，按时间倒序取前 {@link MAX_SEARCH_RESULTS} 条。
 *
 * 本地 SQLite 没有 FTS 索引（消息正文存在 content_blocks 的 JSON 里），这里在
 * 内存里做子串匹配：单机几百条消息的量级下足够快，也不用给会话表加索引轴。
 */
function searchMessages(
  store: SessionStore,
  states: Map<string, ConversationState>,
  query: string,
  conversationId: string | undefined,
): SearchResult[] {
  const needle = query.toLowerCase()
  const conversations =
    conversationId === undefined
      ? store.listConversations(MAX_SEARCH_CONVERSATIONS)
      : [store.getConversation(conversationId)].filter((row) => {
          return row !== undefined
        })
  const results: SearchResult[] = []
  for (const conversation of conversations) {
    // 标题取界面态视图：改过名的会话在搜索结果里就该显示改后的名字。
    const conversationTitle = conversationViewOf(store, states, conversation).title
    let scanned = 0
    let beforeSeq: number | undefined
    for (;;) {
      const page = store.listMessages(conversation.id, {
        limit: MAX_MESSAGE_PAGE,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      if (page.length === 0) break
      for (const message of page) {
        const text = messageSearchText(message)
        if (text.length === 0 || !text.toLowerCase().includes(needle)) continue
        results.push({
          conversationId: conversation.id,
          conversationTitle,
          messageId: message.id,
          snippet: searchSnippet(text, needle),
          agentId: message.senderId ?? message.senderType,
          createdAt: message.createdAt,
        })
      }
      scanned += page.length
      const oldest = page[0]
      if (scanned >= SEARCH_SCAN_PER_CONVERSATION || oldest === undefined) break
      beforeSeq = oldest.seq
    }
  }
  results.sort((a, b) => {
    return b.createdAt - a.createdAt
  })
  return results.slice(0, MAX_SEARCH_RESULTS)
}

/** 回扫找一条消息的 seq；翻过 {@link MAX_AROUND_SCAN} 条还没找到就当不存在。 */
function findMessageSeq(store: SessionStore, conversationId: string, messageId: string): number | undefined {
  let scanned = 0
  let beforeSeq: number | undefined
  for (;;) {
    const page = store.listMessages(conversationId, {
      limit: MAX_MESSAGE_PAGE,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    })
    if (page.length === 0) return undefined
    for (const message of page) {
      if (message.id === messageId) return message.seq
    }
    scanned += page.length
    const oldest = page[0]
    if (scanned >= MAX_AROUND_SCAN || oldest === undefined) return undefined
    beforeSeq = oldest.seq
  }
}

/** 「seq < X 的最后 window 条里，最早那条的 seq」——不够 window 条时返回 undefined。 */
function windowBottomSeq(
  store: SessionStore,
  conversationId: string,
  beforeSeq: number,
  window: number,
): number | undefined {
  const page = store.listMessages(conversationId, { limit: window, beforeSeq })
  return page.length >= window ? page[0]?.seq : undefined
}

/**
 * `?around=`：以命中消息为中心的一段窗口（命中前后各 window 条，含命中本身）。
 *
 * 全文搜索能把任意一条历史消息指给用户，但聊天区一次只加载最新一页——命中多半不在
 * 已加载的窗口里，此前只能"点了没反应"。这段窗口就是给那次跳转补齐上下文的。
 *
 * 存储层只有 beforeSeq 这一个游标（`seq < beforeSeq`），两个方向因此不对称：
 * - 命中**之前**的 window 条：一次 `beforeSeq = hitSeq`；
 * - 命中**之后**的 window 条要的是「离命中最近的那 window 条」，而游标只能往回走。
 *   从最新一页倒着扫能把"最新的 window 条"捞出来（不是要的这段），整段扫完又贵，
 *   所以按 seq 二分：`beforeSeq = X` 那页的最早一条是否仍大于命中 seq，对 X 单调，
 *   十几次 1 行查询就能定位到那条边界。
 */
function messagesAround(
  store: SessionStore,
  conversationId: string,
  messageId: string,
  window: number,
): { messages: StoredMessage[]; hitSeq: number } | undefined {
  const hitSeq = findMessageSeq(store, conversationId, messageId)
  if (hitSeq === undefined) return undefined
  const before = store.listMessages(conversationId, { limit: window, beforeSeq: hitSeq })
  // `seq < hitSeq + 1` ⇔ `seq ≤ hitSeq`：这一页的最后一条正是命中本身。
  const hit = store.listMessages(conversationId, { limit: 1, beforeSeq: hitSeq + 1 })[0]
  if (hit === undefined || hit.id !== messageId) return undefined
  const latest = store.listMessages(conversationId, { limit: 1 })[0]
  // 二分「最早的那个 X，使 seq < X 的最后 window 条全部晚于命中」；找不到就是命中
  // 之后不足 window 条——那就把已有的全取出来（最新一页里 seq 大于命中的那些）。
  let after: StoredMessage[] = []
  if (latest !== undefined) {
    let low = hitSeq + 1
    let high = latest.seq + 1
    let boundary: number | undefined
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const bottom = windowBottomSeq(store, conversationId, mid, window)
      if (bottom !== undefined && bottom > hitSeq) {
        boundary = mid
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    after =
      boundary === undefined
        ? store.listMessages(conversationId, { limit: window, beforeSeq: latest.seq + 1 }).filter((message) => {
            return message.seq > hitSeq
          })
        : store.listMessages(conversationId, { limit: window, beforeSeq: boundary })
  }
  return { messages: [...before, hit, ...after], hitSeq }
}

/**
 * 附件名的消毒：只放行叶子名。
 *
 * 挡掉路径分隔符、`.`/`..` 与控制字符——落盘目录与文件名一拼就能被带到目录外，
 * 或者写到 `.ryagent-artifacts` 自己头上。
 */
function sanitizeUploadName(raw: string): string {
  const name = raw.trim()
  if (name.length === 0) throw new HttpRequestError(400, 'name is required')
  if (name.length > MAX_UPLOAD_NAME_LENGTH) throw new HttpRequestError(400, 'file name is too long')
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new HttpRequestError(400, 'file name must be a leaf name')
  }
  for (const char of name) {
    // C0 控制字符与 DEL：文件名里出现它们时，各平台的行为从"原样创建"到
    // "静默截断"都有，一律拒掉。
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) throw new HttpRequestError(400, 'file name must be a leaf name')
  }
  return name
}

/** 回给前端的 MIME：只认形如 type/subtype 的短串，其余按扩展名推断。 */
function resolveUploadMime(raw: unknown, name: string): string {
  const fallback = guessMime(name)
  if (typeof raw !== 'string') return fallback
  const mime = raw.trim()
  if (mime.length === 0 || mime.length > 200 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) return fallback
  return mime
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * 解 base64 载荷（允许 `data:<mime>;base64,` 前缀，容忍换行）。
 *
 * 校验分三道：字符集与长度按 4 字节对齐（拒绝截断）；解码后回编码必须逐字相等
 * （Buffer.from 对非规范尾部是宽容的，悄悄少解几个字节等于存下一个坏文件）；
 * 解码前后各卡一次上限（解码前卡的是已经在内存里的那串 base64）。
 */
function decodeUploadPayload(data: string): Buffer {
  const stripped = data.replace(/\s/g, '')
  const comma = stripped.indexOf(',')
  const payload = stripped.startsWith('data:') && comma > 0 ? stripped.slice(comma + 1) : stripped
  if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64_PATTERN.test(payload)) {
    throw new HttpRequestError(400, 'data must be base64-encoded file content')
  }
  if ((payload.length / 4) * 3 > MAX_UPLOAD_BYTES + 3) {
    throw new HttpRequestError(413, `file is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.toString('base64') !== payload) throw new HttpRequestError(400, 'data is not canonical base64')
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new HttpRequestError(413, `file is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
  }
  return bytes
}

/**
 * 目标已存在时追加 `-2`、`-3`… 后缀。
 *
 * 产物目录是所有会话与 file_produce 共用的：同名上传覆盖别人的产物，附件就会
 * 悄悄变成另一个文件。
 */
function uniqueArtifactName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let attempt = 2; attempt < MAX_UPLOAD_NAME_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
  throw new HttpRequestError(409, 'too many files with the same name')
}

/** 会话域的全部路由。 */
export function registerConversationRoutes(router: Router, deps: ConversationRoutes): void {
  const { store, workspaceRoot, conversationStates, activeTurns } = deps
  const viewOf = (conversation: Conversation): ConversationView => {
    return conversationViewOf(store, conversationStates, conversation)
  }
  const writeState = (id: string, state: ConversationState | undefined): void => {
    if (state === undefined) conversationStates.delete(id)
    else conversationStates.set(id, state)
    deps.persistConversationStates()
  }
  /** 产物目录（附件与 file_produce 共用）：GET/POST 两条文件路由同源。 */
  const artifactsDir = (): string => {
    return join(workspaceRoot, ARTIFACTS_DIR)
  }

  router.get('/api/conversations', async (_req, res) => {
    const conversations = store.listConversationsWithPreview()
    json(res, 200, { conversations: conversations.map((row) => viewOf(row)) })
  })

  /**
   * 会话设置面：改名、置顶、静音、群成员增减。
   *
   * 群聊换成员必须把调度员留在名单里——调度员不在名单里时群里每条消息都会
   * 以 UNKNOWN_AGENT 报错（"群一进去就哑"），这里直接 400 不落盘。置顶/静音/
   * 改名不进会话表（没有这些列），落在 <dataDir>/conversation-state.json。
   */
  router.patch('/api/conversations/:id', async (req, res) => {
    const conversationId = req.params.id as string
    const existing = store.getConversation(conversationId)
    if (existing === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const body = await req.body()
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const current = conversationStates.get(conversationId) ?? {}
    const next: ConversationState = { ...current }
    const patchable = ['title', 'pinned', 'muted', 'memberAgentIds'] as const
    const touched = patchable.some((key) => {
      return record[key] !== undefined
    })
    if (record.title !== undefined) {
      if (typeof record.title !== 'string') throw new HttpRequestError(400, 'field "title" must be a string')
      next.title = record.title
    }
    for (const flag of ['pinned', 'muted'] as const) {
      const value = record[flag]
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw new HttpRequestError(400, `field "${flag}" must be a boolean`)
      next[flag] = value
    }
    if (record.memberAgentIds !== undefined) {
      const memberAgentIds = parseMemberAgentIds(store, record.memberAgentIds)
      // 单聊的语义是"用户与某一个 agent"，多于一个成员就不再是单聊。
      if (existing.kind === 'direct' && memberAgentIds.length !== 1) {
        throw new HttpRequestError(400, 'a direct conversation must keep exactly one member agent')
      }
      const dispatcherAgentId = existing.dispatcherAgentId
      if (dispatcherAgentId !== undefined && !memberAgentIds.includes(dispatcherAgentId)) {
        throw new HttpRequestError(400, `dispatcher "${dispatcherAgentId}" must be one of memberAgentIds`)
      }
      next.memberAgentIds = memberAgentIds
    }
    // 空补丁不落盘：否则每个会话都会凭空多出一条空的界面态记录。
    if (touched) writeState(conversationId, next)
    const updated = store.getConversation(conversationId)
    json(res, 200, { conversation: updated === undefined ? undefined : viewOf(updated) })
  })

  router.post('/api/conversations', async (req, res) => {
    const body = await req.body()
    const kind = strField(body, 'kind')
    // 校验一律抛 HttpRequestError（400 + 机器码），由 dispatch 统一成响应；
    // 落库失败不再 catch 成 400——那是服务端故障，冒成 400 会让调用方
    // 以为改改请求体就能成。
    if (kind === 'direct') {
      const agentId = strField(body, 'agentId')
      if (agentId === undefined) throw new HttpRequestError(400, 'direct conversation requires agentId')
      if (store.getAgent(agentId) === undefined) throw new HttpRequestError(400, `unknown agent "${agentId}"`)
      const conversation = store.createConversation({
        kind: 'direct',
        title: strField(body, 'title') ?? store.getAgent(agentId)?.name ?? '',
        memberAgentIds: [agentId],
      })
      json(res, 201, { conversation })
      return
    }
    if (kind === 'group') {
      const memberIds = (body as { memberAgentIds?: unknown })?.memberAgentIds
      if (!Array.isArray(memberIds) || memberIds.length === 0) {
        throw new HttpRequestError(400, 'group conversation requires non-empty memberAgentIds')
      }
      if (
        memberIds.some((id) => {
          return typeof id !== 'string'
        })
      ) {
        throw new HttpRequestError(400, 'memberAgentIds must be an array of agent ids')
      }
      const members = memberIds as string[]
      for (const id of members) {
        if (store.getAgent(id) === undefined) throw new HttpRequestError(400, `unknown agent "${id}"`)
      }
      const dispatcherAgentId = strField(body, 'dispatcherAgentId') ?? 'ryen'
      // 调度员必须在成员名单里：群聊第一轮就是由它派工，不在名单里的话每条
      // 消息都会以 UNKNOWN_AGENT 报错（"群一进去就哑"）。前端勾选成员与选
      // 调度员是两处独立状态，这里是最后一道闸——不合法直接 400，不建群。
      if (!members.includes(dispatcherAgentId)) {
        throw new HttpRequestError(400, `dispatcher "${dispatcherAgentId}" must be one of memberAgentIds`)
      }
      const conversation = store.createConversation({
        kind: 'group',
        title: strField(body, 'title') ?? '群聊',
        memberAgentIds: members,
        dispatcherAgentId,
      })
      json(res, 201, { conversation })
      return
    }
    throw new HttpRequestError(400, 'kind must be "direct" or "group"')
  })

  router.get('/api/conversations/:id', async (req, res) => {
    const conversationId = req.params.id as string
    const conversation = store.getConversation(conversationId)
    // 会话级累计 token：从各条消息的 usage 求和，成本随历史一起可查。
    if (conversation === undefined) json(res, 404, { error: 'conversation not found' })
    else
      json(res, 200, {
        conversation: viewOf(conversation),
        usage: store.conversationUsage(conversationId),
      })
  })

  router.delete('/api/conversations/:id', async (req, res) => {
    if (store.getConversation(req.params.id as string) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    store.deleteConversation(req.params.id as string)
    // 界面态覆盖一起清掉：否则覆盖表里留下一个永不消失的幽灵会话条目。
    writeState(req.params.id as string, undefined)
    json(res, 200, { deleted: req.params.id })
  })

  /** 取消生成：中止该会话在途的一轮（LLM 流 + 工具执行）。 */
  router.post('/api/conversations/:id/cancel', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const controller = activeTurns.get(conversationId)
    if (controller === undefined) {
      json(res, 200, { cancelled: false })
      return
    }
    controller.abort()
    json(res, 200, { cancelled: true })
  })

  /** 标记已读：lastReadSeq 推进到最新 seq。 */
  router.post('/api/conversations/:id/read', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const lastReadSeq = store.markConversationRead(conversationId)
    json(res, 200, { conversationId, lastReadSeq })
  })

  /** 调度事件历史（右栏调度轨迹）。 */
  router.get('/api/conversations/:id/dispatch', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    json(res, 200, { events: store.listDispatchEvents(conversationId) })
  })

  router.get('/api/conversations/:id/messages', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const rawLimit = Number(req.query.get('limit') ?? '50')
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_MESSAGE_PAGE) : 50
    const before = req.query.get('before')
    const since = req.query.get('since')
    const around = req.query.get('around')
    if (around !== null && around.length > 0) {
      // around 是搜索命中的定位游标：取命中前后各若干条（含命中本身），供聊天区
      // 把一条不在已加载页里的历史消息插进流里再滚过去。它与 before/since 互斥，
      // 给了 around 就以它为准（客户端跳转到一条具体消息，要的不是"最新一页"）。
      const rawWindow = Number(req.query.get('window') ?? DEFAULT_AROUND_WINDOW)
      const window =
        Number.isFinite(rawWindow) && rawWindow > 0
          ? Math.min(Math.trunc(rawWindow), MAX_AROUND_WINDOW)
          : DEFAULT_AROUND_WINDOW
      const found = messagesAround(store, conversationId, around, window)
      if (found === undefined) {
        json(res, 404, { error: 'message not found' })
        return
      }
      json(res, 200, { messages: found.messages, hit: { messageId: around, seq: found.hitSeq } })
      return
    }
    if (since !== null && since.length > 0) {
      // since 是 seq 游标（客户端断线重连后补齐缺口用），非法数字直接 400：
      // 悄悄当成 0 会把整段历史当增量发过去。
      const sinceSeq = Number(since)
      if (!Number.isFinite(sinceSeq)) {
        json(res, 400, { error: 'since must be a seq number' })
        return
      }
      json(res, 200, { messages: listMessagesSince(store, conversationId, sinceSeq, limit) })
      return
    }
    const rows = store.listMessages(conversationId, {
      limit,
      ...(before === null || before.length === 0 ? {} : { beforeSeq: Number(before) }),
    })
    json(res, 200, { messages: rows })
  })

  router.post('/api/conversations/:id/messages', async (req, res) => {
    const conversationId = req.params.id as string
    const stored = store.getConversation(conversationId)
    if (stored === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    // 按界面态视图（改名/群成员覆盖）派工：PATCH 改完成员，下一条消息就该按新名单走。
    const conversation = viewOf(stored)
    const text = strField(await req.body(), 'text')
    if (text === undefined) {
      json(res, 400, { error: 'body.text is required' })
      return
    }
    deps.publish({
      type: 'message-start',
      conversationId,
      senderId: 'user',
      senderName: '用户',
      turnIndex: store.nextTurnIndex(conversationId),
    })
    // 202：处理异步进行，过程经 WS 推送；同会话消息串行排队。
    deps.enqueueTurn(conversation, text)
    // 回执带上此刻的事件 seq：客户端的订阅可能晚于这次发送建立（欢迎页就是
    // 先 setActiveId 再 postMessage），拿着这个基线才能算出订阅期间漏了几条。
    json(res, 202, { accepted: true, conversationId, streamSeq: deps.lastSeq(conversationId) })
  })

  /**
   * 该会话当前的事件序号：客户端握手前读一次当缺口检测基线。
   * 与 POST /messages 回执里的 streamSeq 同源，区别只是这里可以随时单独读。
   */
  router.get('/api/conversations/:id/stream-seq', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    json(res, 200, { seq: deps.lastSeq(conversationId) })
  })

  /**
   * 会话内全文搜索：`?q=`（必填，空串直接回空数组，不做无意义的全库扫描）
   * 与可选的 `?conversationId=`（只在指定会话里找）。
   *
   * 返回按消息时间倒序、最多 {@link MAX_SEARCH_RESULTS} 条，每条带会话标题与
   * 命中片段（片段是给列表展示看的上下文，不回整条正文）。
   */
  router.get('/api/search', async (req, res) => {
    const query = (req.query.get('q') ?? '').trim()
    if (query.length === 0) {
      json(res, 200, { results: [] })
      return
    }
    const conversationId = req.query.get('conversationId')
    json(res, 200, {
      results: searchMessages(
        store,
        conversationStates,
        query,
        conversationId === null || conversationId.length === 0 ? undefined : conversationId,
      ),
    })
  })

  // ---- files（产物上传/下载，白名单=工作区产物目录）----

  /**
   * 上传附件：body `{name, mime, data(base64)}` → `{name, size, mime}`。
   *
   * 字节以 base64 走 JSON（与消息体同一条通路），解码后落进工作区产物目录，
   * 于是附件和 file_produce 的产物是同一份东西——回执形状与产物卡片同构，
   * 渲染层不用为附件单开一条取文件的路径。
   *
   * 三道闸：文件名只放行叶子名且同名不覆盖（附件目录是全会话共享的）；
   * 体积上限 20MB；base64 必须规范（非规范尾部会被 Buffer 悄悄少解字节）。
   */
  router.post('/api/conversations/:id/files', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const body = await req.body()
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const rawName = typeof record.name === 'string' ? record.name : ''
    const rawData = typeof record.data === 'string' ? record.data : ''
    if (rawName.trim().length === 0) {
      json(res, 400, { error: 'name is required' })
      return
    }
    if (rawData.trim().length === 0) {
      json(res, 400, { error: 'data is required' })
      return
    }
    const name = sanitizeUploadName(rawName)
    const bytes = decodeUploadPayload(rawData)
    const mime = resolveUploadMime(record.mime, name)
    const dir = artifactsDir()
    mkdirSync(dir, { recursive: true })
    const stored = uniqueArtifactName(dir, name)
    const target = join(dir, stored)
    try {
      writeFileSync(target, bytes)
    } catch (error) {
      json(res, 500, { error: `write failed: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    json(res, 200, { name: stored, size: statSync(target).size, mime })
  })

  router.get('/api/files/:name', async (req, res) => {
    const name = req.params.name as string
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      json(res, 400, { error: 'file name must be a leaf name' })
      return
    }
    const target = join(artifactsDir(), name)
    if (!existsSync(target)) {
      json(res, 404, { error: `file not found: ${name}` })
      return
    }
    res.writeHead(200, { 'content-type': guessMime(name) })
    createReadStream(target).pipe(res)
  })
}
