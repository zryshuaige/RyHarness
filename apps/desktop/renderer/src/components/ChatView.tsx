import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, MessageRow } from '../api.ts'
import { messageText } from '../api.ts'
import { formatTime } from '../lib/format.ts'
import { toast } from '../lib/toast.ts'
import { explainTurnError, type TurnErrorTarget } from '../lib/turn-errors.ts'
import { LEAVE_MS, prefersReducedMotion, useLeaving } from '../lib/useLeaving.ts'
import { DEFAULT_OVERSCAN, FALLBACK_VIEWPORT_ROWS, visibleRange, windowSlice } from '../lib/windowed.ts'
import type { ChatStore, MessageAttachment, UiMessage } from '../store.ts'
import { composeMessageText, isProactiveRow, useChat } from '../store.ts'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { Icon } from './Icon.tsx'
import { MessageBubble, RelayChain } from './MessageBubble.tsx'
import { PanelSkeleton } from './Skeleton.tsx'
import { ToastHost } from './ToastHost.tsx'
import { TypingDots } from './TypingDots.tsx'

/**
 * 历史消息行 → UiMessage 形状。
 * 纯 tool_call 的 assistant 消息（无文本块且无 toolCallId 结果行）没有可展示
 * 内容，直接跳过——否则渲染成空气泡。
 */
export function fromHistory(rows: MessageRow[], nameOf: (id: string) => string): UiMessage[] {
  const out: UiMessage[] = []
  for (const row of rows) {
    const toolPrefix = '〔tool〕'
    const raw = messageText(row)
    const isTool = row.toolCallId !== undefined || raw.startsWith(toolPrefix)
    if (!isTool && raw.trim().length === 0) continue
    const text = isTool && raw.startsWith(toolPrefix) ? raw.slice(toolPrefix.length) : raw
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
      parts: isTool
        ? [
            {
              kind: 'tool' as const,
              callId: row.toolCallId ?? row.id,
              name: text.split(':')[0] ?? 'tool',
              arguments: '',
              status: 'done' as const,
            },
          ]
        : [{ kind: 'text' as const, text }],
    })
  }
  return out
}

/**
 * 合并一段来自服务端的窗口（搜索命中的 around 窗口）到已加载历史。
 *
 * 纯函数：已存在（同 key）的不动——定位窗口往往与已加载的那一页重叠，重复插入
 * 会让同一条消息在流里出现两次。新的按 seq 归位，这样"往前翻历史"与"跳到某条
 * 命中"两条来路的消息仍然是一条按时间排好的流。
 */
export function mergeHistory(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  if (incoming.length === 0) return current
  const merged = new Map<string, UiMessage>(
    current.map((message) => {
      return [message.key, message]
    }),
  )
  let added = false
  for (const message of incoming) {
    if (merged.has(message.key)) continue
    merged.set(message.key, message)
    added = true
  }
  if (!added) return current
  return [...merged.values()].sort((a, b) => {
    return (a.seq ?? 0) - (b.seq ?? 0)
  })
}

/** 服务端消息 id（React key 的 `hist:` 前缀摘掉后就是它，见 MessageBubble）。 */
function serverMessageId(key: string): string {
  return key.startsWith('hist:') ? key.slice('hist:'.length) : key
}

/** 搜索命中定位时向服务端要的上下文字段数（GET /messages 的 around 游标）。 */
export const REVEAL_WINDOW = 25

/**
 * 取一条消息前后的窗口。
 *
 * 全文搜索能指到会话里任意一条历史消息，但聊天区只加载了最新一页——命中多半不在
 * 已加载的窗口内，此前点命中只能"什么都没发生"。这一段窗口就是那次跳转的上下文。
 *
 * 走 fetch 而不是 ApiClient.messages()：后者的游标只有 limit/before（两个都表达不了
 * "以某条为中心"），而那组游标语义稳定、不该为了一个跳转再加第三个。
 */
export async function fetchMessageWindow(
  api: ApiClient,
  conversationId: string,
  messageId: string,
  window: number = REVEAL_WINDOW,
): Promise<MessageRow[]> {
  const params = new URLSearchParams({ around: messageId, window: String(window) })
  const response = await fetch(`${api.base}/api/conversations/${conversationId}/messages?${params.toString()}`)
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

/** 每页历史消息数（向上翻页）。 */
const PAGE_SIZE = 50

/** 单条气泡的高度估算（px）：短文本一行 + 内边距。 */
const BUBBLE_ESTIMATE_PX = 76
/** 一个 turn（轮次块：时间分隔 + 至少一条气泡）的高度估算（px）。 */
const TURN_ESTIMATE_PX = 88
/**
 * 多少轮以上才启动窗口化：短会话一次性渲染完，滚动条长度、观感与此前完全一致，
 * 窗口化只对真正会长的流有意义。
 */
const WINDOW_MIN_TURNS = 30
/** 定位时把命中那一轮上方再留几轮余量，避免 scrollIntoView 顶在容器边缘。 */
const REVEAL_LEAD_TURNS = 2
/** 定位后补空洞最多翻几页（每页 PAGE_SIZE 条）。 */
const GAP_BRIDGE_PAGES = 3

/** 单个附件上限：走 JSON base64 进内存，超过 20MB 先在客户端挡住。 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

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
  store,
  onRead,
  onNavigate,
  pendingSend,
  onPendingSendDone,
}: {
  api: ApiClient
  conversation: Conversation
  agents: AgentDef[]
  store: ChatStore
  onRead?: () => void
  /**
   * 错误条上的可行动作要跳面板时走这里（见 lib/turn-errors.ts 的 TurnErrorTarget）。
   * 不传时动作退化成窗口事件 `ryagent:navigate`（detail 同 TurnErrorTarget），由
   * 壳里的导航接线接——聊天视图自己不持有 tab 状态。
   */
  onNavigate?: (target: TurnErrorTarget) => void
  /**
   * 待发送的首条消息（欢迎页：先把会话切过来、WS 订阅建好，再发出去）。
   * 见挂载 effect 里的发送时机——顺序反了这条消息就落在订阅之前。
   */
  pendingSend?: { conversationId: string; text: string }
  /** 待发消息已发出（App 清掉它，避免下次进会话重发一遍）。 */
  onPendingSendDone?: () => void
}) {
  const snapshot = useChat(store)
  const [history, setHistory] = useState<UiMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const [conn, setConn] = useState<'open' | 'reconnecting'>('open')
  const [connDismissed, setConnDismissed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const restoreScroll = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  /**
   * 视口位置（窗口化用）：跟 {@link stickToBottom} 同源，但要在渲染里读到，
   * 所以留一份 state——ref 改了不重渲染，窗口就停在旧区间。
   */
  const [atBottom, setAtBottom] = useState(true)
  const [viewTop, setViewTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(0)
  /** 待定位的搜索命中消息 id；拿到后滚过去并高亮（见定位 effect）。 */
  const [revealTarget, setRevealTarget] = useState<string | undefined>(undefined)
  const [catMood, setCatMood] = useState<'idle' | 'thinking' | 'happy'>('idle')
  /**
   * 用户中止过当前这轮。store 只在 message-done 里清 typing，而中止路径不再有
   * message-done，所以"生成中"的收尾只能在 UI 侧做：点停止即刻复位，ABORTED 事件
   * 到达时兜底确认，新一轮开始时清掉。
   */
  const [stopped, setStopped] = useState(false)

  /** 贴底状态的两个真源一起改：ref 供回调与 effect 读，state 供渲染读。 */
  const pinBottom = useCallback((value: boolean): void => {
    stickToBottom.current = value
    setAtBottom(value)
  }, [])

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
    return [...history, ...streamed]
  }, [history, streamed])
  const allMessagesRef = useRef<UiMessage[]>([])
  allMessagesRef.current = allMessages

  /** 按 turn 分组；turn 间插时间分隔；同 sender 相邻收紧。 */
  const turns = useMemo(() => {
    const groups: { turnIndex: number; time: number | undefined; messages: UiMessage[] }[] = []
    for (const message of allMessages) {
      const last = groups[groups.length - 1]
      if (last === undefined || last.turnIndex !== message.turnIndex) {
        groups.push({ turnIndex: message.turnIndex, time: message.createdAt, messages: [message] })
      } else {
        last.messages.push(message)
      }
    }
    return groups
  }, [allMessages])

  /**
   * 一个 turn 块的估算高度：按本会话实际的消息密度算（群聊一轮三五句、单聊常常
   * 一来一回两条），估偏了只是哨兵略有出入，滚动条仍连续——与 lib/windowed.ts 里
   * 那套"定高估算"的取舍一致。
   */
  const turnEstimate = useMemo(() => {
    const perTurn = turns.length === 0 ? 1 : allMessages.length / turns.length
    return Math.max(TURN_ESTIMATE_PX, Math.round(perTurn * BUBBLE_ESTIMATE_PX))
  }, [allMessages.length, turns.length])

  /** 只渲染可视区 + 上下哨兵（会话列表已是同一套能力，见 lib/windowed.ts）。 */
  const windowed = turns.length > WINDOW_MIN_TURNS
  const chatWindow = useMemo(() => {
    const viewportHeight = viewHeight > 0 ? viewHeight : turnEstimate * FALLBACK_VIEWPORT_ROWS
    const range = visibleRange({
      count: turns.length,
      estimateHeight: turnEstimate,
      /**
       * 贴底时无视 scrollTop（那一帧可能还停在旧值），窗口直接钉在末尾：新消息
       * 到达时窗口已经把它算进去了，否则"跟随底部"要等下一次滚动事件才补上。
       */
      scrollTop: windowed && atBottom ? Number.POSITIVE_INFINITY : viewTop,
      viewportHeight,
      overscan: DEFAULT_OVERSCAN,
    })
    return windowSlice(turns, windowed ? range : { start: 0, end: turns.length }, turnEstimate)
  }, [atBottom, turnEstimate, turns, viewHeight, viewTop, windowed])

  /** 断线缺口/重连后重拉最新一页历史 + 调度事件，重置流式状态。 */
  const reloadLatest = useCallback((): void => {
    store.reset()
    pinBottom(true)
    api
      .messages(conversation.id, { limit: PAGE_SIZE })
      .then(({ messages }) => {
        setHistory(fromHistory(messages, nameOf))
        setHasMore(messages.length === PAGE_SIZE)
      })
      .catch(() => {})
    api
      .listDispatchEvents(conversation.id)
      .then(({ events }) => {
        store.setDispatchHistory(events)
      })
      .catch(() => {})
  }, [api, conversation.id, nameOf, pinBottom, store])
  const reloadRef = useRef(reloadLatest)
  reloadRef.current = reloadLatest

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
          store.apply({
            type: 'error',
            conversationId: conversation.id,
            message: error instanceof Error ? error.message : String(error),
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
      setStopped(false)
      deliver(key, text, attachments)
    },
    [deliver, pinBottom, store],
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
      setStopped(false)
      deliver(message.key, text, attachments)
    },
    [deliver, payloadOf, pinBottom, store],
  )

  /** 错误条上的「重试这一轮」：优先重发没送达的那条，否则把最后一句话重发一遍。 */
  const retryLastTurn = useCallback((): void => {
    const failed = [...allMessagesRef.current].reverse().find((message) => {
      return message.senderType === 'user' && message.delivery === 'failed'
    })
    const lastUser =
      failed ??
      [...allMessagesRef.current].reverse().find((message) => {
        return message.senderType === 'user'
      })
    if (lastUser === undefined) {
      toast.info('还没有可以重发的消息')
      return
    }
    if (lastUser === failed) {
      retryMessage(lastUser)
      return
    }
    // 已送达的一轮失败在模型侧：把它原样再发一轮，是用户期待的"再试一次"。
    const { text, attachments } = payloadOf(lastUser)
    dispatch(text, nextTurnIndex(allMessagesRef.current), attachments)
  }, [dispatch, payloadOf, retryMessage])

  /**
   * 附件落库：字节 POST 给会话的文件端点，由它写进工作区产物目录，
   * 回执是与 file_produce 产物卡片同构的 {name,size,mime}。
   */
  const uploadAttachment = useCallback(
    async (file: File): Promise<MessageAttachment> => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`单个附件不能超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
      }
      const response = await fetch(`${api.base}/api/conversations/${conversation.id}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          mime: file.type,
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        }),
      })
      const body = (await response.json().catch(() => {
        return {}
      })) as Partial<MessageAttachment> & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
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

  // 载入历史 + 订阅 WS + 标记已读。
  useEffect(() => {
    let cancelled = false
    store.reset()
    setHistoryLoaded(false)
    setHasMore(false)
    setViewTop(0)
    setViewHeight(0)
    setRevealTarget(undefined)
    setConn('open')
    setConnDismissed(false)
    setStopped(false)
    pinBottom(true)
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
    api
      .messages(conversation.id, { limit: PAGE_SIZE })
      .then(({ messages }) => {
        if (cancelled) return
        const rows = fromHistory(messages, nameOf)
        setHistory(rows)
        setHasMore(messages.length === PAGE_SIZE)
        setHistoryLoaded(true)
        flushPending(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryLoaded(true)
          flushPending([])
        }
      })
    api
      .markRead(conversation.id)
      .then(() => {
        onRead?.()
      })
      .catch(() => {})
    api
      .listDispatchEvents(conversation.id)
      .then(({ events }) => {
        if (!cancelled) store.setDispatchHistory(events)
      })
      .catch(() => {})
    const unsubscribe = api.subscribe(
      conversation.id,
      (event) => {
        if (event.type === 'message-start' || event.type === 'queued') setStopped(false)
        if (event.type === 'error' && event.code === 'ABORTED') {
          // 取消不是故障：中止后服务端只补一条 ABORTED 错误、不再发 message-done，
          // 若照常交给 store，输入区会永远停在"生成中"、光标一直闪，而且红条
          // 会把用户的主动停止说成系统出错。这里就地收口：复位 + 提示"已停止"。
          store.clearError()
          setStopped(true)
          return
        }
        store.apply(event)
      },
      {
        onStatus: (status) => {
          if (cancelled) return
          setConn(status)
          if (status === 'open') setConnDismissed(false)
        },
        onGap: () => {
          if (!cancelled) reloadRef.current()
        },
      },
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // 向上翻页：取最早 seq 之前的一页前插，并保持视口位置不跳动。
  const loadEarlier = async (): Promise<void> => {
    const earliest = history[0]?.seq
    if (earliest === undefined || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const { messages } = await api.messages(conversation.id, { limit: PAGE_SIZE, before: earliest })
      const older = fromHistory(messages, nameOf)
      const node = scrollRef.current
      if (node !== null) restoreScroll.current = { prevHeight: node.scrollHeight, prevTop: node.scrollTop }
      setHasMore(messages.length === PAGE_SIZE)
      setHistory((prev) => {
        return [...older, ...prev]
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
        const { messages } = await api.messages(conversation.id, { limit: PAGE_SIZE, before: loadedFirst })
        if (messages.length === 0) return
        const rows = fromHistory(messages, nameOf)
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
          setHistory((prev) => {
            return mergeHistory(prev, incoming)
          })
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
    window.addEventListener('ryagent:scroll-to-message', onJump)
    return () => {
      window.removeEventListener('ryagent:scroll-to-message', onJump)
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
      setViewTop(Math.max(0, (index - REVEAL_LEAD_TURNS) * turnEstimate))
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
  }, [revealTarget, turns.length, turnEstimate, pinBottom])

  // 滚动：翻页前插后还原视口；否则仅当视口距底 < 100px 时即时跟随（报告 §5）。
  // 依赖 snapshot.messages 的身份（store 每次通知都重建数组），流式追加也触发。
  const syncRef = useRef({ scrollTop: 0, padTop: 0 })
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const restore = restoreScroll.current
    restoreScroll.current = null
    const synced = syncRef.current
    const movedByUser = node.scrollTop - synced.scrollTop
    if (restore !== null) {
      node.scrollTop = node.scrollHeight - restore.prevHeight + restore.prevTop
      syncRef.current = { scrollTop: node.scrollTop, padTop: chatWindow.padTop }
      return
    }
    if (stickToBottom.current) scrollToBottom(node, false)
    /**
     * 上哨兵变高（窗口上沿下移）时把 scrollTop 一起搬走，视口才停在原来那条消息上。
     * 只在"用户自己没滚过、也没有定位任务在跑"时搬：哨兵高度变了也可能只是他滚动
     * 导致的窗口重算，那时候再补一次位移就等于把他拽回原处。
     */ else if (movedByUser === 0 && revealTarget === undefined && chatWindow.padTop !== synced.padTop) {
      node.scrollTop += chatWindow.padTop - synced.padTop
    }
    syncRef.current = { scrollTop: node.scrollTop, padTop: chatWindow.padTop }
    setShowJump(!stickToBottom.current)
    // chatWindow 是本轮渲染的窗口切片；它变了才需要重新对齐。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.messages, history, snapshot.typing, chatWindow, revealTarget])

  const pendingFrame = useRef(0)
  const handleScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    pinBottom(distance < FOLLOW_THRESHOLD)
    setShowJump(distance >= FOLLOW_THRESHOLD)
    // 触顶自动翻页：向上回看历史时不该反复点按钮，也让"窗口"随浏览自然长大。
    if (node.scrollTop < 160 && hasMore && !loadingEarlier) {
      void loadEarlier()
    }
    // 视口位置按帧合并：连续滚动下每帧最多重算一次窗口，而不是每个 scroll 事件
    // 都让整条消息流重渲染（与 lib/windowed.ts 里 useVisibleWindow 的取舍一致）。
    if (pendingFrame.current !== 0) return
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = 0
      setViewTop(node.scrollTop)
      setViewHeight(node.clientHeight)
    })
  }
  useEffect(() => {
    return () => {
      if (pendingFrame.current !== 0) cancelAnimationFrame(pendingFrame.current)
    }
  }, [])

  const jumpToLatest = (): void => {
    const node = scrollRef.current
    if (node === null) return
    pinBottom(true)
    scrollToBottom(node, true)
    setShowJump(false)
  }

  // Ryen 状态：生成中 thinking，完成后 happy 回 idle。
  const typingCount = Object.keys(snapshot.typing).length
  useEffect(() => {
    if (typingCount > 0) {
      setCatMood('thinking')
      return
    }
    setCatMood('happy')
    const timer = setTimeout(() => {
      setCatMood('idle')
    }, 1600)
    return () => {
      clearTimeout(timer)
    }
  }, [typingCount])

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

  const send = (text: string, attachments?: MessageAttachment[]): void => {
    // turnIndex 基于全量消息（历史 + 流式快照），与服务端口径一致。
    dispatch(text, nextTurnIndex(allMessages), attachments ?? [])
  }

  /**
   * 「这一轮还在跑」的判据是「还有没写完的消息」，不是 typing 计数：首个
   * text-delta 到达后 store 会清掉 typing（「正在输入」不该和正在出字的气泡
   * 并存），但这一轮远没结束——停止按钮与秒表必须留着。
   */
  const streamingActive =
    !stopped && (Object.keys(snapshot.typing).length > 0 || streamed.some((message) => !message.done))

  // 稳定引用：MessageBubble 的 memo 依赖这两个 prop 的身份不变。
  const fileUrl = useCallback(
    (name: string): string => {
      return api.fileUrl(name)
    },
    [api],
  )
  const onFeedback = useCallback(
    (target: UiMessage, signal: 'thumb_up' | 'thumb_down'): void => {
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
      void api
        .sendFeedback({
          conversationId: conversation.id,
          agentId: target.senderId,
          signal,
          userText: userText.slice(0, 300),
          assistantText: textOf(target).slice(0, 300),
        })
        .then(() => {
          // 反馈是"自我进化"的入口，必须让用户看见它去了哪。
          const who = agentById(target.senderId)?.name ?? '它'
          toast.success(
            signal === 'thumb_up' ? `已记下这条经验，${who} 会在类似场景里用上` : `已告诉 ${who} 这次哪里不对，会调整`,
          )
        })
        .catch((error: unknown) => {
          toast.error(`反馈没送出去：${error instanceof Error ? error.message : String(error)}`)
        })
    },
    [api, conversation.id, agentById],
  )

  const typingAgents = Object.keys(snapshot.typing).filter((id) => {
    return id !== 'user'
  })

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
   * 宿主没接线时抛窗口事件 `ryagent:navigate`（detail 带同一个 target），壳里
   * 一个监听就能接上——不接也只是那一次点击没有去处，其余行为不变。
   */
  const runErrorAction = (target: TurnErrorTarget): void => {
    if (target === 'retry') {
      retryLastTurn()
      return
    }
    if (onNavigate === undefined) {
      window.dispatchEvent(new CustomEvent('ryagent:navigate', { detail: { target } }))
      return
    }
    onNavigate(target)
  }

  return (
    <section className="chat-view">
      <header className="chat-header">
        <Cat mood={catMood} size={34} />
        <div className="chat-header-info">
          <strong>{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</strong>
          <small>{conversation.kind === 'group' ? `群聊 · ${members.length} 位成员` : '单聊'}</small>
        </div>
      </header>

      {connBanner.shown !== undefined && (
        <p ref={connBanner.ref} className={connBanner.leaving ? 'conn-banner is-leaving' : 'conn-banner'} role="status">
          <Icon name="alert" size={14} /> 连接已断开，正在重连…
          <button
            type="button"
            className="conn-banner-close"
            aria-label="关闭提示"
            onClick={() => {
              setConnDismissed(true)
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </p>
      )}

      {/* 对话流是一份不断追加的日志：role="log" + polite + 只读 additions，
          新消息到达才播报，流式重排（同一节点内改字）不会反复念。 */}
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        style={{ position: 'relative' }}
      >
        <div className="chat-col">
          {!historyLoaded && <PanelSkeleton rows={4} />}
          {historyLoaded && hasMore && (
            <button
              type="button"
              className="load-earlier"
              disabled={loadingEarlier}
              onClick={() => {
                void loadEarlier()
              }}
            >
              {loadingEarlier ? '载入中…' : '↑ 加载更早消息'}
            </button>
          )}
          {/* 上哨兵：撑住被窗口截掉的上方内容，滚动条长度才不会随窗口抖动。 */}
          {chatWindow.padTop > 0 && <div style={{ height: chatWindow.padTop }} aria-hidden="true" />}
          {chatWindow.visible.map((turn) => (
            <div key={turn.turnIndex} className="turn-block">
              {turn.time !== undefined && <div className="turn-time">{formatTime(turn.time)}</div>}
              <RelayChain relays={snapshot.relays} turnIndex={turn.turnIndex} nameOf={nameOf} avatarOf={avatarOf} />
              {turn.messages.map((message, index) => (
                <Fragment key={message.key}>
                  {/* 主动消息的标识：这条是它自己开口说的，不是用户问出来的。
                      放在气泡上方而不是气泡里——气泡里再插一行字，气泡就不是它本来的样子了。 */}
                  {message.proactive === true && (
                    <p className="chat-hint" data-proactive="true">
                      <Icon name="sun" size={12} /> Ryen 主动找你
                    </p>
                  )}
                  <MessageBubble
                    message={message}
                    fileUrl={fileUrl}
                    agent={agentById(message.senderId)}
                    tight={index > 0 && turn.messages[index - 1]?.senderId === message.senderId}
                    firstOfGroup={index === 0 || turn.messages[index - 1]?.senderId !== message.senderId}
                    // 历史消息一次性几十条同时淡入像掉帧，只有本次会话新到的才播进场。
                    animated={!message.key.startsWith('hist:')}
                    onFeedback={onFeedback}
                  />
                  {/* 没送达的气泡自带失败态与重试入口：发失败的消息长得跟送达的一模
                      一样，用户只会以为 agent 还没开始答。 */}
                  {message.delivery === 'failed' && (
                    <p className="chat-hint">
                      <Icon name="alert" size={12} /> 发送失败，这条没送到
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
                </Fragment>
              ))}
            </div>
          ))}
          {/* 下哨兵：同上，撑住下方尚未渲染的部分。 */}
          {chatWindow.padBottom > 0 && <div style={{ height: chatWindow.padBottom }} aria-hidden="true" />}
          {explainedError !== undefined && (
            <p
              ref={errorBanner.ref}
              className={errorBanner.leaving ? 'error-banner is-leaving' : 'error-banner'}
              role="alert"
            >
              <Icon name="alert" size={14} />
              <strong>{explainedError.title}</strong> {explainedError.hint}
              {explainedError.detail !== undefined && `（${explainedError.detail}）`}
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
            </p>
          )}
          {typingLine.shown !== undefined && (
            <p ref={typingLine.ref} className={typingLine.leaving ? 'typing-indicator is-leaving' : 'typing-indicator'}>
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
              <Icon name="x" size={12} /> {stoppedHint.shown}
            </p>
          )}
          {historyLoaded && allMessages.length === 0 && (
            <div className="empty-state">
              <span className="empty-cat">
                <Cat mood="idle" size={88} />
              </span>
              <h3>新的对话，从一句话开始</h3>
              <p>我是 {nameOf(conversation.memberAgentIds[0] ?? '')}，有事尽管吩咐——写东西、跑命令、整理文件都行。</p>
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
            <Icon name="chevron-right" size={12} className="jump-icon" /> 跳至最新
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
          <div className="chat-input-row">
            <ChatInput
              members={conversation.kind === 'group' ? members : []}
              onSend={send}
              onUpload={uploadAttachment}
              streaming={streamingActive}
              onStop={() => {
                // 先复位再发请求：中止确认要等服务端回 ABORTED 才到，那之前界面不能
                // 还停在"生成中"——这正是此前"点了停止像卡死"的观感来源。
                setStopped(true)
                void api.cancelTurn(conversation.id).catch((error: unknown) => {
                  // 停不掉就如实回滚：这一轮还在跑，界面必须回到"生成中"，
                  // 否则用户以为已经停了、模型其实还在烧 token。静默吞掉就成了假死。
                  setStopped(false)
                  toast.error(`没能停止生成：${error instanceof Error ? error.message : String(error)}`)
                })
              }}
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

/** 下一个 turn 序号（传入历史 + 流式快照的合并列表，与服务端口径一致）。 */
export function nextTurnIndex(messages: { turnIndex: number }[]): number {
  return maxTurn(messages) + 1
}
