import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, MessageRow, WsEvent } from '../api.ts'
import { ApiRequestError, messageText } from '../api.ts'
import { builtinBadge } from '../lib/agents.ts'
import { rowArtifacts } from '../lib/artifacts.ts'
import { authedFetch } from '../lib/authed-fetch.ts'
import type { Command } from '../lib/commands.ts'
import { errorDetail, humanError } from '../lib/error-text.ts'
import { formatTime } from '../lib/format.ts'
import { modelPair } from '../lib/humanize.ts'
import {
  chatWindowOf,
  createUserScrollGate,
  GAP_BRIDGE_PAGES,
  PAGE_SIZE,
  REVEAL_LEAD_TURNS,
  turnEstimateOf,
  WINDOW_MIN_TURNS,
} from '../lib/message-window.ts'
import { affinityTier, normalizePersona, TRAIT_META, traitBand } from '../lib/persona.ts'
import { reconcileStreamed } from '../lib/stream-history.ts'
import { toast } from '../lib/toast.ts'
import { explainTurnError, type TurnErrorTarget } from '../lib/turn-errors.ts'
import { LEAVE_MS, prefersReducedMotion, useLeaving } from '../lib/useLeaving.ts'
import {
  loadAutoSpeak,
  splitSentenceStream,
  splitSentences,
  useVoicePlayback,
  type VoicePlayer,
  voicePlayerFor,
} from '../lib/voice.ts'
import type {
  ConversationBucket,
  MessageAttachment,
  MessagePart,
  PendingApproval,
  RelayItem,
  UiMessage,
} from '../store.ts'
import {
  clipHistoryToolContent,
  composeMessageText,
  isProactiveRow,
  isToolErrorRow,
  mergeTimeline,
  useChat,
  useConversationView,
} from '../store.ts'
import { AsyncState } from './AsyncState.tsx'
import { Avatar } from './avatars/Avatar.tsx'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { Icon } from './Icon.tsx'
import type { MentionEntry, MentionOptions, MentionProfile } from './MentionText.tsx'
import { type BubbleAgent, MessageBubble, messagePlainText, RelayChain } from './MessageBubble.tsx'
import { PanelSkeleton } from './Skeleton.tsx'
import { ToastHost } from './ToastHost.tsx'
import { TypingDots } from './TypingDots.tsx'

/**
 * 历史行里的产物卡 → file 部件。
 *
 * 服务端把 file_produce 的结果落在消息行的 artifacts 字段上（实时事件只活在内存）；
 * 这里把它还原成与实时链路同构的 file 部件，消息流与右栏「本会话产物」才算
 * 真的记得住产物。字段缺失（旧库/未落库）时返回空数组，行为退化为现状。
 */
function artifactParts(row: MessageRow): MessagePart[] {
  const artifacts = rowArtifacts(row)
  if (artifacts.length === 0) return []
  return artifacts.map((artifact) => {
    return {
      kind: 'file' as const,
      callId: artifact.callId,
      name: artifact.name,
      size: artifact.size,
      mime: artifact.mime,
    }
  })
}

/**
 * 历史行里的工具调用参数：callId → 原始 arguments JSON。
 *
 * 参数在**前一条 assistant 消息**的 tool-call 块里（落库时整条消息原样存了，见
 * coordinator 的 onAssistantMessage），而这条 assistant 行本身没有可展示内容、被
 * fromHistory 跳过了。共享的 MessageRow 类型只声明了 contentBlocks 的 `type`/`text`
 * 两个字段，服务端却是把落库的块原样透传给前端的——就地收口读法，不去动那份全局类型。
 *
 * 前置的那条 assistant 行不一定在已加载的这一页里（往上翻页时它在更早的位置），
 * 查不到就当没有参数：工具行仍可展开看结果，只是少了「读了哪个文件」。
 */
function toolArgumentsOf(rows: readonly MessageRow[]): Map<string, string> {
  const byCallId = new Map<string, string>()
  for (const row of rows) {
    for (const block of row.contentBlocks) {
      if (block.type !== 'tool-call') continue
      const call = block as { id?: unknown; arguments?: unknown }
      if (typeof call.id === 'string' && typeof call.arguments === 'string') byCallId.set(call.id, call.arguments)
    }
  }
  return byCallId
}

/**
 * 历史工具结果行 → 工具部件。
 *
 * 正文、失败态、参数三样都要留着：实时路径早就把它们都渲染出来了（工具行可展开、
 * 失败默认展开），唯独历史路径只留了一行「已读文件」——于是用户回看三天前的会话，
 * 「当时它读了什么、错在哪」全没了，过程可见性只在实时成立。
 */
function toolParts(row: MessageRow, body: string, argumentsByCallId: Map<string, string>): MessagePart[] {
  // 正文形如 `<name>: <结果>`；只切第一个冒号，结果正文里的冒号（JSON、路径）不受影响。
  const separator = body.indexOf(':')
  const name = separator < 0 ? body : body.slice(0, separator)
  const output = separator < 0 ? '' : body.slice(separator + 1).replace(/^ /, '')
  const callId = row.toolCallId ?? row.id
  const isError = isToolErrorRow(row)
  return [
    {
      kind: 'tool' as const,
      callId,
      name: name.length === 0 ? 'tool' : name,
      arguments: argumentsByCallId.get(callId) ?? '',
      status: 'done' as const,
      ...(isError ? { isError: true } : {}),
      // 历史正文按更短的上限存：历史只增不减（往上翻页一路往渲染层塞），而工具行
      // 默认是折叠的，那点正文在用户点开之前根本不显示——只占内存。实测 10 万条会话
      // 按 8KB 存是 200MB，按 2KB 存是 50MB。实时链路仍然留 8KB。
      ...(output.length === 0 ? {} : { content: clipHistoryToolContent(output) }),
    },
    ...artifactParts(row),
  ]
}

/**
 * 一个轮次块（时间分隔 + 该轮的若干气泡）。
 *
 * `key` 是给 React 的：只按 turnIndex 会在断口续接把一轮切成两块时撞 key，见
 * {@link mergeTimeline}。
 */
interface TurnGroup {
  turnIndex: number
  time: number | undefined
  messages: UiMessage[]
  key: string
}

/** 轮次块的 React key：轮次 + 该块首条消息（消息 key 在会话内唯一）。 */
function turnBlockKey(first: UiMessage): string {
  return `${first.turnIndex}:${first.key}`
}

/**
 * 历史里落库的一轮失败：`[error:CODE] 原文`（见 packages/session/src/coordinator.ts）。
 *
 * 认不出就返回 undefined，按普通消息处理——但只认行首这一种形状，避免把正文里
 * 恰好提到 `[error:...]` 的讨论误判成失败。
 */
export function parseStoredFailure(text: string): { code: string; message: string } | undefined {
  const match = /^\[error:([A-Z_]+)\]\s*([\s\S]*)$/.exec(text.trim())
  if (match === null) return undefined
  return { code: match[1] ?? '', message: (match[2] ?? '').trim() }
}

/**
 * 历史消息行 → UiMessage 形状（打开会话、往上翻页、断口续接、搜索定位都走这一条路）。
 *
 * 与实时链路同构：工具结果带着正文、失败态与调用参数（见 {@link toolParts}），所以
 * 回看三天前的会话仍然看得见「当时它读了什么、错在哪」。纯 tool_call 的 assistant
 * 消息（无文本块且无 toolCallId 结果行）没有可展示内容，直接跳过——否则渲染成空气泡。
 *
 * `[error:CODE] 原文` 不是 agent 说过的话，而是一轮失败的流水：带 `failure` 标记出去，
 * 由聊天区画成失败提示条。历史本身照旧保留，不在列表里抹掉它真实发生过的事实。
 */
export function fromHistory(rows: MessageRow[], nameOf: (id: string) => string): UiMessage[] {
  const toolPrefix = '〔tool〕'
  const argumentsByCallId = toolArgumentsOf(rows)
  const out: UiMessage[] = []
  for (const row of rows) {
    const raw = messageText(row)
    const isTool = row.toolCallId !== undefined || raw.startsWith(toolPrefix)
    // 工具结果正文里也可能出现 `[error:...]`，那是工具输出的内容，不是一轮失败的流水。
    const failure = isTool ? undefined : parseStoredFailure(raw)
    if (!isTool && failure === undefined && raw.trim().length === 0) continue
    const body = isTool && raw.startsWith(toolPrefix) ? raw.slice(toolPrefix.length) : raw
    out.push({
      key: `hist:${row.id}`,
      senderType: row.senderType,
      senderId: row.senderId ?? (row.senderType === 'user' ? 'user' : 'system'),
      senderName: row.senderType === 'user' ? '我' : nameOf(row.senderId ?? ''),
      turnIndex: row.turnIndex,
      seq: row.seq,
      createdAt: row.createdAt,
      done: true,
      // 主动消息（服务端每日的回顾）：多带一个标记，气泡上方才有「主动找你」那一行。
      ...(isProactiveRow(row) ? { proactive: true } : {}),
      ...(failure === undefined ? {} : { failure }),
      parts: isTool
        ? toolParts(row, body, argumentsByCallId)
        : failure !== undefined
          ? []
          : [{ kind: 'text' as const, text: body }, ...artifactParts(row)],
    })
  }
  return out
}

/** 服务端消息 id（React key 的 `hist:` 前缀摘掉后就是它，见 MessageBubble）。 */
function serverMessageId(key: string): string {
  return key.startsWith('hist:') ? key.slice('hist:'.length) : key
}

/**
 * 历史里的一轮失败：一句人话 + 可展开的原文。
 *
 * 它不套 MessageBubble：失败不是某个 agent 说的话，画成气泡会让用户以为「Ryen 回了
 * 这么一句」；它也不是可以点赞、朗读、复制的内容。原始报错收进「详情」，是因为
 * 错误码与英文串对排障有用，但不该占据第一眼。
 */
function HistoryFailure({ failure, messageId }: { failure: { code: string; message: string }; messageId: string }) {
  const explained = explainTurnError(failure.code, failure.message)
  // 主动「停止」在历史里也会留一条记录（那一轮确实是被掐断的），但它不是故障：
  // 用红色告警加 role="alert" 呈现，等于每次回看历史都被自己的正常操作吓一跳。
  // 换中性样式，文字仍走同一张翻译表，两处口径一致。
  const aborted = failure.code === 'ABORTED'
  return (
    <div
      className={aborted ? 'error-banner is-muted' : 'error-banner'}
      role={aborted ? undefined : 'alert'}
      data-message-id={messageId}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
    >
      <Icon name={aborted ? 'square' : 'alert'} size={16} />
      <strong>{explained.title}。</strong>
      <span>{explained.hint}</span>
      {!aborted && (
        <details style={{ flexBasis: '100%' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>详情</summary>
          <code
            style={{
              display: 'block',
              marginTop: 4,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-xs)',
            }}
          >
            {`[error:${failure.code}] ${failure.message}`}
          </code>
        </details>
      )}
    </div>
  )
}

/** 搜索命中定位时向服务端要的上下文字段数（GET /messages 的 around 游标）。 */
export const REVEAL_WINDOW = 25

/**
 * 取一条消息前后的窗口。
 *
 * 全文搜索能指到会话里任意一条历史消息，但聊天区只加载了最新一页——命中多半不在
 * 已加载的窗口内，此前点命中只能"什么都没发生"。这一段窗口就是那次跳转的上下文。
 *
 * 走 authedFetch 而不是 ApiClient.messages()：后者的游标只有 limit/before（两个都表达不了
 * "以某条为中心"），而那组游标语义稳定、不该为了一个跳转再加第三个。直连必须经
 * authedFetch——裸 fetch 不带 token，生产环境下服务端一律 401。
 */
export async function fetchMessageWindow(
  api: ApiClient,
  conversationId: string,
  messageId: string,
  window: number = REVEAL_WINDOW,
): Promise<MessageRow[]> {
  const params = new URLSearchParams({ around: messageId, window: String(window) })
  const response = await authedFetch(api.base, `/api/conversations/${conversationId}/messages?${params.toString()}`)
  // 404 = 服务端说这条消息不在库里（被删了，或超出它的回扫上限）：不是故障，如实
  // 返回空窗口，让调用方讲"找不到了"而不是"服务没起来"。
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json().catch(() => {
    return {}
  })) as { messages?: MessageRow[] }
  return Array.isArray(body.messages) ? body.messages : []
}

/** 距底阈值：超过则停止自动跟随（报告 §5 的 100px 规则）。 */
const FOLLOW_THRESHOLD = 100

/**
 * 切会话进场补间的时长（ms）：与 CSS 里 chat-swap 用同一个 --dur-in（220ms）。
 * 两处必须同长——class 摘早了动画被截断，摘晚了会多留一段空档。
 */
const CHAT_SWITCH_MS = 220

/**
 * 已读打点的合并窗口（ms）。与 App 里清单刷新的 REFRESH_DEBOUNCE_MS 同一个节奏。
 *
 * 一个 turn 里 agent 能连发十几条会落库的消息（发言、工具结果、接力、报错收尾），
 * 而它们要做的其实只有一件事：让服务端的 lastReadSeq 追平到当前 max(seq)。所以首个
 * 事件之后，窗口内的其余事件都并进末尾那一次。
 */
const READ_MERGE_MS = 800

/**
 * 哪些 WS 事件意味着「服务端刚往库里多写了一条会被算未读的消息」。
 *
 * message-done 收一条发言（工具结果、接力链上每一次开口各有自己的 message-done），
 * tool-result 收一条工具结果正文（带文本块，同样计入未读），error 收那条
 * `[error:CODE]` 收尾，dispatch 是接力链上「下一位正在说」的信号——它自己不写消息，
 * 但接力里的每一步都紧跟着一条发言，把它并进来能让这条链上的已读不必等下一轮。
 *
 * text-delta 不在列：那时半个气泡还在写，落库要等这一条的 message-done，提前打点
 * 只是白发一次 HTTP。
 */
const UNREAD_GAINING_EVENTS: ReadonlySet<string> = new Set(['message-done', 'tool-result', 'dispatch', 'error'])

/**
 * 前台会话的已读打点闸。
 *
 * 服务端的未读数是「seq 大于 lastReadSeq 的非用户消息条数」，而工具结果也算一条
 * （正文是「〔tool〕名字: 结果」，带文本块）——用户正盯着这一轮看，角标却一路涨到
 * 七八。压住它只有一条路：这一轮里持续打 /read。
 *
 * 节奏：首个事件立刻发（同一轮末尾那份清单刷新不能先于已读落地，否则角标会先涨
 * 一下再掉），窗口内的其余事件并进窗口末尾一次，stop 时把末尾那次提前发掉。
 */
function createReadGate(
  send: () => Promise<unknown> | undefined,
  mergeMs: number,
): { hit: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let sentAt = Number.NEGATIVE_INFINITY
  let stopped = false
  const fire = (): void => {
    timer = undefined
    sentAt = Date.now()
    // 失败只影响这一次：服务端那条 lastReadSeq 还落在后面，下一条消息会再打一次。
    void Promise.resolve(send()).catch(() => {})
  }
  return {
    hit: (): void => {
      if (stopped || timer !== undefined) return
      const since = Date.now() - sentAt
      if (since < mergeMs) {
        timer = setTimeout(fire, mergeMs - since)
        return
      }
      fire()
    },
    // 切会话 / 卸载：窗口末尾那一次立刻发掉。用户已经看见的消息，不能因为他手快
    // 点了下一个会话就作废——服务端 lastReadSeq 落在后面，下一次拉清单角标又回来了。
    stop: (): void => {
      stopped = true
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      fire()
    },
  }
}

/** 单个附件上限：走 JSON base64 进内存，超过 20MB 先在客户端挡住。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** 无接力时的空数组常量：保持 props 身份稳定，memo 的 RelayChain 才不每帧重渲染。 */
const NO_RELAYS: readonly RelayItem[] = []

/** 单聊时传空成员列表用的常量：每次渲染新建 `[]` 会让 memo 的输入框每帧重渲染。 */
const NO_MEMBERS: AgentDef[] = []

/** 没有命令面板时的空常量：同上，身份必须稳定。 */
const NO_COMMANDS: readonly Command[] = []

/** 「流式即读」的累积状态：每个发言 agent 一份，按句入队后只留没说完的尾巴。 */
interface StreamingSpeech {
  buffer: string
  profileId: string
  /** 与 store 的流式消息 key 同构，播放中的气泡据此点亮停止键。 */
  key: string
}

/**
 * 断口续接：只取 `lastSeq` 之后的消息（缺多少补多少，不重拉已有的一页）。
 *
 * 服务端游标只有 `limit/before`，没有 `after`——于是从最新一页往回翻，翻到接上
 * `lastSeq` 为止。返回空数组表示「一条都没缺」，调用方据此什么都不做：这是续接与
 * 整页重载最实际的差别——弱网下每次断线不必把已渲染的消息全部丢掉重来。
 */
export async function fetchSince(
  api: ApiClient,
  conversationId: string,
  lastSeq: number | undefined,
  pages: number = GAP_BRIDGE_PAGES,
): Promise<MessageRow[]> {
  const fresh: MessageRow[] = []
  let cursor: number | undefined
  for (let page = 0; page < Math.max(1, pages); page++) {
    const { messages } = await api.messages(
      conversationId,
      cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, before: cursor },
    )
    if (messages.length === 0) break
    for (const row of messages) {
      if (lastSeq === undefined || (row.seq ?? 0) > lastSeq) fresh.push(row)
    }
    const earliest = messages[0]?.seq
    // 这一页已经盖住已有历史（或翻到顶了）：缺口补齐，不必再翻。
    if (earliest === undefined || messages.length < PAGE_SIZE) break
    if (lastSeq !== undefined && earliest <= lastSeq + 1) break
    cursor = earliest
  }
  return fresh.sort((a, b) => {
    return (a.seq ?? 0) - (b.seq ?? 0)
  })
}

/**
 * 取一页历史并转成 UI 消息。
 *
 * 此前五处历史读取各自调一遍 `api.messages` + `fromHistory`：首屏、重试、向上翻页、
 * 补空洞、搜索定位。口径其实一致（页大小、before 游标、转换口径），但写法各写一遍——
 * 改一个参数要改五个地方，漏一处就出现「有的路径多取几页、有的少取几页」的怪现象。
 * 收在这里之后，差异只剩各自 patch 的形状（首屏是整份替换，翻页是前插）。
 *
 * @param params before = 取该 seq 之前的一页；省略则取最新一页。
 */
async function loadHistoryPage(
  api: ApiClient,
  conversationId: string,
  nameOf: (id: string) => string,
  params: { before?: number } = {},
): Promise<{ rows: UiMessage[]; hasMore: boolean }> {
  const { messages } = await api.messages(
    conversationId,
    params.before === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, before: params.before },
  )
  return { rows: fromHistory(messages, nameOf), hasMore: messages.length === PAGE_SIZE }
}

/**
 * 把一轮里的接力事件按「谁说完之后」分锚。
 *
 * 调度器是在 fromAgent 说完之后才把活 yield 给 toAgent 的，交接发生在两句之间；
 * 此前一轮的接力一次性铺在轮首，用户看到 [A→B][B→C] 压在三条消息上方，却不知道
 * 交接落在哪两句之间。键 `${turnIndex}:${senderId}`，senderId 为空串的那一批是轮首
 * 调度（没有来源 agent 的那一条）。数组身份只随输入变，memo 的 RelayChain 才不会
 * 每帧重渲染。
 */
export function relayAnchorsOf(relays: readonly RelayItem[]): Map<string, RelayItem[]> {
  const anchors = new Map<string, RelayItem[]>()
  for (const relay of relays) {
    const key = `${relay.turnIndex}:${relay.fromAgent ?? ''}`
    const list = anchors.get(key)
    if (list === undefined) anchors.set(key, [relay])
    else list.push(relay)
  }
  return anchors
}

/**
 * Uint8Array → base64（分块拼，避免 apply 的参数上限）。
 * 服务端消息体是 JSON，附件字节因此以 base64 过网；解码后落进工作区产物目录。
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** 程序化滚动到底；smooth 仅用于「跳至最新」，流式跟随必须即时。
 *  前庭障碍用户关掉动效时 smooth 仍是平滑滚动——同样的位移，同样的动效。 */
function scrollToBottom(node: HTMLDivElement, smooth: boolean): void {
  if (smooth && typeof node.scrollTo === 'function') {
    try {
      const behavior = prefersReducedMotion() ? 'auto' : 'smooth'
      node.scrollTo({ top: node.scrollHeight, behavior })
      return
    } catch {
      // jsdom 等环境无 scrollTo 实现，回退直接赋值。
    }
  }
  node.scrollTop = node.scrollHeight
}

/** 中栏聊天窗口。 */
export function ChatView({
  api,
  conversation,
  agents,
  bucket,
  onRead,
  onSeen,
  onNavigate,
  onTurnEnd,
  pendingSend,
  onPendingSendDone,
  onAffinityChange,
  onPreview,
  onSwitchConversation,
  commands,
  voice,
  onTogglePanel,
  panelOpen,
}: {
  api: ApiClient
  conversation: Conversation
  agents: AgentDef[]
  /**
   * 朗读播放器（单测注入假实现用）。缺省走按 API 地址共享的单例：队列与「正在播
   * 哪一条」必须是全局状态，气泡各自 new 一个会同时开口。
   */
  voice?: VoicePlayer
  /**
   * 这个会话的桶（store + 切走还要原样的界面状态，见 store.ts 的 ConversationBucket）。
   *
   * 组件**不再**按 conversationId 重挂：切会话只是换一个桶，历史、滚动锚点、未发送的
   * 草稿都跟着桶留在原地。此前壳上那句 `key={active.id}` 让整个聊天区卸载重建，
   * 顺带把用户打了半天还没发的那句话一起扔掉。
   */
  bucket: ConversationBucket
  onRead?: () => void
  /**
   * 这一轮落在屏幕上的消息已经被打点成已读（见挂载 effect 里的 {@link createReadGate}）。
   *
   * 与 {@link onRead} 分开是因为频率：onRead 是切会话那一次——清单里的预览与时间戳
   * 也一起过期了，值得重拉；这里是每个 turn 若干次（工具结果、接力、报错收尾都会
   * 打），只需要把左栏那一行的未读本地归零。混在一起会把 4 个接口的清单刷新拖成
   * 每几百毫秒一次。
   */
  onSeen?: () => void
  /**
   * 错误条上的可行动作要跳面板时走这里（见 lib/turn-errors.ts 的 TurnErrorTarget）。
   * 不传时动作退化成窗口事件 `ryharness:navigate`（detail 同 TurnErrorTarget），由
   * 壳里的导航接线接——聊天视图自己不持有 tab 状态。
   */
  onNavigate?: (target: TurnErrorTarget) => void
  /**
   * 这一轮刚跑完（自然结束或被用户停掉）。
   *
   * 外层据此重拉一次清单：亲密度每轮都在涨（内核每轮 bumpAgentAffinity），不重拉的话
   * 右栏与聊天头部的「你们有多熟」要一直等到切会话才更新——养成产品的关系进展不外显，
   * 就等于没有。
   */
  onTurnEnd?: () => void
  /**
   * 一次 👍/👎 已被 /api/feedback 接受（亲密度由该路由内联 bump，按 messageId+signal 去重）。
   *
   * 与 {@link onTurnEnd} 同一路刷新：头部徽标、通讯录卡片与右栏的分数/档位跟着新值走。
   */
  onAffinityChange?: () => void
  /** 打开产物内嵌预览；缺省时气泡里的文件卡退回「新窗口打开」。 */
  onPreview?: (file: { name: string; mime: string; size: number }) => void
  /**
   * 待发送的首条消息（欢迎页：先把会话切过来、WS 订阅建好，再发出去）。
   * 见挂载 effect 里的发送时机——顺序反了这条消息就落在订阅之前。
   */
  pendingSend?: { conversationId: string; text: string }
  /** 待发消息已发出（App 清掉它，避免下次进会话重发一遍）。 */
  onPendingSendDone?: () => void
  /**
   * 切到另一个会话（"从这里分支"分出新会话后用）。
   *
   * 会话列表归壳所有：聊天视图自己不持有 activeId，切会话这件事由壳来接线。
   */
  onSwitchConversation?: (conversationId: string) => void
  /** `/` 命令面板的候选（壳构建：每条命令要拿到应用级动作）。 */
  commands?: readonly Command[]
  /**
   * 窄窗下打开/收起右侧信息板（壳接线）。
   *
   * 窄窗时右栏改走覆盖式抽屉，不再占固定的一列——不传这个回调，头部就没有那枚
   * 抽屉按钮，用户也就没有任何入口去看记忆、手册、待办与调度轨迹。
   */
  onTogglePanel?: () => void
  /** 抽屉此刻是开着的吗（按钮图标跟着翻转）。 */
  panelOpen?: boolean
}) {
  // 会话相关的一切都从这个桶里读：切会话时组件不卸载，换个数据源就是全部。
  const view = useConversationView(bucket)
  const { history, hasMore, loaded: historyLoaded, historyError, draft, conn, connDismissed, stopped } = view
  const store = bucket.store
  const snapshot = useChat(store)
  /**
   * 朗读播放器：按 API 地址共享（单例队列），测试可以注入假实现。
   * 播放状态只在开始/结束/换条时变化，不参与每个 token 的重渲染。
   */
  const voicePlayer = useMemo(() => {
    return voice ?? voicePlayerFor(api.base)
  }, [voice, api.base])
  const voicePlayback = useVoicePlayback(voicePlayer)
  /** 订阅 effect 的依赖只有桶；播放器通过 ref 读，换实现时不必重建订阅。 */
  const voicePlayerRef = useRef(voicePlayer)
  voicePlayerRef.current = voicePlayer
  /** 回调里读最新播放态，避免 onVoiceToggle 每次状态变化都换身份、带动整列气泡重渲染。 */
  const voicePlaybackRef = useRef(voicePlayback)
  voicePlaybackRef.current = voicePlayback
  /**
   * 自动朗读开关：单聊 + 「我的」页开关同时成立才生效。群聊一律不自动朗读——
   * 多个人先后说话时自动开口会变成抢话，本轮先按最保守的规则来。
   *
   * 只随会话读一次 localStorage：流式每个 token 重渲染时都读一次同步存储，等于
   * 把一个免费开关变成每帧的 I/O；切回来（组件重挂）时会重新读。
   */
  const autoSpeak = useMemo(() => {
    return conversation.kind === 'direct' && loadAutoSpeak()
  }, [conversation.kind])
  /** 流式分句的累积缓冲（按 sender 分开，群聊里两个人同时出字也不会串句）。 */
  const streamingSpeech = useRef(new Map<string, StreamingSpeech>())
  /** agent 清单会随刷新换引用，事件回调读 ref 才能拿到最新的人格音色。 */
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const speakVoiceId = useCallback((senderId: string): string => {
    const agent = agentsRef.current.find((candidate) => {
      return candidate.id === senderId
    })
    return normalizePersona(agent?.persona).voiceId
  }, [])

  /**
   * 流式即读：text-delta 累积到一句就入队，message-done 补播剩余半句。
   *
   * 这里只做分句与入队，不碰滚动：滚动仲裁只看 snapshot.messages 的身份，朗读是
   * 另一条独立通道。
   */
  const handleVoiceEvent = (event: WsEvent): void => {
    if (!autoSpeak) return
    if (event.type !== 'message-start' && event.type !== 'text-delta' && event.type !== 'message-done') return
    if (event.senderId === 'user') return
    if (event.type === 'message-start') {
      const profileId = speakVoiceId(event.senderId)
      if (profileId === 'none') {
        streamingSpeech.current.delete(event.senderId)
        return
      }
      streamingSpeech.current.set(event.senderId, {
        buffer: '',
        profileId,
        key: `stream:${event.senderId}:${event.turnIndex}`,
      })
      return
    }
    if (event.type === 'text-delta') {
      let state = streamingSpeech.current.get(event.senderId)
      if (state === undefined) {
        const profileId = speakVoiceId(event.senderId)
        // 没选音色（none）就不是「该朗读的助理」：不累积，也不在结尾补播。
        if (profileId === 'none') return
        // 没有 message-start（断口续接/服务端漂移）也要念；key 只影响气泡高亮。
        state = { buffer: '', profileId, key: `stream:${event.senderId}:?` }
        streamingSpeech.current.set(event.senderId, state)
      }
      const { ready, rest } = splitSentenceStream(state.buffer + event.text)
      state.buffer = rest
      for (const sentence of ready) {
        void voicePlayer.speak({ text: sentence, profileId: state.profileId, key: state.key })
      }
      return
    }
    if (event.type === 'message-done') {
      const state = streamingSpeech.current.get(event.senderId)
      if (state === undefined) return
      streamingSpeech.current.delete(event.senderId)
      for (const sentence of splitSentences(state.buffer)) {
        void voicePlayer.speak({ text: sentence, profileId: state.profileId, key: state.key })
      }
    }
  }
  /** 订阅 effect 只跑一次，函数通过 ref 取最新闭包（音色随 agent 刷新会变）。 */
  const handleVoiceEventRef = useRef(handleVoiceEvent)
  handleVoiceEventRef.current = handleVoiceEvent

  /**
   * 气泡上的朗读键：正在播这一条就停，否则把整条消息入队。
   *
   * 「不朗读」的助理点手动朗读时仍用系统默认音色——用户明确点了要听，不该被
   * persona 的关闭态挡住；自动朗读才遵守 none。
   */
  const onVoiceToggle = useCallback(
    (message: UiMessage): void => {
      const playback = voicePlaybackRef.current
      if (playback.status === 'speaking' && playback.key === message.key) {
        voicePlayer.stop()
        return
      }
      const text = messagePlainText(message).trim()
      if (text.length === 0) return
      void voicePlayer.speak({ text, profileId: speakVoiceId(message.senderId), key: message.key })
    },
    [speakVoiceId, voicePlayer],
  )

  /** 断口续接要往「收到事件的那个桶」里补，闭包里不带它才不会补错会话。 */
  const bucketRef = useRef(bucket)
  bucketRef.current = bucket
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  /**
   * 滚动仲裁的**唯一**信号：用户输入的时间戳（见 {@link USER_SCROLL_MS}）。
   *
   * 贴底与否、要不要搬视口，都只看这一个信号，不再从 scroll 事件反推意图。原因写在
   * {@link handleScroll} 里——真机上正是「scroll 事件被当成用户滚动」造出了 scrollTop
   * 的死循环。
   */
  const userScrollGate = useRef<ReturnType<typeof createUserScrollGate> | undefined>(undefined)
  if (userScrollGate.current === undefined) userScrollGate.current = createUserScrollGate()
  const restoreScroll = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  /**
   * 上一次对齐时上哨兵多高：窗口上沿下移时据此把 scrollTop 一起搬走。
   * 视口位置不再记在这里——「用户滚没滚」由 {@link userScrollGate} 说了算，不再靠
   * 两个 ref 互相推断（那正是把用户拽回原处的那次误判）。
   */
  const syncedPadTop = useRef(0)
  /** 待写的「跟随底部」帧：见 {@link scheduleFollow}。 */
  const followFrame = useRef(0)
  /**
   * 视口位置（窗口化用）：跟 {@link stickToBottom} 同源，但要渲染时读得到，
   * 所以留在桶里——它本来就是「切回来要回到哪儿」的一部分。
   */
  const atBottom = view.scroll.atBottom
  const viewTop = view.scroll.top
  const viewHeight = view.scroll.height
  /** 待定位的搜索命中消息 id；拿到后滚过去并高亮（见定位 effect）。 */
  const [revealTarget, setRevealTarget] = useState<string | undefined>(undefined)

  /**
   * 切会话的进场补间。
   *
   * 组件**不按 conversationId 重挂**（桶缓存让同一个 id 拿同一个桶，见本组件
   * bucket 参数的说明），所以「换桶」不会重播任何 CSS 动画——切会话此前就是
   * 一次纯粹的瞬换。
   *
   * 为什么不用 View Transition：它要求回调内**同步**完成 DOM 变更（浏览器靠
   * 回调结束这一刻拍旧快照），而换桶是 React 状态更新，异步。快照会拍到
   * 还没换完的界面。
   *
   * **连续切换怎么保证重播**：CSS 动画只在 animation-name 变化或元素重建时
   * 重新开始。单纯「摘 class 再加回来」在 React 里不可靠——两次 setState 若
   * 落在同一次提交里，class 名根本没变，浏览器认定动画没结束过，连点会话
   * 列表时就看不到第二次进场。所以这里让 animation-name 在两个同内容的
   * keyframes 之间交替：名字一变，浏览器必然重播。
   */
  const [switchSeq, setSwitchSeq] = useState(0)
  const [switching, setSwitching] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation.id 只作触发器，effect 体内读不到它——切会话时它变了就该重播进场动画
  useEffect(() => {
    setSwitching(true)
    setSwitchSeq((seq) => {
      return seq + 1
    })
    // 时长与 CSS 里的 chat-swap 对齐（--dur-in = 220ms）。
    const timer = setTimeout(() => {
      setSwitching(false)
    }, CHAT_SWITCH_MS)
    // 连点会话列表时 cleanup 会清掉上一个计时器：class 只会被摘一次，
    // 动画既不卡死也不会被截断成半截。
    return () => {
      clearTimeout(timer)
    }
  }, [conversation.id])

  /** 贴底状态的两个真源一起改：ref 供回调与 effect 读，桶供渲染读。 */
  const pinBottom = useCallback(
    (value: boolean): void => {
      stickToBottom.current = value
      const scroll = bucket.getView().scroll
      if (scroll.atBottom === value) return
      bucket.patch({ scroll: { ...scroll, atBottom: value } })
    },
    [bucket],
  )

  /** 用户动过滚动：滚轮、触摸、按下（拖滚动条也走这里）。语义见 lib/message-window 的 USER_SCROLL_MS。 */
  const markUserScroll = useCallback((): void => {
    userScrollGate.current?.mark()
  }, [])

  /** 此刻的滚动是不是用户在驱动。 */
  const userDriven = useCallback((): boolean => {
    return userScrollGate.current?.isUserDriven() ?? false
  }, [])

  /**
   * 跟随底部：合到下一帧写一次 scrollTop。
   *
   * 流式每来一个 token 都会重跑对齐 effect（消息数组换了身份），逐 token 同步写滚动
   * 就是逐 token 的强制布局 + 逐 token 的额外 scroll 事件，而那个事件又会再惊动一轮
   * 对齐。合帧后一帧最多写一次；真要写之前再看一眼贴底状态——用户在这中间滚上去了
   * 就不写，已经贴着底也不写（同值赋值只会白换一个 scroll 事件）。
   */
  const scheduleFollow = useCallback((): void => {
    if (followFrame.current !== 0) return
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = 0
      const node = scrollRef.current
      if (node === null || !stickToBottom.current) return
      if (node.scrollHeight - node.scrollTop - node.clientHeight <= 1) return
      node.scrollTop = node.scrollHeight
    })
  }, [])

  /** 记视口（窗口化的输入）：位置没变就不通知，省掉滚动时的一轮重渲染。 */
  const setViewport = useCallback(
    (top: number, height: number): void => {
      const scroll = bucket.getView().scroll
      if (scroll.top === top && scroll.height === height) return
      bucket.patch({ scroll: { ...scroll, top, height } })
    },
    [bucket],
  )

  /**
   * 用户中止过这一轮。store 只在 message-done 里清 typing，而中止路径不再有
   * message-done，所以"生成中"的收尾只能在 UI 侧做：点停止即刻复位，ABORTED 事件
   * 到达时兜底确认，新一轮开始时清掉。跟着会话走——在 A 会话点停止不该让 B 会话
   * 的输入区也复位。
   */
  const markStopped = useCallback(
    (value: boolean): void => {
      bucket.patch({ stopped: value })
    },
    [bucket],
  )

  const nameOf = useCallback(
    (id: string): string => {
      return (
        agents.find((a) => {
          return a.id === id
        })?.name ?? id
      )
    },
    [agents],
  )
  const agentById = useCallback(
    (id: string): AgentDef | undefined => {
      return agents.find((a) => {
        return a.id === id
      })
    },
    [agents],
  )
  const bubbleAgentsRef = useRef(new Map<string, BubbleAgent>())
  /**
   * 气泡要的那几项（id / 名字 / 头像 / 性格三维），**按字段比**着复用旧对象。
   *
   * 亲密度每轮都在涨，agent 清单每轮都换一次身份。气泡只用到头像与名字，却因为
   * 拿着整个 AgentDef 而在每一轮之后全部重渲染——几十条气泡为了一次用不上的
   * 亲密度分数白跑一遍。这几项没变就交回同一个对象，气泡的 memo 继续有效。
   *
   * 性格三维（外向 / 严谨 / 幽默）是**动效参数**：同一个助理动起来的幅度与节奏由它
   * 决定。这三维一��之内不动（用户改人设才会变），所以带上它们不会破坏 memo。
   */
  const bubbleAgents = useMemo(() => {
    const previous = bubbleAgentsRef.current
    const next = new Map<string, BubbleAgent>()
    for (const agent of agents) {
      const before = previous.get(agent.id)
      const persona = normalizePersona(agent.persona)
      const temperament = {
        extroversion: persona.extroversion,
        rigor: persona.rigor,
        humor: persona.humor,
      }
      const same =
        before !== undefined &&
        before.name === agent.name &&
        before.avatar === agent.avatar &&
        before.id === agent.id &&
        before.temperament?.extroversion === temperament.extroversion &&
        before.temperament?.rigor === temperament.rigor &&
        before.temperament?.humor === temperament.humor
      next.set(
        agent.id,
        same
          ? before
          : {
              id: agent.id,
              name: agent.name,
              ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
              temperament,
            },
      )
    }
    bubbleAgentsRef.current = next
    return next
  }, [agents])

  /**
   * @提及的名单：**按字段比**着复用旧数组。
   *
   * 和 bubbleAgents 同一个坑：agent 清单每轮都换一次身份（亲密度在涨）。名单要是
   * 每轮新建一个数组，这个数组会顺着 props 传进每一个气泡，几十条气泡于是一轮
   * 一轮地白跑一遍。名字没变就交回同一个数组，memo 继续有效。
   */
  const mentionEntriesRef = useRef<readonly MentionEntry[]>([])
  const mentionEntries = useMemo(() => {
    const previous = mentionEntriesRef.current
    const byId = new Map(
      previous.map((entry) => {
        return [entry.id, entry]
      }),
    )
    const next: MentionEntry[] = []
    let changed = previous.length !== agents.length
    for (const agent of agents) {
      const before = byId.get(agent.id)
      if (before !== undefined && before.name === agent.name) {
        next.push(before)
        continue
      }
      changed = true
      next.push({ id: agent.id, name: agent.name })
    }
    if (!changed) return previous
    mentionEntriesRef.current = next
    return next
  }, [agents])

  /**
   * 名片上的资料在**悬停那一刻现读**。
   *
   * 资料里有亲密度，而亲密度每轮都在涨——放进 props 就等于让所有气泡每轮重渲。
   * 所以 props 里只留稳定的「id + 名字」，资料由这个回调在被叫到时才去取最新的
   * （agentsRef 每轮都指向最新的清单）。
   */
  const onMentionProfile = useCallback((id: string): MentionProfile | undefined => {
    const agent = agentsRef.current.find((a) => {
      return a.id === id
    })
    if (agent === undefined) return undefined
    const persona = normalizePersona(agent.persona)
    const badge = builtinBadge(agent)
    const tier = affinityTier(persona.affinity)
    return {
      ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
      model: modelPair(agent.provider, agent.model),
      tools: agent.tools.length,
      ...(badge === undefined ? {} : { badge }),
      traits: TRAIT_META.map((meta) => {
        return { label: meta.label, band: traitBand(meta, persona[meta.key]).label }
      }),
      // 亲密度为 0 时不写「相处」这一行：没人跟一个刚建的小队熟。
      ...(persona.affinity > 0 ? { bond: { label: tier.label, value: persona.affinity } } : {}),
    }
  }, [])

  /**
   * 点一下正文里的 @某人：把「@名字 」追加到输入框并把焦点送过去。
   *
   * 为什么不是「打开他的资料」：资料在右栏（单聊）或通讯录里都翻得到，而这行正文的
   * 上下文恰恰是「我现在要接着跟他说」。把人 @ 回输入框，是把这句话接上的最短路径。
   */
  const [focusToken, setFocusToken] = useState<number | undefined>(undefined)
  const onMention = useCallback(
    (entry: MentionEntry): void => {
      const current = bucket.getView().draft
      const needsSpace = current.length > 0 && !/\s$/.test(current)
      bucket.setDraft(`${current}${needsSpace ? ' ' : ''}@${entry.name} `)
      setFocusToken((prev) => {
        return (prev ?? 0) + 1
      })
    },
    [bucket],
  )

  /** @提及的接线：三个引用都稳定，bubble 的 memo 才不会每轮失效。 */
  const mentionOptions = useMemo((): MentionOptions => {
    return { entries: mentionEntries, onProfile: onMentionProfile, onMention }
  }, [mentionEntries, onMentionProfile, onMention])

  /** 稳定引用：RelayChain 是 memo 组件，每次新建闭包会让它每帧重渲染。 */
  const avatarOf = useCallback(
    (id: string): { avatarKey?: string; name: string } => {
      const agent = agentById(id)
      return { avatarKey: agent?.avatar, name: agent?.name ?? id }
    },
    [agentById],
  )

  // 中止后 store 里的流式消息永远停在 done=false（没有 message-done），光标会一直闪。
  // 冻结成"已完结"再渲染：只在中止那一次分配数组，正常的流式路径零开销。
  const streamed = stopped
    ? snapshot.messages.map((message) => {
        return message.done ? message : { ...message, done: true }
      })
    : snapshot.messages
  const allMessages = useMemo(() => {
    // 断口续接补回的行与屏上的流式副本是同一条发言的两份（key 不同，mergeMessages 按 key
    // 去重拦不住），先把被历史覆盖的那份剔掉，再按轮次排开——见 lib/stream-history.ts。
    const reconciled = reconcileStreamed(history, streamed)
    return mergeTimeline(reconciled.history, reconciled.streamed)
  }, [history, streamed])
  const allMessagesRef = useRef<UiMessage[]>([])
  allMessagesRef.current = allMessages

  /** 按 turn 分组；turn 间插时间分隔；同 sender 相邻收紧。 */
  const turns = useMemo(() => {
    const groups: TurnGroup[] = []
    for (const message of allMessages) {
      const last = groups[groups.length - 1]
      if (last === undefined || last.turnIndex !== message.turnIndex) {
        groups.push({
          turnIndex: message.turnIndex,
          time: message.createdAt,
          messages: [message],
          key: turnBlockKey(message),
        })
      } else {
        last.messages.push(message)
      }
    }
    return groups
  }, [allMessages])

  /** 接力链的分锚结果（见 relayAnchorsOf）：身份只随 snapshot.relays 变。 */
  const relayAnchors = useMemo(() => {
    return relayAnchorsOf(snapshot.relays)
  }, [snapshot.relays])

  /**
   * 一个 turn 块的**真实**高度（px）。
   *
   * 先按「几条消息 × 76px」猜一个（纯计算见 lib/message-window 的 turnEstimateOf），
   * 猜不准就用量出来的：消息有长有短，一条十行的方案就够把一轮从 150px 顶到 260px。
   *
   * 猜偏了会怎样（真机症状）：滚动位置是**真实像素**，而哨兵撑起来的高度是**猜的**，
   * 于是「滚动位置 ÷ 每轮高度」换算出来的轮号会虚高，窗口一路塌到最后一条——内容骤缩，
   * 浏览器把越界的 scrollTop 夹回底部，用户刚往上滚就被拽回最下面。猜大了则是另一个
   * 毛病：窗口跟不上视口，滚轮像没反应。
   *
   * 量法：已渲染轮次的真实总高 ÷ 轮数。量到之后，哨兵与窗口用同一个高度，映射就自洽
   * 了（可见轮号 = 滚动位置 ÷ 每轮高度），窗口始终盖得住视口，滚轮自然滚得动。
   */
  const [measuredTurnPx, setMeasuredTurnPx] = useState<number | undefined>(undefined)
  /** 上一次量过的窗口区间：窗口没挪就不重量（见下面的量测 effect）。 */
  const measuredRangeRef = useRef('')
  /** 容器上下内边距（px）：量内容总高时要扣掉。量一次就够，它不会变。 */
  const paddingCache = useRef<number | undefined>(undefined)

  const turnEstimate = useMemo(() => {
    // 量到的优先；还没量到（首帧 / 没有窗口化）就用猜的。
    return measuredTurnPx ?? turnEstimateOf(history)
  }, [history, measuredTurnPx])

  /** 只渲染可视区 + 上下哨兵（纯计算见 lib/message-window 的 chatWindowOf）。 */
  const windowed = turns.length > WINDOW_MIN_TURNS
  const chatWindow = useMemo(() => {
    return chatWindowOf({ turns, windowed, atBottom, viewTop, viewHeight, turnEstimate })
  }, [atBottom, turnEstimate, turns, viewHeight, viewTop, windowed])

  /**
   * 量一次已渲染轮次的真实高度。
   *
   * 量法：容器里的内容总高（去掉内边距）÷ 轮数 —— 那是「每轮真实高度」。用
   * scrollHeight 而不是逐块量 offsetHeight：前者是一次布局读，后者是 N 次。
   *
   * 用 layout effect：React 会在**首次绘制之前**同步重渲，修正后的版面对用户是看不见的
   * （否则一开对话就整体跳一下）。5% 的死区是防抖：窗口挪动时渲染的那几轮换了，平均
   * 高度跟着抖一点很正常，不该每次都重算。
   *
   * 窗口没挪就不重量：流式时每个 token 都会重渲一次，重量 = 逐 token 强制布局。
   */
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const key = `${chatWindow.start}:${chatWindow.end}`
    if (key === measuredRangeRef.current) return
    measuredRangeRef.current = key
    const count = turns.length
    if (count === 0) return
    let padding = paddingCache.current
    if (padding === undefined) {
      const style = getComputedStyle(node)
      const top = Number.parseFloat(style.paddingTop)
      const bottom = Number.parseFloat(style.paddingBottom)
      padding = (Number.isFinite(top) ? top : 0) + (Number.isFinite(bottom) ? bottom : 0)
      paddingCache.current = padding
    }
    const perTurn = (node.scrollHeight - padding) / count
    if (!Number.isFinite(perTurn) || perTurn <= 0) return
    setMeasuredTurnPx((prev) => {
      if (prev !== undefined && Math.abs(perTurn - prev) <= prev * 0.05) return prev
      return perTurn
    })
  })

  /**
   * 断口续接：补齐断线期间漏掉的那几条，而不是把整个会话重置重拉。
   *
   * 此前这里走的是 `store.reset()` + 重拉最新一页：弱网下每断一次线，用户正在读的那
   * 屏消息就被清空重来一次，滚动位置、草稿、正在生成的气泡全丢。续接的做法是——先把
   * 断口那条永远等不到 message-done 的气泡就地收口（否则光标一直闪），再按已加载的
   * 最大 seq 只补「之后」的部分；一条都没缺就什么都不动。
   */
  const resumeFromGap = useCallback((): void => {
    const target = bucketRef.current
    target.store.sealIncomplete()
    void fetchSince(api, conversation.id, target.lastSeq())
      .then((rows) => {
        if (rows.length === 0) return
        target.mergeHistory(fromHistory(rows, nameOf))
      })
      .catch(() => {
        // 续不上就保持现状：已有的消息仍然在屏上，好过清空重来。
      })
  }, [api, conversation.id, nameOf])

  /**
   * 把一条已经上屏的用户消息真的发出去，并回填送达状态。
   *
   * 「上屏」与「送达」是两件事：气泡先本地插入（用户不用等网络），回执到了才算
   * 送达。失败必须留在气泡上（消息没到服务端，界面上得看得出来），而不是只弹一条
   * 转瞬即逝的红条——此前两者都缺，气泡看上去和送达的一模一样。
   */
  const deliver = useCallback(
    (key: string, text: string, attachments: readonly MessageAttachment[]): void => {
      void api
        .postMessage(conversation.id, composeMessageText(text, attachments))
        .then(() => {
          store.setUserMessageDelivery(key, 'sent')
        })
        .catch((error: unknown) => {
          store.setUserMessageDelivery(key, 'failed')
          // code='HTTP' 命中内核的「这条消息没发出去」，这里的原文只在认不出时才会
          // 折进红条的「详情」——它不是给用户读的那一句。
          store.apply({
            type: 'error',
            conversationId: conversation.id,
            message: errorDetail(error) ?? '发送失败',
            code: 'HTTP',
          })
        })
    },
    [api, conversation.id, store],
  )

  /**
   * 发一轮：先把用户消息落到 store（本地即刻可见），再发给服务端。
   * turnIndex 由调用方给定——挂载 effect 里发欢迎页那条时，历史刚拿到手里，
   * 闭包里的 history / snapshot 还是挂载前的那一帧。
   */
  const dispatch = useCallback(
    (text: string, turnIndex: number, attachments: readonly MessageAttachment[] = []): void => {
      const key = store.addUserMessage(text, turnIndex, attachments)
      pinBottom(true)
      markStopped(false)
      deliver(key, text, attachments)
    },
    [deliver, markStopped, pinBottom, store],
  )

  /** 从已上屏的气泡里取回正文与附件（重试时原样重发同一轮）。 */
  const payloadOf = useCallback((message: UiMessage): { text: string; attachments: MessageAttachment[] } => {
    const text: string[] = []
    const attachments: MessageAttachment[] = []
    for (const part of message.parts) {
      if (part.kind === 'text') text.push(part.text)
      else if (part.kind === 'file') {
        attachments.push({ name: part.name, size: part.size, mime: part.mime })
      }
    }
    return { text: text.join('\n'), attachments }
  }, [])

  /**
   * 重发同一轮：气泡不新增，原地回到"发送中"。
   *
   * 重发的是**这一轮**而不是追加一条新消息——失败的那条本来就没到服务端，用户
   * 看到的仍然是"我刚说的那句话"，只是又试了一次。
   */
  const retryMessage = useCallback(
    (message: UiMessage): void => {
      const { text, attachments } = payloadOf(message)
      store.clearError()
      store.setUserMessageDelivery(message.key, 'pending')
      pinBottom(true)
      markStopped(false)
      deliver(message.key, text, attachments)
    },
    [deliver, markStopped, payloadOf, pinBottom, store],
  )

  /** 错误条上的「重试这一轮」：重发最后一条用户消息，气泡不新增。
   *  已送达但模型侧挂掉的一轮也走同一条路——重发的是**这一轮**，不是追加一句新话，
   *  否则对话里会出现两句一模一样、看起来像用户自己说两遍的消息。 */
  const retryLastTurn = useCallback((): void => {
    // 倒序扫一遍：优先重发没送达的那条，否则最后一条不是 pending 的用户消息。
    // 还在路上的那条不必重发——重发就是同一条说两遍。
    const users = [...allMessagesRef.current].reverse().filter((message) => {
      return message.senderType === 'user' && message.delivery !== 'pending'
    })
    const lastUser =
      users.find((message) => {
        return message.delivery === 'failed'
      }) ?? users[0]
    if (lastUser === undefined) {
      toast.info('还没有可以重发的消息')
      return
    }
    retryMessage(lastUser)
  }, [retryMessage])

  /**
   * 附件落库：字节 POST 给会话的文件端点，由它写进工作区产物目录，
   * 回执是与 file_produce 产物卡片同构的 {name,size,mime}。
   *
   * 走 authedFetch 而不是裸 fetch：token 只在那一层注入，裸 fetch 在生产（已启用鉴权）
   * 下必然 401，而 401 的英文原文会原样贴到附件卡片上。
   */
  const uploadAttachment = useCallback(
    async (file: File): Promise<MessageAttachment> => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`单个附件不能超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
      }
      const response = await authedFetch(api.base, `/api/conversations/${conversation.id}/files`, {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          mime: file.type,
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        }),
      })
      const body = (await response.json().catch(() => {
        return {}
      })) as Partial<MessageAttachment> & { error?: string }
      // 走 ApiRequestError 而不是裸 Error：这样调用点拿到的是同一类失败（带 status /
      // code / raw），能走 lib/error-text.ts 那句人话，也认得出「这个文件名不合适」
      // 这类服务端字面量。裸 Error 只能把英文原话一路传回附件行。
      if (!response.ok) throw new ApiRequestError(body.error ?? `HTTP ${response.status}`, response.status)
      return {
        name: body.name ?? file.name,
        size: body.size ?? file.size,
        mime: body.mime ?? file.type,
      }
    },
    [api, conversation.id],
  )

  /** 欢迎页那条待发消息（见 props）。发完立刻置空，重渲染/重挂载都不会发第二遍。 */
  const pendingSendRef = useRef(pendingSend)
  pendingSendRef.current = pendingSend

  /**
   * 打一次已读的出口（合并节奏见 {@link createReadGate}）。走 ref 而不是直接进挂载
   * effect 的依赖：那个 effect 的契约是「一个桶一条订阅」（依赖只有 [bucket]），把
   * 每次渲染都换新的回调塞进依赖里会让整条订阅跟着重跑。订阅自己抓住建立那一刻的那
   * 一份（见 effect 里的 markSeen），同一个桶里重渲染时它打的仍然是同一个会话。
   */
  const readRef = useRef<(() => Promise<unknown>) | undefined>(undefined)
  readRef.current = () => {
    return api.markRead(conversation.id).then(() => {
      onSeen?.()
    })
  }

  // 进会话（首开或切回来）+ 订阅 WS + 标记已读 + 这一轮持续补已读。
  //
  // 桶已经加载过就一个请求都不发：历史、滚动锚点、草稿都还在原地。此前每次切会话都
  // 清空 + 重拉一页，用户看到的是闪一下骨架屏，而缓存里那份真值被白白扔掉。
  useEffect(() => {
    let cancelled = false
    const cache = bucket
    setRevealTarget(undefined)
    setShowJump(false)
    setLoadingEarlier(false)
    if (!cache.getView().loaded) {
      /**
       * 订阅建好、历史就位之后才发欢迎页那条消息。
       * 反过来（先 postMessage 再建订阅）的话，这一轮的事件全部落在订阅建立之前：
       * message-start / text-delta 一个都收不到，首屏那句话看上去就是"发了没反应"。
       * rows 只用来算 turnIndex；历史拉失败时传空数组，照发不误——宁可 turnIndex
       * 猜错一格，也不能把用户刚敲的字吞掉。
       */
      const flushPending = (rows: UiMessage[]): void => {
        const pending = pendingSendRef.current
        if (cancelled || pending === undefined || pending.conversationId !== conversation.id) return
        pendingSendRef.current = undefined
        dispatch(pending.text, nextTurnIndex(rows))
        onPendingSendDone?.()
      }
      loadHistoryPage(api, conversation.id, nameOf)
        .then(({ rows, hasMore }) => {
          if (cancelled) return
          cache.patch({ history: rows, hasMore, loaded: true, historyError: '' })
          flushPending(rows)
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            // 拉失败不能置 loaded：置了就会把「读不出来」画成「新的对话，从一句话开始」。
            // 错误留在桶里，切走再回来仍会重新尝试；错误条上另给一个立即可点的重试。
            // 这里存原文：它不进第一眼，只进 AsyncState 折起来的「详情」。
            cache.patch({ historyError: errorDetail(error) ?? '读取失败' })
            flushPending([])
          }
        })
      // 调度历史只在首开时拉：接力事件落在 store 快照里，切回来时它还在，不必重取。
      api
        .listDispatchEvents(conversation.id)
        .then(({ events }) => {
          if (!cancelled) cache.store.setDispatchHistory(events)
        })
        .catch(() => {})
    }
    /**
     * 窗口在前台 = 有焦点且可见：焦点挡「切到别的应用但窗口还开着」，可见性挡最小化
     * 与收进托盘。两条信号渲染层都拿得到（preload 只开了 openPath，没有查窗口焦点的
     * IPC），而主进程决定「弹不弹通知」走的也正是这一对 focus/blur
     * （electron/main.ts 的 windowFocused）——两边口径不能各说各话。
     *
     * 失焦不清未读：否则应用缩在托盘里时，agent 说什么都会被悄悄抹成"已读"，
     * 服务端那条「你有 N 条未读」（proactive）与左栏待办就都失效了。
     */
    // 初值取真值而不是默认 true：挂载那一刻窗口可能已经缩在托盘里（可见性挡得住）
    // 或切到了别的应用（只有 hasFocus 挡得住），别一上来就替用户把未读清掉。
    let focused = document.hasFocus()
    let visible = document.visibilityState !== 'hidden'
    const foreground = (): boolean => {
      return focused && visible
    }
    /**
     * 这一条订阅自己的「打已读」出口，在 effect 建立的那一刻把当时的闭包抓住。
     * 直接走 ref 不行：切会话时 cleanup 跑在新会话那次渲染**之后**，那时 ref 里已经
     * 换成新会话的那一份——跟着它打，末尾那次就成了在给没看过的会话标已读，而刚看完
     * 的旧会话漏掉了。
     */
    const markSeen = readRef.current
    const readGate = createReadGate(() => {
      return markSeen?.()
    }, READ_MERGE_MS)
    const onFocus = (): void => {
      focused = true
      // 回到前台：后台这几秒落下的消息此刻就摆在这块屏幕上，顺手补一次；不然角标
      // 要等下一次清单刷新才掉。
      if (foreground()) readGate.hit()
    }
    const onBlur = (): void => {
      focused = false
    }
    const onVisibility = (): void => {
      visible = document.visibilityState !== 'hidden'
      if (foreground()) readGate.hit()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = api.subscribe(
      conversation.id,
      (event) => {
        // 服务端刚往库里多写了一条会被算未读的消息（见 UNREAD_GAINING_EVENTS）：
        // 它此刻就显示在这块屏幕上，补一次打点。放在中止那一支的 return 之前——
        // 被用户停掉的一轮同样会落下半截回复与一条 [error:ABORTED]。
        if (foreground() && UNREAD_GAINING_EVENTS.has(event.type)) readGate.hit()
        if (event.type === 'message-start' || event.type === 'queued') markStopped(false)
        if (event.type === 'error' && event.code === 'ABORTED') {
          // 取消不是故障：中止后服务端只补一条 ABORTED 错误、不再发 message-done，
          // 若照常交给 store，输入区会永远停在"生成中"、光标一直闪，而且红条
          // 会把用户的主动停止说成系统出错。这里就地收口：复位 + 提示"已停止"。
          // 朗读也要跟着停：被中止的那半句不该继续念完。
          streamingSpeech.current.clear()
          voicePlayerRef.current.stop()
          cache.store.clearError()
          markStopped(true)
          return
        }
        cache.store.apply(event)
        handleVoiceEventRef.current(event)
      },
      {
        onStatus: (status) => {
          if (cancelled) return
          cache.patch({ conn: status, ...(status === 'open' ? { connDismissed: false } : {}) })
        },
        onGap: () => {
          if (!cancelled) resumeFromGap()
        },
      },
    )
    /**
     * 订阅先建、已读后打：反过来（先 /read 再建订阅）的话，两者之间落库的那条消息
     * 既没被这次已读盖住，也赶不上订阅（事件不重放），角标会一直挂在那儿直到用户
     * 下次切进这个会话。
     */
    api
      .markRead(conversation.id)
      .then(() => {
        onRead?.()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      // 窗口末尾那一次已读提前发掉：切换会话与卸载共用这一条路径，不能让它随组件走。
      readGate.stop()
      // 切会话 / 卸载：队列清空、当前音频暂停并释放 objectURL（见 VoicePlayer.stop）。
      streamingSpeech.current.clear()
      voicePlayerRef.current.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket])

  /**
   * 历史读取失败后的重试：只重拉第一页，不重建订阅、不重发欢迎页那条消息。
   * 先清掉错误让骨架回来，用户能看出「这次真的又去读了」。
   */
  const retryHistory = useCallback((): void => {
    const target = bucket
    target.patch({ historyError: '' })
    loadHistoryPage(api, conversation.id, nameOf)
      .then(({ rows, hasMore }) => {
        target.patch({
          history: rows,
          hasMore,
          loaded: true,
          historyError: '',
        })
      })
      .catch((error: unknown) => {
        target.patch({ historyError: errorDetail(error) ?? '读取失败' })
      })
  }, [api, bucket, conversation.id, nameOf])

  /**
   * 历史整表重拉（改写 / 重生成之后用）。
   *
   * 改写与重生成都会让一部分消息**消失**：被删掉的那些 seq 不再连续，缺口检测
   * 会把它当成"漏了一段"去翻页补，越补越乱。这里直接重拉第一页——真值就是
   * 服务端现在有的那些消息。
   */
  const reloadHistory = useCallback((): void => {
    const target = bucket
    loadHistoryPage(api, conversation.id, nameOf)
      .then(({ rows, hasMore }) => {
        target.patch({ history: rows, hasMore, loaded: true, historyError: '' })
      })
      .catch((error: unknown) => {
        target.patch({ historyError: errorDetail(error) ?? '读取失败' })
      })
  }, [api, bucket, conversation.id, nameOf])

  /**
   * 编辑并重发：改写那条用户消息，删掉它之后的一切，用新正文重跑。
   *
   * 库里那条用户消息是**原地改写**的（seq 不变），所以界面上"我说的那句话"还
   * 是那句话——被换掉的只是它之后的整段历史与回复。
   */
  const editMessage = useCallback(
    async (message: UiMessage, text: string): Promise<void> => {
      const seq = message.seq
      if (seq === undefined) {
        toast.error('这条消息还没送达，没法编辑')
        return
      }
      try {
        await api.editMessage(conversation.id, seq, text)
      } catch (error: unknown) {
        toast.error(`改写失败：${humanError(error, '这条消息没改成')}`)
        return
      }
      // 屏上那份流式副本是改写前的旧内容：清掉，历史重拉后只剩真值。
      store.reset()
      reloadHistory()
    },
    [api, conversation.id, reloadHistory, store],
  )

  /** 重新生成：用同一句提示词重答一遍（用户那句话原地不动）。 */
  const regenerateMessage = useCallback(
    async (message: UiMessage): Promise<void> => {
      const seq = message.seq
      if (seq === undefined) {
        toast.error('这条消息还没送达，没法重新生成')
        return
      }
      try {
        await api.regenerateMessage(conversation.id, seq)
      } catch (error: unknown) {
        toast.error(`重新生成失败：${humanError(error, '这次没能重跑')}`)
        return
      }
      store.reset()
      reloadHistory()
    },
    [api, conversation.id, reloadHistory, store],
  )

  /** 从此处分支：复制出一个新会话，并切过去。 */
  const branchMessage = useCallback(
    async (message: UiMessage): Promise<void> => {
      const seq = message.seq
      if (seq === undefined) {
        toast.error('这条消息还没送达，没法分支')
        return
      }
      try {
        const created = await api.branchConversation(conversation.id, seq)
        toast.success('已从这条消息分出新会话')
        onSwitchConversation?.(created.conversation.id)
      } catch (error: unknown) {
        toast.error(`分支失败：${humanError(error, '这次没能分出新会话')}`)
      }
    },
    [api, conversation.id, onSwitchConversation],
  )

  // 向上翻页：取最早 seq 之前的一页前插，并保持视口位置不跳动。
  const loadEarlier = async (): Promise<void> => {
    const earliest = history[0]?.seq
    if (earliest === undefined || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const { rows: older, hasMore } = await loadHistoryPage(api, conversation.id, nameOf, { before: earliest })
      const node = scrollRef.current
      if (node !== null) restoreScroll.current = { prevHeight: node.scrollHeight, prevTop: node.scrollTop }
      bucket.patch({
        history: [...older, ...bucket.getView().history],
        hasMore,
      })
    } catch {
      // 加载失败保持现状，用户可重试。
    } finally {
      setLoadingEarlier(false)
    }
  }

  /**
   * 把定位窗口与已加载页之间的空洞补上（就地往 incoming 里追加）。
   *
   * 窗口来自一次 around 请求、已加载页是最新一页，两者之间常常隔着一大段：直接合并
   * 的话，用户从命中往下一滚就会撞见"对话少了一段"。这里拿既有的 before 游标从已加载
   * 页最早处往回翻，把中间补齐；翻满上限仍接不上就停——那是隔了上千条的老消息，
   * 以命中附近的窗口为准比再翻几十页有用。
   */
  const closeGapToLoaded = useCallback(
    async (incoming: UiMessage[]): Promise<void> => {
      let loadedFirst = allMessagesRef.current.find((message) => {
        return message.seq !== undefined
      })?.seq
      const windowLast = incoming[incoming.length - 1]?.seq
      if (loadedFirst === undefined || windowLast === undefined || windowLast >= loadedFirst - 1) return
      for (let page = 0; page < GAP_BRIDGE_PAGES; page++) {
        const { rows } = await loadHistoryPage(api, conversation.id, nameOf, { before: loadedFirst })
        if (rows.length === 0) return
        incoming.push(...rows)
        const earliest = rows[0]?.seq
        if (earliest === undefined || earliest <= windowLast) return
        loadedFirst = earliest
      }
    },
    [api, conversation.id, nameOf],
  )

  /**
   * 搜索命中的定位：本地窗口里没有这条消息，就向服务端要一段 around 窗口。
   *
   * 聊天区一次只加载最新一页，命中多半在更早的历史里——此前点命中只会"什么都不
   * 发生"（会话切过去了、消息不在 DOM 里、scrollIntoView 找不到节点）。这里补
   * 齐上下文把它插进流里，再交给下面的定位 effect 滚过去。
   */
  const revealMessage = useCallback(
    async (messageId: string): Promise<void> => {
      pinBottom(false)
      setShowJump(true)
      if (
        !allMessagesRef.current.some((message) => {
          return serverMessageId(message.key) === messageId
        })
      ) {
        try {
          const rows = await fetchMessageWindow(api, conversation.id, messageId)
          const incoming = fromHistory(rows, nameOf)
          if (incoming.length === 0) {
            toast.error('这条消息已经不在了，换个关键词再搜')
            return
          }
          await closeGapToLoaded(incoming)
          bucket.mergeHistory(incoming)
        } catch {
          toast.error('没能定位到这条消息，检查一下本地服务是否在运行')
          return
        }
      }
      setRevealTarget(messageId)
    },
    [api, closeGapToLoaded, conversation.id, nameOf, pinBottom],
  )

  // 左栏搜索命中抛来的定位事件（见 ConversationList 的 onJumpToMessage）。
  useEffect(() => {
    const onJump = (event: Event): void => {
      const detail = (event as CustomEvent<{ conversationId?: string; messageId?: string }>).detail
      if (detail?.conversationId !== conversation.id || typeof detail.messageId !== 'string') return
      void revealMessage(detail.messageId)
    }
    window.addEventListener('ryharness:scroll-to-message', onJump)
    return () => {
      window.removeEventListener('ryharness:scroll-to-message', onJump)
    }
  }, [conversation.id, revealMessage])

  /**
   * 滚到待定位的那条消息，并把窗口挪到它所在的那一轮。
   *
   * 两件事都得做：窗口化之后命中很可能**不在渲染窗口里**，只 scrollIntoView 等于
   * 找不到节点（这正是"静默失败"的第二层）。先按估算高度把视口挪到那一轮附近，
   * 再交给 DOM 精确定位。隔几拍重试是因为窗口重算是同一帧的事，节点未必已经挂上。
   */
  useEffect(() => {
    if (revealTarget === undefined) return
    const index = turns.findIndex((turn) => {
      return turn.messages.some((message) => {
        return serverMessageId(message.key) === revealTarget
      })
    })
    if (index >= 0) {
      pinBottom(false)
      setViewport(Math.max(0, (index - REVEAL_LEAD_TURNS) * turnEstimate), viewHeight)
    }
    const safe =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(revealTarget) : revealTarget
    const timers = [0, 120, 360, 800].map((delay) => {
      return window.setTimeout(() => {
        const node = document.querySelector<HTMLElement>(`[data-message-id="${safe}"]`)
        if (node === null) return
        node.scrollIntoView?.({ block: 'center' })
        node.classList.add('is-search-hit')
        window.setTimeout(() => {
          node.classList.remove('is-search-hit')
        }, 2400)
        setRevealTarget(undefined)
      }, delay)
    })
    // 一直定位不到（消息被删了、或它始终不在窗口里）也别把"定位中"挂成常态：
    // 那个状态会让滚动对齐一直让路。超时即收工，之后照样可以再点一次命中。
    timers.push(
      window.setTimeout(() => {
        setRevealTarget(undefined)
      }, 1400),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
    // 依赖 turns.length 而非 turns 本身：流式追加每个 token 都会换掉 turns 的
    // 身份，盯着它会让这套重试每帧重来一遍；历史真正变长（定位窗口插进来）才是
    // 需要重算位置的那一刻。
  }, [revealTarget, turns.length, turnEstimate, pinBottom, setViewport, viewHeight])

  // 滚动对齐：翻页前插后还原视口；贴底时跟随底部；窗口上沿下移时把视口一起搬走。
  // 依赖 snapshot.messages 的身份（store 每次通知都重建数组），流式追加也触发。
  //
  // 三件事互斥，且后两件都只在「用户此刻没在滚」时才动手：用户正在上翻历史时，任何
  // 一次程序化写 scrollTop 都是把他从正在读的那条消息上拽走。

  /**
   * 换桶：把 ref 上的贴底/视口换成本会话的锚点，并把滚动位置恢复回去。
   *
   * 放布局期而不是 effect：否则切回来会先按上一个会话的位置画一帧、再跳回锚点，
   * 肉眼看就是一次跳动。padTop 一并记下是另一半——不记的话，下面那个对齐 effect 会
   * 以为「上哨兵突然长高了」，把 scrollTop 又搬一次，视口等于被拽走。
   */
  useLayoutEffect(() => {
    const anchor = bucket.getView().scroll
    stickToBottom.current = anchor.atBottom
    // 上一段会话欠下的两件事作废：翻页的视口还原、以及还没落地的那一帧滚动采样——
    // 拿来对新的会话用，等于把上一个会话的位置按到这一个上面。
    restoreScroll.current = null
    if (pendingFrame.current !== 0) {
      cancelAnimationFrame(pendingFrame.current)
      pendingFrame.current = 0
    }
    if (followFrame.current !== 0) {
      cancelAnimationFrame(followFrame.current)
      followFrame.current = 0
    }
    const node = scrollRef.current
    if (node === null) return
    if (!anchor.atBottom && anchor.top > 0) node.scrollTop = anchor.top
    syncedPadTop.current = chatWindow.padTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket])
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const restore = restoreScroll.current
    restoreScroll.current = null
    if (restore !== null) {
      node.scrollTop = node.scrollHeight - restore.prevHeight + restore.prevTop
      syncedPadTop.current = chatWindow.padTop
      return
    }
    if (stickToBottom.current) scheduleFollow()
    /**
     * 上哨兵变高（窗口上沿下移）时把 scrollTop 一起搬走，视口才停在原来那条消息上。
     * 只在用户此刻没在滚、也没有定位任务在跑时搬：哨兵高度变了也可能正是他滚动
     * 导致的窗口重算，那时候再补一次位移就等于把他拽回原处。
     */ else if (!userDriven() && revealTarget === undefined && chatWindow.padTop !== syncedPadTop.current) {
      node.scrollTop += chatWindow.padTop - syncedPadTop.current
    }
    syncedPadTop.current = chatWindow.padTop
    setShowJump(!stickToBottom.current)
    // 这里**不**写滚动锚点：锚点记的是「用户滚到了哪儿」，由 handleScroll 负责。
    // 程序化位移（跟随底部、按哨兵高度搬视口、定位摆位）都发生在没有用户滚动的情况下，
    // 把此刻的 scrollTop 当成锚点写回去，等于用「程序算出来的位置」覆盖「用户的位置」。
    // chatWindow 是本轮渲染的窗口切片；它变了才需要重新对齐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.messages, history, snapshot.typing, chatWindow, revealTarget, scheduleFollow, userDriven])

  const pendingFrame = useRef(0)
  /**
   * 滚动事件：记视口（窗口化的输入）；贴底与否只在用户正在滚时裁决。
   *
   * 为什么要分这一层：scroll 事件不携带「谁动的」。程序化写 scrollTop（跟随底部、翻页
   * 还原）、浏览器把越界的 scrollTop 夹回合法范围，全都会派发 scroll——把后者当成用户
   * 滚动，一次写回就把自己判回贴底，对齐 effect 随即再写一次，padTop 又跟着窗口重算
   * 补偿一次。真机上就是这个循环：400 条消息的长会话往上一滚，scrollTop 在
   * 10107 / 11525 / 12522 之间永远来回，气泡数在 1 与 25 之间反复重排，用户看到的就是
   * 「滚不动、卡住」。
   */
  const handleScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    // 视口位置按帧合并：连续滚动下每帧最多重算一次窗口，而不是每个 scroll 事件
    // 都让整条消息流重渲染（与 lib/windowed.ts 里 useVisibleWindow 的取舍一致）。
    if (pendingFrame.current === 0) {
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = 0
        setViewport(node.scrollTop, node.clientHeight)
      })
    }
    if (!userDriven()) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    pinBottom(distance < FOLLOW_THRESHOLD)
    // 「跳至最新」跟着贴底状态一起走：用户上滚的那一刻就该出现，而不是等下一轮对齐。
    setShowJump(distance >= FOLLOW_THRESHOLD)
    // 触顶自动翻页：向上回看历史时不该反复点按钮，也让"窗口"随浏览自然长大。
    if (node.scrollTop < 160 && hasMore && !loadingEarlier) {
      void loadEarlier()
    }
  }
  useEffect(() => {
    return () => {
      if (pendingFrame.current !== 0) cancelAnimationFrame(pendingFrame.current)
      if (followFrame.current !== 0) cancelAnimationFrame(followFrame.current)
    }
  }, [])

  const jumpToLatest = (): void => {
    const node = scrollRef.current
    if (node === null) return
    // 顺手掐掉排队中的跟随帧：否则它会在下一帧把 smooth 动画一把按到终点。
    if (followFrame.current !== 0) {
      cancelAnimationFrame(followFrame.current)
      followFrame.current = 0
    }
    pinBottom(true)
    scrollToBottom(node, true)
    setShowJump(false)
  }

  const members = useMemo(() => {
    return conversation.memberAgentIds
      .map((id) => {
        return agents.find((a) => {
          return a.id === id
        })
      })
      .filter((a): a is AgentDef => {
        return a !== undefined
      })
  }, [conversation.memberAgentIds, agents])

  // 读 ref 而不是闭包里的 allMessages：allMessages 每来一个 token 就换一次身份，
  // 挂进 useCallback 会让 onSend 每帧换新——memo 的输入框于是每帧重渲染，等于没 memo。
  // 顺带更准：turnIndex 算的是「按下回车那一刻」的全量消息，而不是上一帧的。
  const send = useCallback(
    (text: string, attachments?: MessageAttachment[]): void => {
      dispatch(text, nextTurnIndex(allMessagesRef.current), attachments ?? [])
    },
    [dispatch],
  )

  /**
   * 点停止：先复位再发请求。
   *
   * 中止确认要等服务端回 ABORTED 才到，那之前界面不能还停在"生成中"——这正是此前
   * "点了停止像卡死"的观感来源。停不掉就如实回滚，否则用户以为已经停了、模型其实
   * 还在烧 token。稳定引用是为了让 memo 的输入框不因这个闭包每帧重渲染。
   */
  const stopTurn = useCallback((): void => {
    markStopped(true)
    void api.cancelTurn(conversation.id).catch((error: unknown) => {
      markStopped(false)
      toast.error(`没能停止生成：${humanError(error, '这次没能停住，再点一次停止')}`)
    })
  }, [api, conversation.id, markStopped])

  /** 草稿写回桶：切会话丢的就是这一串字（见 store.ts 的 ConversationBucket）。 */
  const onDraftChange = useCallback(
    (text: string): void => {
      bucket.setDraft(text)
    },
    [bucket],
  )

  /**
   * 「这一轮还在跑」的判据是「还有没写完的消息」，不是 typing 计数：首个
   * text-delta 到达后 store 会清掉 typing（「正在输入」不该和正在出字的气泡
   * 并存），但这一轮远没结束——停止按钮与秒表必须留着。
   */
  const streamingActive =
    !stopped && (Object.keys(snapshot.typing).length > 0 || streamed.some((message) => !message.done))

  /** 这一轮跑完的那一下（由真→假）：通知外层重拉 agent 清单，让亲密度外显跟上。 */
  const streamingRef = useRef(streamingActive)
  useEffect(() => {
    const wasStreaming = streamingRef.current
    streamingRef.current = streamingActive
    if (wasStreaming && !streamingActive) onTurnEnd?.()
  }, [streamingActive, onTurnEnd])

  // 稳定引用：MessageBubble 的 memo 依赖这两个 prop 的身份不变。
  const fileUrl = useCallback(
    (name: string): string => {
      return api.fileUrl(name)
    },
    [api],
  )
  const onFeedback = useCallback(
    (target: UiMessage, signal: 'thumb_up' | 'thumb_down'): Promise<boolean> => {
      const textOf = (m: UiMessage): string => {
        return m.parts
          .filter((p) => {
            return p.kind === 'text'
          })
          .map((p) => {
            return p.kind === 'text' ? p.text : ''
          })
          .join(' ')
      }
      // 找目标消息之前最近的用户消息作为反馈上下文。
      const msgs = allMessagesRef.current
      const targetIndex = msgs.indexOf(target)
      let userText = ''
      for (let i = (targetIndex < 0 ? msgs.length : targetIndex) - 1; i >= 0; i--) {
        const candidate = msgs[i]!
        if (candidate.senderType === 'user') {
          userText = textOf(candidate)
          break
        }
      }
      // 亲密度 bump 由服务端在这条路由里内联做（反馈被接受才涨）；
      // messageId 带去重键，同一消息同一信号连点只计一次。
      return api
        .sendFeedback({
          conversationId: conversation.id,
          agentId: target.senderId,
          signal,
          userText: userText.slice(0, 300),
          assistantText: textOf(target).slice(0, 300),
          messageId: serverMessageId(target.key),
        })
        .then(() => {
          // 反馈是"自我进化"的入口，必须让用户看见它去了哪。
          const who = agentById(target.senderId)?.name ?? '它'
          toast.success(
            signal === 'thumb_up' ? `已记下这条经验，${who} 会在类似场景里用上` : `已告诉 ${who} 这次哪里不对，会调整`,
          )
          // 外层据此重拉清单：头部徽标、通讯录卡片与右栏的分数当场跟上。
          onAffinityChange?.()
          return true
        })
        .catch((error: unknown) => {
          toast.error(`反馈没送出去：${humanError(error, '这次没记上，再点一次')}`)
          return false
        })
    },
    [api, conversation.id, agentById, onAffinityChange],
  )

  const typingAgents = Object.keys(snapshot.typing).filter((id) => {
    return id !== 'user'
  })

  /**
   * 单聊头部的关系徽标：这一位此刻和用户有多熟。
   *
   * 为什么放在这里而不是只在右栏：亲密度每轮都在涨，可右栏默认收起、用户也不会为了看
   * 一个数字去点它——养成类产品的关系进展要持续外显，哪怕只是一枚安静的小徽标。
   * 0 的时候不显示（人人都是 0，显示等于没有信息）；群聊也不显示（好几位挤在一行，
   * 谁都不突出，等于没有）。徽标只说档位与分数，具体怎么相处在 title 与右栏里。
   */
  const bond = ((): { label: string; title: string } | undefined => {
    if (conversation.kind !== 'direct') return undefined
    const other = members[0]
    if (other === undefined) return undefined
    const persona = normalizePersona(other.persona)
    if (persona.affinity <= 0) return undefined
    const tier = affinityTier(persona.affinity)
    return { label: `${tier.label} · ${persona.affinity}/100`, title: `${tier.address}——${tier.describe}` }
  })()

  // 退场接线：提示条/浮层消失时先播 styles.css 的退场动画再卸载。
  // 中止后 typing 归零（输入区已经复位），这里随之退场；同时补一条"已停止"说明，
  // 让用户知道是自己点的停止，而不是系统出错。
  const typingNames = stopped ? [] : typingAgents.map(nameOf)
  const connBanner = useLeaving(LEAVE_MS, conn === 'reconnecting' && !connDismissed ? true : undefined)
  const typingLine = useLeaving(LEAVE_MS, typingNames.length > 0 ? typingNames : undefined)
  const stoppedHint = useLeaving(LEAVE_MS, stopped ? '已停止生成' : undefined)
  const errorBanner = useLeaving(LEAVE_MS, snapshot.error)
  const jumpButton = useLeaving(LEAVE_MS, showJump ? true : undefined)
  const queueHint = useLeaving(LEAVE_MS, snapshot.queueing ? true : undefined)

  /**
   * 红条上那一句人话（见 lib/turn-errors.ts）。
   *
   * 取的是 errorBanner.shown 而不是 snapshot.error：退场动画期间 snapshot 已经
   * 没了错误，而红条还得留在屏幕上走完动画——跟着 snapshot 走会让文案和按钮在
   * 动画第一帧就消失。
   */
  const explainedError = useMemo(() => {
    return errorBanner.shown === undefined
      ? undefined
      : explainTurnError(errorBanner.shown.code, errorBanner.shown.message)
  }, [errorBanner.shown])

  /**
   * 错误条上的动作：重试就地做；跳面板交给宿主（聊天视图不持有 tab 状态）。
   * 宿主没接线时抛窗口事件 `ryharness:navigate`（detail 带同一个 target），壳里
   * 一个监听就能接上——不接也只是那一次点击没有去处，其余行为不变。
   */
  const runErrorAction = (target: TurnErrorTarget): void => {
    if (target === 'retry') {
      retryLastTurn()
      return
    }
    if (onNavigate === undefined) {
      window.dispatchEvent(new CustomEvent('ryharness:navigate', { detail: { target } }))
      return
    }
    onNavigate(target)
  }

  return (
    <section
      className={switching ? 'chat-view is-switching' : 'chat-view'}
      // 两个同内容的 keyframes 交替：animation-name 一变，浏览器必然重播动画。
      // 靠 class 摘/加来触发在连续切换时不可靠（两次 setState 落在同一次提交里，
      // class 名没变，浏览器认为动画没结束过）。
      style={{ animationName: switching ? `chat-swap-${switchSeq % 2}` : undefined }}
    >
      <header className="chat-header">
        {/* 这里曾经按 snapshot.typing 把猫切成 thinking、收尾再 happy 一下；位图徽标没有
            可换的眼形，那套联动随三态一起作废。「正在思考」的真源在消息区的
            .typing-indicator + TypingDots，同一份 snapshot.typing。 */}
        <Cat size={34} />
        <div className="chat-header-info">
          <strong>{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</strong>
          <small>{conversation.kind === 'group' ? `群聊 · ${members.length} 位成员` : '单聊'}</small>
        </div>
        {bond !== undefined && (
          <span className="chip" title={bond.title} style={{ marginLeft: 'auto' }}>
            {bond.label}
          </span>
        )}
        {/* 窄窗抽屉的入口：宽窗时右栏就在旁边，不需要这枚按钮（那时壳不传这个回调）。 */}
        {onTogglePanel !== undefined && (
          <button
            type="button"
            className="panel-drawer-btn"
            title={panelOpen === true ? '收起信息板' : '打开信息板'}
            aria-label={panelOpen === true ? '收起信息板' : '打开信息板'}
            aria-expanded={panelOpen === true}
            onClick={onTogglePanel}
          >
            <Icon name="panel-right" size={16} />
          </button>
        )}
      </header>

      {connBanner.shown !== undefined && (
        <p ref={connBanner.ref} className={connBanner.leaving ? 'conn-banner is-leaving' : 'conn-banner'} role="status">
          <Icon name="alert" size={16} /> 连接已断开，正在重连…
          <button
            type="button"
            className="conn-banner-close"
            aria-label="关闭提示"
            onClick={() => {
              bucket.patch({ connDismissed: true })
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </p>
      )}

      {/* 对话流是一份不断追加的日志：role="log" + polite + 只读 additions，
          新消息到达才播报，流式重排（同一节点内改字）不会反复念。
          滚轮/触摸/按下三路输入都在这儿打「用户正在驱动」的标记——贴底与否只认这个
          信号（见 handleScroll）。 */}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        style={{ position: 'relative' }}
      >
        <div className="chat-col">
          {historyError.length > 0 && (
            <AsyncState
              loading={false}
              error="历史消息没读出来，可能是本机服务暂时不可用。"
              detail={historyError}
              onRetry={retryHistory}
            >
              {null}
            </AsyncState>
          )}
          {!historyLoaded && historyError.length === 0 && <PanelSkeleton rows={4} />}
          {historyLoaded && hasMore && (
            <button
              type="button"
              className="load-earlier"
              disabled={loadingEarlier}
              onClick={() => {
                void loadEarlier()
              }}
            >
              {loadingEarlier ? (
                '载入中…'
              ) : (
                <>
                  <Icon name="arrow-up" size={16} /> 加载更早消息
                </>
              )}
            </button>
          )}
          {/* 上哨兵：撑住被窗口截掉的上方内容，滚动条长度才不会随窗口抖动。 */}
          {chatWindow.padTop > 0 && <div style={{ height: chatWindow.padTop }} aria-hidden="true" />}
          {chatWindow.visible.map((turn) => (
            <div key={turn.key} className="turn-block">
              {turn.time !== undefined && <div className="turn-time">{formatTime(turn.time)}</div>}
              {/* 轮首只留那次没有来源的调度（「谁先接了这个活」）；轮内的交接贴在说话的人后面。 */}
              <RelayChain
                relays={relayAnchors.get(`${turn.turnIndex}:`) ?? NO_RELAYS}
                turnIndex={turn.turnIndex}
                nameOf={nameOf}
                avatarOf={avatarOf}
              />
              {turn.messages.map((message, index) => (
                <Fragment key={message.key}>
                  {/* 主动消息的标识：这条是它自己开口说的，不是用户问出来的。
                      放在气泡上方而不是气泡里——气泡里再插一行字，气泡就不是它本来的样子了。
                      名字取这条消息真正发话的那位（与气泡同名）：助手是可改昵称的，
                      写死品牌名会在用户改完之后继续自称旧名。 */}
                  {message.proactive === true && (
                    <p className="chat-hint" data-proactive="true">
                      <Icon name="sun" size={16} /> {agentById(message.senderId)?.name ?? '它'} 主动找你
                    </p>
                  )}
                  {message.failure !== undefined ? (
                    <HistoryFailure failure={message.failure} messageId={serverMessageId(message.key)} />
                  ) : (
                    <MessageBubble
                      message={message}
                      fileUrl={fileUrl}
                      onPreview={onPreview}
                      agent={bubbleAgents.get(message.senderId)}
                      tight={index > 0 && turn.messages[index - 1]?.senderId === message.senderId}
                      firstOfGroup={index === 0 || turn.messages[index - 1]?.senderId !== message.senderId}
                      // 历史消息一次性几十条同时淡入像掉帧，只有本次会话新到的才播进场。
                      animated={!message.key.startsWith('hist:')}
                      onFeedback={onFeedback}
                      onVoiceToggle={onVoiceToggle}
                      onEdit={editMessage}
                      onRegenerate={regenerateMessage}
                      onBranch={branchMessage}
                      mentions={mentionOptions}
                      voiceSpeaking={voicePlayback.status === 'speaking' && voicePlayback.key === message.key}
                    />
                  )}
                  {/* 没送达的气泡自带失败态与重试入口：发失败的消息长得跟送达的一模
                      一样，用户只会以为 agent 还没开始答。 */}
                  {message.delivery === 'failed' && (
                    <p className="chat-hint">
                      <Icon name="alert" size={16} /> 发送失败，这条没送到
                      <button
                        type="button"
                        className="btn btn-mini"
                        onClick={() => {
                          retryMessage(message)
                        }}
                      >
                        重试
                      </button>
                    </p>
                  )}
                  {/* 交接点：这句话说完之后调度器才把活交给下一个 agent，所以 chip 贴
                      在这句下面，而不是像此前那样整轮堆在轮首。 */}
                  <RelayChain
                    relays={relayAnchors.get(`${turn.turnIndex}:${message.senderId}`) ?? NO_RELAYS}
                    turnIndex={turn.turnIndex}
                    nameOf={nameOf}
                    avatarOf={avatarOf}
                  />
                </Fragment>
              ))}
            </div>
          ))}
          {/* 下哨兵：同上，撑住下方尚未渲染的部分。 */}
          {chatWindow.padBottom > 0 && <div style={{ height: chatWindow.padBottom }} aria-hidden="true" />}
          {explainedError !== undefined && (
            // 与 HistoryFailure 同一套分工：一行人话占第一眼，原文折进「详情」。
            // 此前 detail 是直接拼在括号里的，于是认不出的失败会把 `no adapter
            // registered for provider "x"` 顶到红条中间——和同一屏里的中文说明
            // 读起来像两个应用。
            <div
              ref={errorBanner.ref}
              className={errorBanner.leaving ? 'error-banner is-leaving' : 'error-banner'}
              role="alert"
              style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
            >
              <Icon name="alert" size={16} />
              <strong>{explainedError.title}。</strong> {explainedError.hint}
              {explainedError.action !== undefined && (
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => {
                    runErrorAction(explainedError.action?.target ?? 'retry')
                  }}
                >
                  {explainedError.action.label}
                </button>
              )}
              {explainedError.detail !== undefined && (
                <details style={{ flexBasis: '100%' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)' }}>详情</summary>
                  <code
                    style={{
                      display: 'block',
                      marginTop: 4,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-xs)',
                    }}
                  >
                    {explainedError.detail}
                  </code>
                </details>
              )}
            </div>
          )}
          {typingLine.shown !== undefined && (
            <p ref={typingLine.ref} className={typingLine.leaving ? 'typing-indicator is-leaving' : 'typing-indicator'}>
              {/* 正在想的那一位：头像挂在头像列的位置（绝对定位，不占正文的位置），
                  视线左右游走。气泡要等第一个字才出现——从"用户按下发送"到"第一个字
                  出来"这段通常是好几秒，屏幕上没有任何东西在动，用户只能盯着空白的
                  聊天区等。这里补上：这位在忙。 */}
              {typingAgents.length > 0 && (
                <span className="typing-thinking-avatars" aria-hidden="true">
                  {typingAgents.map((agentId) => {
                    const bubble = bubbleAgents.get(agentId)
                    if (bubble === undefined) return null
                    return (
                      <Avatar
                        key={agentId}
                        avatarKey={bubble.avatar}
                        name={bubble.name}
                        seed={bubble.id}
                        size={28}
                        pondering
                        {...(bubble.temperament === undefined ? {} : { temperament: bubble.temperament })}
                      />
                    )
                  })}
                </span>
              )}
              {typingLine.shown.join('、')}
              <TypingDots />
            </p>
          )}
          {stoppedHint.shown !== undefined && (
            <p
              ref={stoppedHint.ref}
              className={stoppedHint.leaving ? 'stopped-hint is-leaving' : 'stopped-hint'}
              role="status"
            >
              <Icon name="x" size={16} /> {stoppedHint.shown}
            </p>
          )}
          {historyLoaded && allMessages.length === 0 && (
            <div className="empty-state">
              <span className="empty-cat">
                <Cat size={88} />
              </span>
              <h3>新的对话，从一句话开始</h3>
              <p>我是 {nameOf(conversation.memberAgentIds[0] ?? '')}，有事尽管吩咐。</p>
            </div>
          )}
        </div>
        {jumpButton.shown !== undefined && (
          <button
            type="button"
            ref={jumpButton.ref}
            className={jumpButton.leaving ? 'jump-latest is-leaving' : 'jump-latest'}
            onClick={jumpToLatest}
          >
            <Icon name="chevron-right" size={16} className="jump-icon" /> 跳至最新
          </button>
        )}
      </div>

      <div className="chat-input-wrap">
        {/* toast 挂在输入区上沿（绝对定位），composer 变高时不会被压住。
            没有会话在看的页面由 App 壳挂同一个宿主。 */}
        <ToastHost />
        <div className="chat-input-col">
          {queueHint.shown !== undefined && (
            <p ref={queueHint.ref} className={queueHint.leaving ? 'queue-hint is-leaving' : 'queue-hint'}>
              <span className="queue-pulse" />
              上一条还在处理，你的消息已排队…
            </p>
          )}
          <ApprovalCards api={api} conversationId={conversation.id} approvals={snapshot.approvals} />
          <div className="chat-input-row">
            {/* 单聊时传的是常量而不是每次新建的 []：memo 靠 props 身份判断，
                一个每帧换身份的空数组等于让它永远重渲染。 */}
            <ChatInput
              members={conversation.kind === 'group' ? members : NO_MEMBERS}
              commands={commands ?? NO_COMMANDS}
              onSend={send}
              onUpload={uploadAttachment}
              streaming={streamingActive}
              draft={draft}
              onDraftChange={onDraftChange}
              focusToken={focusToken}
              onStop={stopTurn}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function maxTurn(messages: { turnIndex: number }[]): number {
  return messages.reduce((max, m) => {
    return Math.max(max, m.turnIndex)
  }, -1)
}

/** 从审批卡的原始 JSON 参数里取命令原文；非法 JSON 原样展示（用户看到的=模型给出的）。 */
function approvalCommandOf(args: string): string {
  try {
    const parsed = JSON.parse(args) as { command?: unknown }
    if (typeof parsed.command === 'string' && parsed.command.length > 0) return parsed.command
  } catch {
    // 非法 JSON：下面原样返回。
  }
  return args
}

/**
 * 工具执行审批卡（shell_exec 等价命令在执行前等用户点头）。
 *
 * 卡片的去留由 WS 的 approval-resolved 驱动（超时/取消/别处窗口已决议都会撤卡），
 * 点击只负责把决议送上去——404 说明卡已经不在了，等价于「迟到的点击」，无需提示。
 */
function ApprovalCards({
  api,
  conversationId,
  approvals,
}: {
  api: ApiClient
  conversationId: string
  approvals: readonly PendingApproval[]
}) {
  const [remember, setRemember] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  if (approvals.length === 0) return null
  const decide = (approval: PendingApproval, decision: 'allow' | 'deny'): void => {
    setBusyId(approval.approvalId)
    api.decideApproval(conversationId, approval.approvalId, decision, remember).catch(() => {
      // 网络失败才恢复按钮；404 已在 request 层面算成功路径之外，卡由 WS 事件撤。
      setBusyId(undefined)
    })
  }
  return (
    <section className="approval-stack" aria-label="工具执行审批">
      {approvals.map((approval) => {
        return (
          <div key={approval.approvalId} className="approval-card">
            <p className="approval-title">
              <Icon name="alert" size={16} /> {approval.toolName} 想执行命令，等你点头：
            </p>
            <pre className="approval-command">{approvalCommandOf(approval.args)}</pre>
            <div className="approval-actions">
              <label className="approval-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => {
                    setRemember(event.target.checked)
                  }}
                />
                记住这条命令（本次运行内不再问）
              </label>
              <span className="approval-buttons">
                <button
                  type="button"
                  className="approval-deny"
                  disabled={busyId !== undefined}
                  onClick={() => {
                    decide(approval, 'deny')
                  }}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="approval-allow"
                  disabled={busyId !== undefined}
                  onClick={() => {
                    decide(approval, 'allow')
                  }}
                >
                  允许
                </button>
              </span>
            </div>
          </div>
        )
      })}
    </section>
  )
}

/** 下一个 turn 序号（传入历史 + 流式快照的合并列表，与服务端口径一致）。 */
export function nextTurnIndex(messages: { turnIndex: number }[]): number {
  return maxTurn(messages) + 1
}
