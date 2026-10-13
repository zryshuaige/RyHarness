import { memo, useState } from 'react'
import type { AgentDef } from '../api.ts'
import type { MessagePart, UiMessage } from '../store.ts'
import { Avatar } from './avatars/Avatar.tsx'
import { Icon } from './Icon.tsx'
import { Markdown } from './Markdown.tsx'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 单个消息部件的渲染。markdown=true 时文本按 Markdown 渲染（消息完成后）。 */
export function MessagePartView({
  part,
  fileUrl,
  markdown = false,
}: {
  part: MessagePart
  fileUrl: (name: string) => string
  markdown?: boolean
}) {
  if (part.kind === 'text') {
    // 流式期间纯文本直出（token 高频追加，不重复解析）；完成后渲染 Markdown。
    if (markdown)
      return (
        <div className="bubble-text bubble-md">
          <Markdown text={part.text} />
        </div>
      )
    return <p className="bubble-text">{part.text}</p>
  }
  if (part.kind === 'tool') {
    return (
      <p
        className={`tool-row ${part.status === 'running' ? 'is-running' : ''} ${part.isError === true ? 'is-error' : ''}`}
      >
        <span className={`tool-dot ${part.status === 'running' ? 'is-running' : ''}`}>
          {part.status === 'running' ? '' : <Icon name={part.isError === true ? 'alert' : 'check'} size={13} />}
        </span>
        {part.status === 'running'
          ? `正在使用工具：${part.name}…`
          : `工具 ${part.name} ${part.isError === true ? '失败' : '完成'}`}
      </p>
    )
  }
  return (
    <div className="file-card">
      <span className="file-icon">
        <Icon name="file" size={22} />
      </span>
      <span className="file-meta">
        <strong>{part.name}</strong>
        <small>
          {formatSize(part.size)} · {part.mime}
        </small>
      </span>
      <a className="file-open" href={fileUrl(part.name)} target="_blank" rel="noreferrer">
        打开
      </a>
    </div>
  )
}

function messagePlainText(message: UiMessage): string {
  return message.parts
    .filter((part) => {
      return part.kind === 'text'
    })
    .map((part) => {
      return part.kind === 'text' ? part.text : ''
    })
    .join('\n')
}

/** 聊天气泡：用户居右（琥珀渐变、右下直角），agent 居左（白底、左下直角）；
 *  带头像列、hover 浮现复制操作、流式光标。 */
function MessageBubbleInner({
  message,
  fileUrl,
  agent,
  tight = false,
  firstOfGroup = true,
  onFeedback,
}: {
  message: UiMessage
  fileUrl: (name: string) => string
  /** 对应 agent（拿头像）；用户消息为 undefined。 */
  agent?: AgentDef
  /** 与同 sender 上一条相邻（收紧间距）。 */
  tight?: boolean
  /** 同 sender 组首条（显示头像与名字）。 */
  firstOfGroup?: boolean
  /** 👍/👎 反馈（仅 agent 消息）。 */
  onFeedback?: (message: UiMessage, signal: 'thumb_up' | 'thumb_down') => void
}) {
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<'thumb_up' | 'thumb_down' | undefined>(undefined)
  const isUser = message.senderType === 'user'

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(messagePlainText(message))
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 1200)
    } catch {
      // 剪贴板不可用时静默。
    }
  }

  const rowClass = [
    'bubble-row',
    isUser ? 'from-user' : 'from-agent',
    tight ? 'tight' : '',
    firstOfGroup ? 'first-of-group' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rowClass} data-sender={message.senderId}>
      {!isUser && (
        <span style={{ width: 40, flexShrink: 0, paddingTop: 2 }}>
          {firstOfGroup && agent !== undefined ? (
            <Avatar avatarKey={agent.avatar} name={agent.name} seed={agent.id} size={40} />
          ) : null}
        </span>
      )}
      <div className="bubble">
        {!isUser && firstOfGroup && <div className="bubble-name">{message.senderName}</div>}
        <div className="bubble-bubble">
          {message.parts.map((part, index) => (
            <MessagePartView
              key={`${part.kind}-${index}`}
              part={part}
              fileUrl={fileUrl}
              markdown={message.done && message.senderType === 'agent'}
            />
          ))}
          {message.senderType === 'agent' && !message.done && <span className="bubble-cursor">▍</span>}
        </div>
        <span className="bubble-actions">
          <button
            type="button"
            className="bubble-action"
            title="复制"
            onClick={() => {
              void copy()
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
          {!isUser && onFeedback !== undefined && message.done && (
            <>
              <button
                type="button"
                className={`bubble-action ${feedback === 'thumb_up' ? 'is-active' : ''}`}
                title="有帮助"
                onClick={() => {
                  setFeedback('thumb_up')
                  onFeedback(message, 'thumb_up')
                }}
              >
                <Icon name="thumbs-up" size={14} />
              </button>
              <button
                type="button"
                className={`bubble-action ${feedback === 'thumb_down' ? 'is-active-neg' : ''}`}
                title="有问题（触发反思）"
                onClick={() => {
                  setFeedback('thumb_down')
                  onFeedback(message, 'thumb_down')
                }}
              >
                <Icon name="thumbs-down" size={14} />
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * memo 包装：流式期间 store 每次通知都会重建消息数组，自定义相等器按
 * （key, senderId, done, parts 序列化）比较——未变化的气泡跳过重渲染。
 */
export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return (
    prev.message.key === next.message.key &&
    prev.message.senderId === next.message.senderId &&
    prev.message.done === next.message.done &&
    prev.tight === next.tight &&
    prev.firstOfGroup === next.firstOfGroup &&
    JSON.stringify(prev.message.parts) === JSON.stringify(next.message.parts) &&
    prev.onFeedback === next.onFeedback &&
    prev.fileUrl === next.fileUrl
  )
})

/** 群聊接力链：头像 A → 箭头 → 头像 B 的流转提示，错峰滑入。 */
export function RelayChain({
  relays,
  turnIndex,
  nameOf,
  avatarOf,
}: {
  relays: { fromAgent?: string; toAgent: string; reason: string; turnIndex: number }[]
  turnIndex: number
  nameOf: (id: string) => string
  avatarOf: (id: string) => { avatarKey?: string; name: string }
}) {
  const items = relays.filter((relay) => {
    return relay.turnIndex === turnIndex
  })
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
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: 纯展示容器，aria-label 供读屏器命名
    <div className="relay-chain" aria-label="调度轨迹">
      {items.map((relay, index) => (
        <span
          key={`${relay.reason}-${index}`}
          className={`relay-flow ${relay.reason === 'loop-guard' || relay.reason === 'max-turns' ? 'is-guard' : ''}`}
          style={{ animationDelay: `${index * 90}ms` }}
        >
          {relay.fromAgent !== undefined && (
            <>
              <span className="relay-avatar">
                <Avatar
                  avatarKey={avatarOf(relay.fromAgent).avatarKey}
                  name={nameOf(relay.fromAgent)}
                  seed={relay.fromAgent}
                  size={20}
                />
              </span>
              <span className="relay-arrow" aria-hidden="true">
                <Icon name="chevron-right" size={11} />
              </span>
            </>
          )}
          <span className="relay-avatar">
            <Avatar
              avatarKey={avatarOf(relay.toAgent).avatarKey}
              name={nameOf(relay.toAgent)}
              seed={relay.toAgent}
              size={20}
            />
          </span>
          <span className="relay-label">{label(relay.reason)}</span>
        </span>
      ))}
    </div>
  )
}
