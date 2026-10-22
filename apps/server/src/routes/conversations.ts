/**
 * 会话域路由：会话 CRUD 与界面态、消息收发与分页、取消、调度轨迹、全文搜索、
 * 以及产物文件的上传与下载。
 *
 * 文件两条路由放在这里而不是单列一个域：上传端点本身就是会话作用域的
 * （POST /api/conversations/:id/files），而下载端点与它共用同一份落盘目录和
 * 同一套叶子名校验——放在一起，"附件落在哪、怎么防穿越"只有一处实现。
 * @module @ryharness/server/routes/conversations
 */

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Conversation, SessionStore, StoredMessage } from '@ryharness/session'
import { ARTIFACTS_DIR, guessMime, PathEscapeError, resolveTarget } from '@ryharness/tools'
import type { WsEvent } from '../events.ts'
import { PROACTIVE_BLOCK_TYPE } from '../proactive.ts'
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
  /**
   * 把一轮对话排进该会话的串行链（异步执行，过程经 WS 推送）。
   *
   * `replay: true` = 重放：库里已经有那条用户消息了，本轮不再追加一条新的。
   *
   * @returns 本轮领到的轮次序号（发事件要用它，两端才对得上）。
   */
  enqueueTurn: (conversation: TurnConversation, text: string, options?: { replay?: boolean }) => number
  /**
   * 改写该会话的历史，并把被改写的那一轮重放一遍。
   *
   * 与 {@link enqueueTurn} 分开，是因为「编辑并重发 / 重新生成」要动的是**历史本身**，
   * 而历史是同会话所有轮次共用的：在途那一轮正按旧历史生成，它收工时还会往库里写
   * 最后几条消息。截断若不排进串行链，就会出现"问 B 答 A"——库里被截掉的那段后面
   * 又冒出来一句旧答案。
   *
   * 返回的 Promise 在**历史已经改完**时兑现：调用方拿到兑现的那一刻，库里已经是
   * 改写后的样子，可以安全地重拉历史。
   */
  rewriteHistory: (
    conversation: TurnConversation,
    plan: {
      /** 截断起点（含）：该 seq 起的一切都删掉。 */
      truncateFrom: number
      /** 要原地改写的用户消息正文（编辑路径）。 */
      editText?: { seq: number; text: string }
      /** 重放用的提示词：库里那条用户消息的正文。 */
      replayText: string
    },
  ) => Promise<{ applied: boolean; error?: string }>
  /**
   * 取消该会话：中止在途的一轮并清掉还没开始的排队轮次。
   *
   * 回执 `{cancelled, queueCleared}`：前者是有没有中止到在途那一轮，后者是**实际
   * 清掉的排队条数**（0 = 队列本来就是空的），调用方据此如实知道这次取消动了什么。
   */
  cancelTurn: (conversationId: string) => { cancelled: boolean; queueCleared: number }
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
/** 搜索命中窗口长度（snippet 前后各留的字符数）。 */
const SEARCH_SNIPPET_RADIUS = 60

/** 单个附件的大小上限（20MB，与渲染层的客户端预检同值）。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** 附件名的长度上限：够放下正常文件名，又不至于撞上文件系统上限。 */
const MAX_UPLOAD_NAME_LENGTH = 200
/** 同名去重的后缀尝试次数。 */
const MAX_UPLOAD_NAME_ATTEMPTS = 1000
/** 内嵌预览的单文件字节上限（比上传宽一档：预览要的是既有产物，不是新收的东西）。 */
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024

/** 预览两条路由共享的文件解析结果。 */
interface PreviewFile {
  name: string
  path: string
  size: number
  mime: string
}

/**
 * 解析工作区产物目录里的一个叶子名，拿到预览要用的元数据。
 *
 * 边界复用 fs 工具那一份 `resolveTarget` 而不是另写：预览读的字节和模型用
 * fs_read 读的是同一片工作区，两条通路对「工作区里的符号链接指到外面」必须
 * 有同一个答案。名字先过 `sanitizeUploadName`（叶子名 + 控制字符），所以
 * `PathEscapeError` 在这里只可能来自符号链接。
 *
 * @throws HttpRequestError - 逃出工作区（403）、文件不存在或不是普通文件（404）。
 */
function statArtifact(workspaceRoot: string, name: string): PreviewFile {
  let target: string
  try {
    target = resolveTarget(workspaceRoot, join(ARTIFACTS_DIR, name))
  } catch (error) {
    if (error instanceof PathEscapeError) throw new HttpRequestError(403, 'file escapes workspace root')
    throw error
  }
  const stat = statSync(target, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile()) throw new HttpRequestError(404, `file not found: ${name}`)
  return { name, path: target, size: stat.size, mime: guessMime(name) }
}

/**
 * 「Ryen 主动找过你」的判定：回看该会话最近这么多条消息里有没有标记块。
 *
 * 列表接口不读消息正文，只回看**最近**的一段：主动消息是每天至多一条、且必然落在
 * 最近的位置，回看 20 条足够命中；真被刷屏冲掉也只是角标不再提示，那条消息本身还在。
 * 代价是每个会话一次带索引的小查询，与这个接口本来就有的每会话两个子查询同量级。
 */
const PROACTIVE_FLAG_SCAN_LIMIT = 20

/** 这条消息是不是 Ryen 主动发来的（内容块里有标记块）。 */
function hasProactiveMessage(store: SessionStore, conversationId: string): boolean {
  return store.listMessages(conversationId, { limit: PROACTIVE_FLAG_SCAN_LIMIT }).some((message) => {
    return message.contentBlocks.some((block) => {
      return (block as { type?: unknown }).type === PROACTIVE_BLOCK_TYPE
    })
  })
}

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
 * 会话内消息全文搜索：走存储层的 FTS5 索引（messages_fts）。
 *
 * 索引是**写消息时在同一事务里**维护的（{@link SessionStore.appendMessage} →
 * indexMessage），删会话时同步清理，正文按 bigram 分词后入表；查询是一次
 * MATCH + bm25() 排序，命中直接带着正文回来。
 *
 * 此前这里自己写了一套"每个会话倒序回看最近 500 条 + 内存子串匹配"的扫描：
 * 会话上限 1000，每行还要 JSON.parse 一遍正文——整段**同步跑在 Node 主线程**
 * 上。几百个会话 × 数万条消息时，那是几百毫秒到数秒的事件循环阻塞：正在
 * 流式的那一轮的 WS 帧发不出去，/cancel 排在后面，界面看起来就是卡住了。
 * 索引早就在（schema v5 建表 + 迁移回填 + 6 组测试覆盖），缺的只是路由没用它。
 *
 * 口径变化（有意为之）：范围从"最近若干条"变成全库，排序从时间倒序变成
 * BM25 相关度（越小越相关）。搜索框要的是"最相关的那几条"，不是"最近提到
 * 关键词的那几条"。
 *
 * 已知边界：索引按**相邻两字**一个 token 建，单字查询（"的"）只有正文恰好
 * 是那一个字时才命中。渲染层因此把搜索的最短输入设成两个字。
 */
function searchMessages(
  store: SessionStore,
  states: Map<string, ConversationState>,
  query: string,
  conversationId: string | undefined,
): SearchResult[] {
  const needle = query.toLowerCase()
  const hits = store.searchMessages(query, {
    limit: MAX_SEARCH_RESULTS,
    ...(conversationId === undefined ? {} : { conversationId }),
  })
  const results: SearchResult[] = []
  // 同一会话的多条命中只查一次会话行：标题取界面态视图（改过名的会话在搜索
  // 结果里就该显示改后的名字）。
  const titleCache = new Map<string, string>()
  for (const hit of hits) {
    let title = titleCache.get(hit.conversationId)
    if (title === undefined) {
      const conversation = store.getConversation(hit.conversationId)
      // 会话在命中之后被删：索引行随会话一起清掉了，这里再兜一层，不让一条
      // 没有归属的命中出现在结果里。
      if (conversation === undefined) continue
      title = conversationViewOf(store, states, conversation).title
      titleCache.set(hit.conversationId, title)
    }
    results.push({
      conversationId: hit.conversationId,
      conversationTitle: title,
      messageId: hit.messageId,
      snippet: searchSnippet(hit.text, needle),
      agentId: hit.senderId ?? hit.senderType,
      createdAt: hit.createdAt,
    })
  }
  return results
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
 * 或者写到 `.ryharness-artifacts` 自己头上。
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

/**
 * 一条消息里的第一段正文（工具结果、产物块都不算正文）。
 *
 * "重新生成"要重跑的是用户那句话——从消息块里把正文取出来的那一段。
 */
function firstTextOf(contentBlocks: readonly unknown[]): string {
  for (const block of contentBlocks) {
    const candidate = block as { type?: string; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text
  }
  return ''
}

/** 会话域的全部路由。 */
export function registerConversationRoutes(router: Router, deps: ConversationRoutes): void {
  const { store, workspaceRoot, conversationStates } = deps
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
    json(res, 200, {
      // proactive=true 表示「Ryen 在这个会话里主动找过你」（见 hasProactiveMessage）：
      // 列表行据此给一个「主动」角标，用户点进去就知道这条不是他问出来的。
      conversations: conversations.map((row) => {
        const view = viewOf(row)
        return hasProactiveMessage(store, view.id) ? { ...view, proactive: true } : view
      }),
    })
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

  /**
   * 删除会话：**软删**（打标记），数据一条不动。
   *
   * 物理删的问题是**不可撤销**：删掉一个会话，用户连"我删错了"都说不出口。
   * 删除恰恰是最容易手滑的一下——列表行尾那个键就在三像素外。
   *
   * 软删之后消息、FTS 索引、调度事件都还在库里，restore 路由把标记清掉就回来了
   * （同类的桌面产品都配一个撤销入口）。
   */
  router.delete('/api/conversations/:id', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    if (!store.markConversationDeleted(conversationId)) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    // 界面态覆盖一起清掉：否则覆盖表里留下一个永不消失的幽灵会话条目。
    writeState(conversationId, undefined)
    json(res, 200, { deleted: conversationId, restorable: true })
  })

  /** 撤销删除：把会话放回列表。 */
  router.post('/api/conversations/:id/restore', async (req, res) => {
    const conversationId = req.params.id as string
    if (!store.restoreConversation(conversationId)) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const conversation = store.getConversation(conversationId)
    json(res, 200, { conversation: conversation === undefined ? undefined : viewOf(conversation) })
  })

  /**
   * 取消生成：中止该会话在途的一轮（LLM 流 + 工具执行），并把还没开始的排队轮次
   * 一起清掉。
   *
   * 队列语义在组合根那一侧（`RyHarnessServer.cancelTurn`）：清掉的每一轮都会拿到
   * 一条 senderId 为 'user' 的 message-done 收尾（渲染层靠它把排队的用户气泡收
   * 口、退出排队态），这里只如实转述这次取消动了什么——`cancelled` 是有没有中止
   * 到在途那一轮，`queueCleared` 是清掉的排队条数，空闲会话两个都是 false/0。
   */
  router.post('/api/conversations/:id/cancel', async (req, res) => {
    const conversationId = req.params.id as string
    if (store.getConversation(conversationId) === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    json(res, 200, deps.cancelTurn(conversationId))
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
    /**
     * 成员被删光的会话发不了消息。
     *
     * 删掉助理时 store 会把它从会话成员里摘掉；一个成员全没了的会话再发消息，
     * 协调器会在 `getAgent(undefined)` 上炸掉——用户看到的是一条看不懂的红色报错，
     * 而不是「这里已经没法聊了」。现在在入口就说清楚。
     *
     * 历史照旧留着：那段对话本身是有价值的，只是没有对手了。
     */
    if (conversation.memberAgentIds.length === 0) {
      json(res, 409, { error: '这个会话里的助理已经被删除了，没法再发消息' })
      return
    }
    const text = strField(await req.body(), 'text')
    if (text === undefined) {
      json(res, 400, { error: 'body.text is required' })
      return
    }
    // 202：处理异步进行，过程经 WS 推送；同会话消息串行排队。
    // 先入队再发事件：入队那一刻就把轮次序号预占了（同一会话排队时，库里还看
    // 不到后面几轮，按库里最大值推出来的号会撞车），事件要报的就是这个号。
    const turnIndex = deps.enqueueTurn(conversation, text)
    deps.publish({
      type: 'message-start',
      conversationId,
      senderId: 'user',
      senderName: '用户',
      turnIndex,
    })
    // 回执带上此刻的事件 seq：客户端的订阅可能晚于这次发送建立（欢迎页就是
    // 先 setActiveId 再 postMessage），拿着这个基线才能算出订阅期间漏了几条。
    json(res, 202, { accepted: true, conversationId, streamSeq: deps.lastSeq(conversationId) })
  })

  /**
   * 编辑并重发：改写一条**用户消息**的正文，删掉它之后的一切，用新正文重跑这一轮。
   *
   * 用户那句话在库里**原地改写**（seq 不变），因此界面上"我说的那句话"还是那句
   * 话，只是内容换了；被删掉的是它之后的整段历史与回复。
   *
   * 重放走的是与首次发送**同一条**路径（协调器的 replay 模式：不追加新的用户
   * 消息，把库里那一条原样交给模型再答一次），所以模型看到的历史与第一次
   * 逐条相同。
   */
  router.post('/api/conversations/:id/messages/:seq/edit', async (req, res) => {
    const conversationId = req.params.id as string
    const seq = Number(req.params.seq)
    const stored = store.getConversation(conversationId)
    if (stored === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    if (!Number.isInteger(seq) || seq < 1) throw new HttpRequestError(400, 'seq must be a message sequence number')
    const text = strField(await req.body(), 'text')
    if (text === undefined || text.trim().length === 0) throw new HttpRequestError(400, 'body.text is required')
    const message = store.getMessage(conversationId, seq)
    if (message === undefined) {
      json(res, 404, { error: 'message not found' })
      return
    }
    // 只能改自己的话：改 agent 的发言等于让用户替它说话。
    if (message.senderType !== 'user') {
      json(res, 400, { error: 'only user messages can be edited' })
      return
    }
    const conversation = viewOf(stored)
    /**
     * 改写 + 重放**排进该会话的串行链**，不在这里就地截断。
     *
     * 就地截断会与同会话在途的那一轮撞车：那一轮正按旧历史生成，它收工时还会往
     * 库里写最后几条消息（半截回复、工具结果）。截断跑在前面、在途那轮跑在后面，
     * 库里就成了"问 B 答 A"——被截掉的那段后面又冒出来一句旧答案；更常见的是
     * 重放被排在挂住的那一轮后面，编辑看上去**什么都没发生**。
     *
     * 排进链里顺序才对：先中止在途那一轮、等它彻底收工，再截断、再重放。
     */
    const result = await deps.rewriteHistory(conversation, {
      truncateFrom: seq + 1,
      editText: { seq, text },
      replayText: text,
    })
    if (!result.applied) {
      json(res, 400, { error: result.error ?? 'message cannot be edited' })
      return
    }
    json(res, 202, { accepted: true, conversationId, streamSeq: deps.lastSeq(conversationId) })
  })

  /**
   * 重新生成：把一条 **agent 消息**换成同一句提示词重新答一遍。
   *
   * 重跑的是它前面那条用户消息：那条消息**原地不动**（seq 与 id 都不变），被
   * 换掉的只有这条回复以及它之后的一切。因此界面上"我刚说的话"不会动，动的
   * 是回复。
   *
   * 找不到前置的用户消息就没有可重放的提示词（400）——那一轮不是用户问出来的。
   */
  router.post('/api/conversations/:id/messages/:seq/regenerate', async (req, res) => {
    const conversationId = req.params.id as string
    const seq = Number(req.params.seq)
    const stored = store.getConversation(conversationId)
    if (stored === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    if (!Number.isInteger(seq) || seq < 1) throw new HttpRequestError(400, 'seq must be a message sequence number')
    const message = store.getMessage(conversationId, seq)
    if (message === undefined) {
      json(res, 404, { error: 'message not found' })
      return
    }
    if (message.senderType !== 'agent') {
      json(res, 400, { error: 'only agent messages can be regenerated' })
      return
    }
    const prompt = store.lastUserMessageBefore(conversationId, seq)
    const promptText = prompt === undefined ? '' : firstTextOf(prompt.contentBlocks)
    if (promptText.trim().length === 0) {
      json(res, 400, { error: 'no user message to replay' })
      return
    }
    const conversation = viewOf(stored)
    /**
     * 同样排进串行链：换掉一条回复要把**它之后的一切**删掉，而在途的那一轮正
     * 在往那段历史里写东西。就地截断的话，它收工时又会把旧答案写回来。
     */
    const result = await deps.rewriteHistory(conversation, {
      truncateFrom: seq,
      replayText: promptText,
    })
    if (!result.applied) {
      json(res, 400, { error: result.error ?? 'message cannot be regenerated' })
      return
    }
    json(res, 202, { accepted: true, conversationId, streamSeq: deps.lastSeq(conversationId) })
  })

  /**
   * 从此处分支：把会话在第 N 条消息处的状态复制成一个**新会话**，之后两边各走各的。
   *
   * 与"编辑/重生成"不同：分支**不重跑**任何一轮——它只是把上下文带走（同
   * LibreChat / Open WebUI 的 fork）。复制的是内容不是引用，之后改一边不影响
   * 另一边。
   */
  router.post('/api/conversations/:id/branch', async (req, res) => {
    const conversationId = req.params.id as string
    const stored = store.getConversation(conversationId)
    if (stored === undefined) {
      json(res, 404, { error: 'conversation not found' })
      return
    }
    const body = (await req.body()) as { atSeq?: unknown; title?: unknown }
    const atSeq = Number(body.atSeq)
    if (!Number.isInteger(atSeq) || atSeq < 1) throw new HttpRequestError(400, 'body.atSeq is required')
    if (store.getMessage(conversationId, atSeq) === undefined) {
      json(res, 404, { error: 'message not found' })
      return
    }
    const title = strField(body, 'title') ?? `${stored.title || '会话'}（分支）`
    const created = store.createConversation({
      kind: stored.kind,
      title,
      memberAgentIds: stored.memberAgentIds,
      ...(stored.dispatcherAgentId === undefined ? {} : { dispatcherAgentId: stored.dispatcherAgentId }),
    })
    store.copyMessagesTo(conversationId, atSeq, created.id)
    json(res, 201, { conversation: viewOf(created) })
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

  /**
   * 下载产物字节。
   *
   * 走 {@link statArtifact} 而不是自己拼路径：叶子名校验看不见工作区里的**符号链接**
   * ——产物目录里放一个指向工作区之外的软链，这条路由就会把外面的文件原样吐出去。
   * 另外两条产物路由（/info 与 /raw）早就用了这一套，三条必须给同一个答案。
   */
  router.get('/api/files/:name', async (req, res) => {
    const found = statArtifact(workspaceRoot, sanitizeUploadName(req.params.name as string))
    res.writeHead(200, { 'content-type': found.mime, 'content-length': String(found.size) })
    createReadStream(found.path).pipe(res)
  })

  /**
   * 预览用的元数据：绝对路径 + 字节数。
   *
   * 绝对路径是「用系统程序打开 / 复制路径」这两个动作的唯一原料——渲染层拿不到
   * Node 权限，只能由服务端把这条路径算出来发过去。
   */
  router.get('/api/files/:name/info', async (req, res) => {
    json(res, 200, statArtifact(workspaceRoot, sanitizeUploadName(req.params.name as string)))
  })

  /**
   * 预览用的原始字节：图片 / PDF 走 URL，文本类由渲染层自己 fetch 成字符串。
   *
   * 相对既有的下载路由多一道 `resolveTarget`——叶子名校验看不见工作区里的符号链接，
   * 而这条路由的字节是直接喂给渲染层的。
   */
  router.get('/api/files/:name/raw', async (req, res) => {
    const found = statArtifact(workspaceRoot, sanitizeUploadName(req.params.name as string))
    // 上限按整份拒掉而不是截断：截断出来的 PDF / 图片会被渲染成一个看起来
    // 正常、其实内容缺失的预览，比报错难查得多。
    if (found.size > MAX_PREVIEW_BYTES) {
      throw new HttpRequestError(413, `file is too large to preview: ${found.size} bytes`)
    }
    // 内嵌是默认；?download=1 才是下载。Content-Disposition 不给 filename= 的
    // ASCII 兜底，中文名在旧客户端上会退化成乱码文件名。
    const disposition = req.query.get('download') === '1' ? 'attachment' : 'inline'
    res.writeHead(200, {
      'content-type': found.mime,
      'content-length': String(found.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      'cache-control': 'no-store',
    })
    createReadStream(found.path).pipe(res)
  })
}
