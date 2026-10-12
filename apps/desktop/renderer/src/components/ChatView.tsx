import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, MessageRow } from '../api.ts'
import { messageText } from '../api.ts'
import type { ChatStore, UiMessage } from '../store.ts'
import { useChat } from '../store.ts'
import { Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { MessageBubble, RelayChain } from './MessageBubble.tsx'
import { TypingDots } from './TypingDots.tsx'

function formatTime(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 历史消息行 → UiMessage 形状。 */
function fromHistory(rows: MessageRow[], nameOf: (id: string) => string): UiMessage[] {
  return rows.map((row) => {
    const toolPrefix = '〔tool〕'
    const raw = messageText(row)
    const isTool = row.toolCallId !== undefined || raw.startsWith(toolPrefix)
    const text = isTool && raw.startsWith(toolPrefix) ? raw.slice(toolPrefix.length) : raw
    return {
      key: `hist:${row.id}`,
      senderType: row.senderType,
      senderId: row.senderId ?? (row.senderType === 'user' ? 'user' : 'system'),
      senderName: row.senderType === 'user' ? '我' : nameOf(row.senderId ?? ''),
      turnIndex: row.turnIndex,
      createdAt: row.createdAt,
      done: true,
      parts: isTool
        ? [{ kind: 'tool' as const, callId: row.toolCallId ?? row.id, name: text.split(':')[0] ?? 'tool', arguments: '', status: 'done' as const }]
        : [{ kind: 'text' as const, text }],
    }
  })
}

/** 距底阈值：超过则停止自动跟随（报告 §5 的 100px 规则）。 */
const FOLLOW_THRESHOLD = 100

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
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [catMood, setCatMood] = useState<'idle' | 'thinking' | 'happy'>('idle')

  const nameOf = (id: string): string => {
    return agents.find((a) => { return a.id === id })?.name ?? id
  }
  const agentById = (id: string): AgentDef | undefined => {
    return agents.find((a) => { return a.id === id })
  }

  // 载入历史 + 订阅 WS + 标记已读。
  useEffect(() => {
    let cancelled = false
    store.reset()
    setHistoryLoaded(false)
    stickToBottom.current = true
    api.messages(conversation.id, 50).then(({ messages }) => {
      if (cancelled) return
      setHistory(fromHistory(messages, nameOf))
      setHistoryLoaded(true)
    }).catch(() => {
      if (!cancelled) setHistoryLoaded(true)
    })
    api.markRead(conversation.id).then(() => { onRead?.() }).catch(() => {})
    api.listDispatchEvents(conversation.id).then(({ events }) => {
      if (!cancelled) store.setDispatchHistory(events)
    }).catch(() => {})
    const unsubscribe = api.subscribe(conversation.id, (event) => { store.apply(event) })
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // 自动跟随滚动：仅当视口距底 < 100px（报告 §5）。
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    if (stickToBottom.current) node.scrollTop = node.scrollHeight
    setShowJump(!stickToBottom.current)
  }, [snapshot.messages.length, history.length, snapshot.typing])

  const handleScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottom.current = distance < FOLLOW_THRESHOLD
    setShowJump(distance >= FOLLOW_THRESHOLD)
  }

  const jumpToLatest = (): void => {
    const node = scrollRef.current
    if (node === null) return
    stickToBottom.current = true
    node.scrollTop = node.scrollHeight
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
    const timer = setTimeout(() => { setCatMood('idle') }, 1600)
    return () => { clearTimeout(timer) }
  }, [typingCount])

  const members = useMemo(() => {
    return conversation.memberAgentIds
      .map((id) => { return agents.find((a) => { return a.id === id }) })
      .filter((a): a is AgentDef => { return a !== undefined })
  }, [conversation.memberAgentIds, agents])

  const send = async (text: string): Promise<void> => {
    store.addUserMessage(text, nextTurnIndex(snapshot.messages))
    stickToBottom.current = true
    try {
      await api.postMessage(conversation.id, text)
    } catch (error) {
      store.apply({ type: 'error', conversationId: conversation.id, message: error instanceof Error ? error.message : String(error), code: 'HTTP' })
    }
  }

  const allMessages = [...history, ...snapshot.messages]

  // 按 turn 分组；turn 间插时间分隔；同 sender 相邻收紧。
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

  const typingAgents = Object.keys(snapshot.typing).filter((id) => { return id !== 'user' })

  return (
    <section className="chat-view">
      <header className="chat-header">
        <Cat mood={catMood} size={34} />
        <div className="chat-header-info">
          <strong>{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</strong>
          <small>{conversation.kind === 'group' ? `群聊 · ${members.length} 位成员` : '单聊'}</small>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll} style={{ position: 'relative' }}>
        <div className="chat-col">
          {!historyLoaded && <p className="chat-hint">载入历史中…</p>}
          {turns.map((turn) => (
            <div key={turn.turnIndex} className="turn-block">
              {turn.time !== undefined && <div className="turn-time">{formatTime(turn.time)}</div>}
              <RelayChain
                relays={snapshot.relays}
                turnIndex={turn.turnIndex}
                nameOf={nameOf}
                avatarOf={(id) => {
                  const agent = agentById(id)
                  return { avatarKey: agent?.avatar, name: agent?.name ?? id }
                }}
              />
              {turn.messages.map((message, index) => (
                <MessageBubble
                  key={message.key}
                  message={message}
                  fileUrl={(name) => { return api.fileUrl(name) }}
                  agent={agentById(message.senderId)}
                  tight={index > 0 && turn.messages[index - 1]?.senderId === message.senderId}
                  firstOfGroup={index === 0 || turn.messages[index - 1]?.senderId !== message.senderId}
                />
              ))}
            </div>
          ))}
          {snapshot.error !== undefined && (
            <p className="error-banner">⚠️ [{snapshot.error.code}] {snapshot.error.message}</p>
          )}
          {typingAgents.length > 0 && (
            <p className="typing-indicator">
              {typingAgents.map(nameOf).join('、')}
              <TypingDots />
            </p>
          )}
          {historyLoaded && allMessages.length === 0 && (
            <div className="empty-state">
              <span className="empty-cat"><Cat mood="idle" size={88} /></span>
              <h3>新的对话，从一句话开始</h3>
              <p>我是 {nameOf(conversation.memberAgentIds[0] ?? '')}，有事尽管吩咐——写东西、跑命令、整理文件都行。</p>
            </div>
          )}
        </div>
        {showJump && (
          <button className="jump-latest" onClick={jumpToLatest}>↓ 跳至最新</button>
        )}
      </div>

      <div className="chat-input-wrap">
        <div className="chat-input-col">
          {snapshot.queueing && (
            <p className="queue-hint"><span className="queue-pulse" />上一条还在处理，你的消息已排队…</p>
          )}
          <div className="chat-input-row">
            <ChatInput
              members={conversation.kind === 'group' ? members : []}
              onSend={(text) => { void send(text) }}
              disabled={snapshot.queueing}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function maxTurn(messages: { turnIndex: number }[]): number {
  return messages.reduce((max, m) => { return Math.max(max, m.turnIndex) }, -1)
}

function nextTurnIndex(messages: { turnIndex: number }[]): number {
  return maxTurn(messages) + 1
}

export { formatTime }
