import { useState } from 'react'
import type { MessagePart, UiMessage } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import type { AgentDef } from '../api.ts'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 单个消息部件的渲染。 */
export function MessagePartView({ part, fileUrl }: { part: MessagePart; fileUrl: (name: string) => string }) {
  if (part.kind === 'text') {
    return <p className="bubble-text">{part.text}</p>
  }
  if (part.kind === 'tool') {
    return (
      <p className={`tool-row ${part.status === 'running' ? 'is-running' : ''} ${part.isError === true ? 'is-error' : ''}`}>
        <span className="tool-dot">{part.status === 'running' ? '⏳' : part.isError === true ? '⚠️' : '✓'}</span>
        {part.status === 'running' ? `正在使用工具：${part.name}…` : `工具 ${part.name} ${part.isError === true ? '失败' : '完成'}`}
      </p>
    )
  }
  return (
    <div className="file-card">
      <span className="file-icon">📄</span>
      <span className="file-meta">
        <strong>{part.name}</strong>
        <small>{formatSize(part.size)} · {part.mime}</small>
      </span>
      <a className="file-open" href={fileUrl(part.name)} target="_blank" rel="noreferrer">打开</a>
    </div>
  )
}

function messagePlainText(message: UiMessage): string {
  return message.parts
    .filter((part) => { return part.kind === 'text' })
    .map((part) => { return part.kind === 'text' ? part.text : '' })
    .join('\n')
}

/** 聊天气泡：用户居右（琥珀渐变、右下直角），agent 居左（白底、左下直角）；
 *  带头像列、hover 浮现复制操作、流式光标。 */
export function MessageBubble({
  message,
  fileUrl,
  agent,
  tight = false,
  firstOfGroup = true,
}: {
  message: UiMessage
  fileUrl: (name: string) => string
  /** 对应 agent（拿头像）；用户消息为 undefined。 */
  agent?: AgentDef
  /** 与同 sender 上一条相邻（收紧间距）。 */
  tight?: boolean
  /** 同 sender 组首条（显示头像与名字）。 */
  firstOfGroup?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const isUser = message.senderType === 'user'

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(messagePlainText(message))
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    } catch {
      // 剪贴板不可用时静默。
    }
  }

  const rowClass = [
    'bubble-row',
    isUser ? 'from-user' : 'from-agent',
    tight ? 'tight' : '',
    firstOfGroup ? 'first-of-group' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rowClass} data-sender={message.senderId}>
      {!isUser && (
        <span style={{ width: 40, flexShrink: 0, paddingTop: 2 }}>
          {firstOfGroup && agent !== undefined
            ? <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={40} />
            : null}
        </span>
      )}
      <div className="bubble">
        {!isUser && firstOfGroup && <div className="bubble-name">{message.senderName}</div>}
        <div className="bubble-bubble">
          {message.parts.map((part, index) => (
            <MessagePartView key={`${part.kind}-${index}`} part={part} fileUrl={fileUrl} />
          ))}
          {message.senderType === 'agent' && !message.done && <span className="bubble-cursor">▍</span>}
        </div>
        <span className="bubble-actions">
          <button
            className="bubble-action"
            title="复制"
            onClick={() => { void copy() }}
          >
            {copied ? '✓' : '⧉'}
          </button>
        </span>
      </div>
    </div>
  )
}

/** 群聊接力链：一条 dispatch 记录渲染为流转提示。 */
export function RelayChain({
  relays,
  turnIndex,
  nameOf,
}: {
  relays: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[]
  turnIndex: number
  nameOf: (id: string) => string
}) {
  const items = relays.filter((relay) => { return relay.turnIndex === turnIndex })
  if (items.length === 0) return null
  const label = (reason: string): string => {
    if (reason === 'user-mention') return '点名'
    if (reason === 'default-dispatcher') return '调度'
    if (reason === 'loop-guard') return '循环保护'
    if (reason === 'max-turns') return '达到轮次上限'
    if (reason.startsWith('relay @')) return '转交'
    return reason
  }
  return (
    <div className="relay-chain" aria-label="调度轨迹">
      {items.map((relay, index) => (
        <span key={index} className={`relay-item ${relay.reason === 'loop-guard' || relay.reason === 'max-turns' ? 'is-guard' : ''}`}>
          <span className="relay-dot" />
          {relay.fromAgent !== undefined && <>{nameOf(relay.fromAgent)} → </>}
          @{nameOf(relay.toAgent)} · {label(relay.reason)}
        </span>
      ))}
    </div>
  )
}
