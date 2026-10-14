import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, MessageRow } from '../api.ts'
import { messageText } from '../api.ts'
import { toast } from '../lib/toast.ts'
import { LEAVE_MS, useLeaving } from '../lib/useLeaving.ts'
import type { ChatStore, UiMessage } from '../store.ts'
import { useChat } from '../store.ts'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { Icon } from './Icon.tsx'
import { MessageBubble, RelayChain } from './MessageBubble.tsx'
import { ToastHost } from './ToastHost.tsx'
import { TypingDots } from './TypingDots.tsx'

function formatTime(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

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

/** 距底阈值：超过则停止自动跟随（报告 §5 的 100px 规则）。 */
const FOLLOW_THRESHOLD = 100

/** 每页历史消息数（向上翻页）。 */
const PAGE_SIZE = 50

/** 渲染上限：超长会话只渲染最近若干条，「加载更早」时同步放宽。 */
const RENDER_CAP = 150

/** 程序化滚动到底；smooth 仅用于「跳至最新」，流式跟随必须即时。 */
function scrollToBottom(node: HTMLDivElement, smooth: boolean): void {
  if (smooth && typeof node.scrollTo === 'function') {
    try {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
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
}: {
  api: ApiClient
  conversation: Conversation
  agents: AgentDef[]
  store: ChatStore
  onRead?: () => void
}) {
  const snapshot = useChat(store)
  const [history, setHistory] = useState<UiMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [renderCap, setRenderCap] = useState(RENDER_CAP)
  const [showJump, setShowJump] = useState(false)
  const [conn, setConn] = useState<'open' | 'reconnecting'>('open')
  const [connDismissed, setConnDismissed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const restoreScroll = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  const [catMood, setCatMood] = useState<'idle' | 'thinking' | 'happy'>('idle')
  /**
   * 用户中止过当前这轮。store 只在 message-done 里清 typing，而中止路径不再有
   * message-done，所以"生成中"的收尾只能在 UI 侧做：点停止即刻复位，ABORTED 事件
   * 到达时兜底确认，新一轮开始时清掉。
   */
  const [stopped, setStopped] = useState(false)

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

  /** 断线缺口/重连后重拉最新一页历史 + 调度事件，重置流式状态。 */
  const reloadLatest = useCallback((): void => {
    store.reset()
    setRenderCap(RENDER_CAP)
    stickToBottom.current = true
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
  }, [api, conversation.id, nameOf, store])
  const reloadRef = useRef(reloadLatest)
  reloadRef.current = reloadLatest

  // 载入历史 + 订阅 WS + 标记已读。
  useEffect(() => {
    let cancelled = false
    store.reset()
    setHistoryLoaded(false)
    setHasMore(false)
    setRenderCap(RENDER_CAP)
    setConn('open')
    setConnDismissed(false)
    setStopped(false)
    stickToBottom.current = true
    api
      .messages(conversation.id, { limit: PAGE_SIZE })
      .then(({ messages }) => {
        if (cancelled) return
        setHistory(fromHistory(messages, nameOf))
        setHasMore(messages.length === PAGE_SIZE)
        setHistoryLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setHistoryLoaded(true)
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
      setRenderCap((cap) => {
        return cap + PAGE_SIZE
      })
    } catch {
      // 加载失败保持现状，用户可重试。
    } finally {
      setLoadingEarlier(false)
    }
  }

  // 滚动：翻页前插后还原视口；否则仅当视口距底 < 100px 时即时跟随（报告 §5）。
  // 依赖 snapshot.messages 的身份（store 每次通知都重建数组），流式追加也触发。
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const restore = restoreScroll.current
    restoreScroll.current = null
    if (restore !== null) {
      node.scrollTop = node.scrollHeight - restore.prevHeight + restore.prevTop
      return
    }
    if (stickToBottom.current) scrollToBottom(node, false)
    setShowJump(!stickToBottom.current)
  }, [snapshot.messages, history, snapshot.typing])

  const handleScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottom.current = distance < FOLLOW_THRESHOLD
    setShowJump(distance >= FOLLOW_THRESHOLD)
    // 触顶自动翻页：向上回看历史时不该反复点按钮，也让"窗口"随浏览自然长大。
    if (node.scrollTop < 160 && hasMore && !loadingEarlier) {
      void loadEarlier()
    }
  }

  const jumpToLatest = (): void => {
    const node = scrollRef.current
    if (node === null) return
    stickToBottom.current = true
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

  const send = async (text: string): Promise<void> => {
    // turnIndex 基于全量消息（历史 + 流式快照），与服务端口径一致。
    store.addUserMessage(text, nextTurnIndex([...history, ...snapshot.messages]))
    stickToBottom.current = true
    setStopped(false)
    try {
      await api.postMessage(conversation.id, text)
    } catch (error) {
      store.apply({
        type: 'error',
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error),
        code: 'HTTP',
      })
    }
  }

  // 中止后 store 里的流式消息永远停在 done=false（没有 message-done），光标会一直闪。
  // 冻结成"已完结"再渲染：只在中止那一次分配数组，正常的流式路径零开销。
  const streamed = stopped
    ? snapshot.messages.map((message) => {
        return message.done ? message : { ...message, done: true }
      })
    : snapshot.messages
  const allMessages = [...history, ...streamed]
  // 渲染上限随「加载更早」同步放宽（renderCap 初始 RENDER_CAP，每次翻页 +PAGE_SIZE）。
  const visibleMessages = allMessages.length > renderCap ? allMessages.slice(-renderCap) : allMessages
  const allMessagesRef = useRef<UiMessage[]>([])
  allMessagesRef.current = allMessages

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

  // 按 turn 分组；turn 间插时间分隔；同 sender 相邻收紧。
  const turns = useMemo(() => {
    const groups: { turnIndex: number; time: number | undefined; messages: UiMessage[] }[] = []
    for (const message of visibleMessages) {
      const last = groups[groups.length - 1]
      if (last === undefined || last.turnIndex !== message.turnIndex) {
        groups.push({ turnIndex: message.turnIndex, time: message.createdAt, messages: [message] })
      } else {
        last.messages.push(message)
      }
    }
    return groups
  }, [visibleMessages])

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

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} style={{ position: 'relative' }}>
        <div className="chat-col">
          {!historyLoaded && <p className="chat-hint">载入历史中…</p>}
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
          {allMessages.length > renderCap && (
            <button
              type="button"
              className="chat-hint chat-hint-btn"
              onClick={() => {
                // 展开窗口而不是丢弃消息：用户点了就等于"这些我要看"。
                setRenderCap((cap) => {
                  return cap + PAGE_SIZE * 2
                })
              }}
            >
              ↑ 还有 {allMessages.length - renderCap} 条更早的消息，点此展开
            </button>
          )}
          {turns.map((turn) => (
            <div key={turn.turnIndex} className="turn-block">
              {turn.time !== undefined && <div className="turn-time">{formatTime(turn.time)}</div>}
              <RelayChain relays={snapshot.relays} turnIndex={turn.turnIndex} nameOf={nameOf} avatarOf={avatarOf} />
              {turn.messages.map((message, index) => (
                <MessageBubble
                  key={message.key}
                  message={message}
                  fileUrl={fileUrl}
                  agent={agentById(message.senderId)}
                  tight={index > 0 && turn.messages[index - 1]?.senderId === message.senderId}
                  firstOfGroup={index === 0 || turn.messages[index - 1]?.senderId !== message.senderId}
                  // 历史消息一次性 150 条同时淡入像掉帧，只有本次会话新到的才播进场。
                  animated={!message.key.startsWith('hist:')}
                  onFeedback={onFeedback}
                />
              ))}
            </div>
          ))}
          {errorBanner.shown !== undefined && (
            <p ref={errorBanner.ref} className={errorBanner.leaving ? 'error-banner is-leaving' : 'error-banner'}>
              <Icon name="alert" size={14} /> [{errorBanner.shown.code}] {errorBanner.shown.message}
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
          {snapshot.queueing && (
            <p className="queue-hint">
              <span className="queue-pulse" />
              上一条还在处理，你的消息已排队…
            </p>
          )}
          <div className="chat-input-row">
            <ChatInput
              members={conversation.kind === 'group' ? members : []}
              onSend={(text) => {
                void send(text)
              }}
              disabled={snapshot.queueing}
              streaming={!stopped && Object.keys(snapshot.typing).length > 0}
              onStop={() => {
                // 先复位再发请求：中止确认要等服务端回 ABORTED 才到，那之前界面不能
                // 还停在"生成中"——这正是此前"点了停止像卡死"的观感来源。
                setStopped(true)
                void api.cancelTurn(conversation.id).catch(() => {
                  // 停止失败不该打扰用户：服务端本来就会在 turn 结束时清理。
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

export { formatTime }
