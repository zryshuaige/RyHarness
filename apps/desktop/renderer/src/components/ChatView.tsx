import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, ApiClient, Conversation, MessageRow } from '../api.ts'
import { messageText } from '../api.ts'
import type { ChatStore } from '../store.ts'
import { useChat } from '../store.ts'
import { AgentAvatar, Cat } from './Cat.tsx'
import { ChatInput } from './ChatInput.tsx'
import { MessageBubble, RelayChain } from './MessageBubble.tsx'

function formatTime(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 历史消息行 → UiMessage 形状。 */
function fromHistory(rows: MessageRow[], nameOf: (id: string) => string) {
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
      done: true,
      parts: isTool
        ? [{ kind: 'tool' as const, callId: row.toolCallId ?? row.id, name: text.split(':')[0] ?? 'tool', arguments: '', status: 'done' as const }]
        : [{ kind: 'text' as const, text }],
    }
  })
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
  /** 标记已读后回调（刷新左栏未读徽标）。 */
  onRead?: () => void
}) {
  const snapshot = useChat(store)
  const [history, setHistory] = useState<ReturnType<typeof fromHistory>>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [catMood, setCatMood] = useState<'idle' | 'thinking' | 'happy'>('idle')

  const nameOf = (id: string): string => {
    return agents.find((a) => { return a.id === id })?.name ?? id
  }

  // 载入历史 + 订阅 WS。
  useEffect(() => {
    let cancelled = false
    store.reset()
    setHistoryLoaded(false)
    api.messages(conversation.id, 50).then(({ messages }) => {
      if (cancelled) return
      setHistory(fromHistory(messages, nameOf))
      setHistoryLoaded(true)
    }).catch(() => {
      if (!cancelled) setHistoryLoaded(true)
    })
    const unsubscribe = api.subscribe(conversation.id, (event) => { store.apply(event) })
    // 打开会话即标记已读。
    api.markRead(conversation.id).then(() => { onRead?.() }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // 滚动到底。
  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [snapshot.messages.length, history.length])

  // Ryen 状态：有 agent 正在生成 → thinking；刚完成 → happy 1.6s 回 idle。
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
    try {
      await api.postMessage(conversation.id, text)
    } catch (error) {
      store.apply({ type: 'error', conversationId: conversation.id, message: error instanceof Error ? error.message : String(error), code: 'HTTP' })
    }
  }

  const allMessages = [...history, ...snapshot.messages]
  const typingAgents = Object.keys(snapshot.typing).filter((id) => { return id !== 'user' })

  // 按 turn 分组渲染：每个 turn 前渲染一次接力链。
  const turns = useMemo(() => {
    const groups: { turnIndex: number; messages: typeof allMessages }[] = []
    for (const message of allMessages) {
      const last = groups[groups.length - 1]
      if (last === undefined || last.turnIndex !== message.turnIndex) {
        groups.push({ turnIndex: message.turnIndex, messages: [message] })
      } else {
        last.messages.push(message)
      }
    }
    return groups
  }, [allMessages])

  return (
    <section className="chat-view">
      <header className="chat-header">
        <Cat mood={catMood} size={34} />
        <div>
          <strong>{conversation.title || nameOf(conversation.memberAgentIds[0] ?? '')}</strong>
          <small>{conversation.kind === 'group' ? `群聊 · ${members.length} 位成员` : '单聊'}</small>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {!historyLoaded && <p className="chat-hint">载入历史中…</p>}
        {turns.map((turn) => (
          <div key={turn.turnIndex} className="turn-block">
            <RelayChain relays={snapshot.relays} turnIndex={turn.turnIndex} nameOf={nameOf} />
            {turn.messages.map((message) => (
              <MessageBubble key={message.key} message={message} fileUrl={(name) => { return api.fileUrl(name) }} />
            ))}
          </div>
        ))}
        {snapshot.error !== undefined && (
          <p className="error-banner">⚠️ [{snapshot.error.code}] {snapshot.error.message}</p>
        )}
        {typingAgents.length > 0 && (
          <p className="typing-indicator">
            {typingAgents.map(nameOf).join('、')} 正在输入…
          </p>
        )}
      </div>

      <ChatInput
        members={conversation.kind === 'group' ? members : []}
        onSend={(text) => { void send(text) }}
        disabled={snapshot.queueing}
        hint={snapshot.queueing ? '上一条还在处理，已排队…' : undefined}
      />
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
